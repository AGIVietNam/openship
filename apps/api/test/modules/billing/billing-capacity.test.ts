import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  project: vi.fn(),
  active: vi.fn(),
  binding: vi.fn(),
  services: vi.fn(),
  inFlight: vi.fn(),
  workspace: vi.fn(),
  pool: vi.fn(),
  entitlement: vi.fn(),
  projects: vi.fn(),
  permission: vi.fn(),
  authorize: vi.fn(),
  trigger: vi.fn(),
  existing: vi.fn(),
  kickoff: vi.fn(),
}));
vi.mock("@repo/db", () => ({
  repos: {
    organization: { findById: async () => ({ oblienNamespace: "tenant-a" }) },
    project: { findByIdInOrganization: h.project },
    cloudDockerWorkspace: { find: h.binding },
    deployment: {
      findById: h.active,
      listInFlightByProject: h.inFlight,
      findCapacityAdjustment: h.existing,
    },
    service: {
      listByProject: h.services,
      listByDeployment: async () => [
        { serviceId: "api", imageRef: "sha256:retained" },
        { serviceId: "db", imageRef: "postgres:17" },
      ],
    },
  },
}));
vi.mock("@repo/platform/engine/lib/authorization", () => ({
  authorization: { authorize: h.authorize, checkPermissionOnResource: h.permission },
}));
vi.mock("@repo/platform/engine/lib/authorized-projects", () => ({
  listAuthorizedProjects: h.projects,
}));
vi.mock("@repo/platform/engine/lib/oblien-client", () => ({
  getOblienClient: () => ({ workspaces: { get: h.workspace } }),
}));
vi.mock("@repo/platform/engine/lib/cloud-resource-limits", () => ({
  readCloudCapacityPool: h.pool,
}));
vi.mock("@repo/platform/engine/lib/project-runtime-lock", () => ({
  withProjectRuntimeLock: async (_id: string, run: () => Promise<unknown>) => run(),
}));
vi.mock("@repo/platform/engine/modules/billing/billing-oblien-quota", () => ({
  syncOblienEntitlement: h.entitlement,
}));
vi.mock("@repo/platform/engine/modules/deployments/build.service", () => ({
  triggerDeployment: h.trigger,
}));
vi.mock("@repo/platform/engine/modules/deployments/build-pipeline", () => ({
  kickoffBuild: h.kickoff,
}));
import { AppError, planLimits, resolvePlan } from "@repo/core";
import type { ExecutionContext } from "@repo/platform";
import {
  getCapacity,
  previewCapacity,
  applyCapacity,
} from "@repo/platform/engine/modules/billing/billing-capacity.service";

const ctx = {
  organizationId: "org-a",
  userId: "user-a",
  role: "owner",
  source: "api",
} as ExecutionContext;
const stamp = new Date("2026-09-30T10:00:00Z");
const resources = { cpuCores: 1, memoryMb: 1024, diskMb: 8192 };
const project = {
  id: "project",
  organizationId: "org-a",
  name: "App",
  activeDeploymentId: "active",
  updatedAt: stamp,
  cloudWorkspaceId: "workspace",
  resources,
};
const rows = ["api", "db"].map((id) => ({
  id,
  name: id,
  projectId: "project",
  kind: "compose",
  enabled: true,
  updatedAt: stamp,
  environment: { SECRET: "must-not-be-returned" },
  advanced: { resources },
}));
const pool = {
  cpuCores: { used: 4, max: 4 },
  memoryMb: { used: 4096, max: 16384 },
  diskMb: { used: 8192, max: 131072 },
  workspaces: { used: 1, max: 6 },
};
beforeEach(() => {
  vi.resetAllMocks();
  h.project.mockResolvedValue(project);
  h.projects.mockResolvedValue([project]);
  h.permission.mockResolvedValue(true);
  h.services.mockResolvedValue(rows);
  h.inFlight.mockResolvedValue([]);
  h.pool.mockResolvedValue(pool);
  h.binding.mockResolvedValue({ namespace: "tenant-a", workspaceId: "workspace" });
  h.workspace.mockResolvedValue({
    id: "workspace",
    namespace: "tenant-a",
    status: "running",
    resources: { cpus: 2, memory_mb: 2560, disk_size_mb: 8192 },
  });
  h.active.mockResolvedValue({
    id: "active",
    projectId: "project",
    organizationId: "org-a",
    branch: "main",
    environment: "production",
    createdAt: stamp,
    envVars: { SAVED: "encrypted-value" },
    meta: { framework: "docker-compose", deployTarget: "cloud", resources },
  });
  h.entitlement.mockResolvedValue({
    tier: "pro",
    limits: planLimits("pro"),
    resourceLimits: resolvePlan("pro").oblienLimits,
  });
  h.trigger.mockResolvedValue({ deployment: { id: "adjustment" } });
});

async function edit(cpuCores = 0.25, memoryMb = 512) {
  const overview = await getCapacity(ctx);
  return {
    projectId: "project",
    revision: overview.projects[0]!.revision,
    services: [{ serviceId: "api", cpuCores, memoryMb }],
  };
}

describe("Cloud capacity preview and adjustment", () => {
  it("reports authoritative allocation without exposing config, secrets or workspace credentials", async () => {
    const view = await getCapacity(ctx);
    expect(view.pool.cpuCores).toEqual({ used: 4, max: 4 });
    expect(view.projects[0]).toMatchObject({
      editable: true,
      allocation: { cpuCores: 2, memoryMb: 2560 },
      services: [{ id: "api" }, { id: "db" }],
    });
    expect(JSON.stringify(view)).not.toMatch(/must-not-be-returned|encrypted-value|tenant-a/);
  });
  it("previews CPU and RAM independently, preserving disks and naming all potentially restarted services", async () => {
    const result = await previewCapacity(ctx, await edit());
    expect(result.after).toEqual({ cpuCores: 1.25, memoryMb: 2048, diskMb: 8192 });
    expect(result.restartServices).toEqual(["api", "db"]);
    expect(h.trigger).not.toHaveBeenCalled();
  });
  it("queues an exact retained-image refresh with transactional overrides and no new source commit", async () => {
    const input = {
      ...(await edit()),
      confirmRestart: true as const,
      idempotencyKey: "request-0123456789",
    };
    expect(await applyCapacity(ctx, input)).toEqual({
      deploymentId: "adjustment",
      projectId: "project",
    });
    const args = h.trigger.mock.calls[0]![1];
    expect(args).toMatchObject({
      refresh: true,
      strictServiceScope: true,
      serviceIds: ["api"],
      trigger: "capacity",
      resourceChanges: {
        expectedActiveDeploymentId: "active",
        services: [
          {
            serviceId: "api",
            expectedResources: resources,
            resources: { cpuCores: 0.25, memoryMb: 512 },
          },
          { serviceId: "db", expectedResources: resources },
        ],
      },
      reuseSnapshot: { meta: { handoverImages: { api: "sha256:retained", db: "postgres:17" } } },
    });
    expect(args.commitSha).toBeUndefined();
    const meta = args.reuseSnapshot.meta;
    h.existing.mockResolvedValue({ id: "adjustment", meta, status: "building" });
    expect(await applyCapacity(ctx, input)).toEqual({
      deploymentId: "adjustment",
      projectId: "project",
    });
    expect(h.trigger).toHaveBeenCalledTimes(1);
    await expect(
      applyCapacity(ctx, {
        ...input,
        services: [{ serviceId: "api", cpuCores: 0.5, memoryMb: 512 }],
      }),
    ).rejects.toMatchObject({ code: "CLOUD_CAPACITY_IDEMPOTENCY_CONFLICT" });
  });
  it("rejects a changed project revision before queueing", async () => {
    const input = await edit();
    h.project.mockResolvedValue({ ...project, updatedAt: new Date(stamp.getTime() + 1000) });
    await expect(previewCapacity(ctx, input)).rejects.toMatchObject({
      code: "CLOUD_CAPACITY_CHANGED",
    });
    expect(h.trigger).not.toHaveBeenCalled();
  });
  it("does not use a CPU reduction to pay for RAM growth beyond its pool", async () => {
    const input = await edit(0.25, 2048);
    h.pool.mockResolvedValue({ ...pool, memoryMb: { used: 4096, max: 4096 } });
    await expect(previewCapacity(ctx, input)).rejects.toMatchObject({
      code: "CLOUD_CAPACITY_REQUIRED",
    });
  });
  it("rejects a per-workspace limit even when the namespace has spare capacity", async () => {
    h.entitlement.mockResolvedValue({
      tier: "pro",
      limits: planLimits("pro"),
      resourceLimits: { ...resolvePlan("pro").oblienLimits, max_ram_mb: 2048 },
    });
    const input = await edit(0.25, 2048);
    await expect(previewCapacity(ctx, input)).rejects.toMatchObject({
      code: "PLAN_UPGRADE_REQUIRED",
      reason: "workspace-capacity",
    });
    expect(h.trigger).not.toHaveBeenCalled();
  });
  it("requires write permission on every service that may restart", async () => {
    h.permission.mockImplementation(
      async (_ctx, request) => !(request.resourceId === "db" && request.action === "write"),
    );
    expect((await getCapacity(ctx)).projects[0]).toMatchObject({
      editable: false,
      unavailableReason: "permission",
    });
    await expect(previewCapacity(ctx, await edit())).rejects.toMatchObject({
      code: "CLOUD_CAPACITY_UNAVAILABLE",
    });
  });
  it("does not expose a hidden service in the capacity list", async () => {
    h.permission.mockImplementation(async (_ctx, request) => request.resourceId !== "db");
    const view = await getCapacity(ctx);
    expect(view.projects[0]!.services.map((s) => s.id)).toEqual(["api"]);
    expect(view.projects[0]!.editable).toBe(false);
  });
  it("rejects an ownership mismatch before accepting provider capacity", async () => {
    h.workspace.mockResolvedValue({
      id: "workspace",
      namespace: "tenant-b",
      resources: { cpus: 1, memory_mb: 1024, disk_size_mb: 8192 },
    });
    await expect(getCapacity(ctx)).rejects.toMatchObject({ code: "CLOUD_NAMESPACE_MISMATCH" });
  });
  it("rejects duplicate and foreign service IDs", async () => {
    const input = await edit();
    for (const services of [
      [...input.services, ...input.services],
      [{ serviceId: "foreign", cpuCores: 1, memoryMb: 512 }],
    ]) {
      await expect(previewCapacity(ctx, { ...input, services })).rejects.toMatchObject({
        code: "CLOUD_CAPACITY_INVALID",
      });
    }
  });
  it("keeps project authorization on an idempotent replay", async () => {
    const input = {
      ...(await edit()),
      confirmRestart: true as const,
      idempotencyKey: "request-0123456789",
    };
    h.authorize.mockRejectedValue(new AppError("Forbidden", 403));
    await expect(applyCapacity(ctx, input)).rejects.toMatchObject({ statusCode: 403 });
    expect(h.existing).not.toHaveBeenCalled();
  });

  it("rechecks every service's write access before resuming the same queued worker", async () => {
    const input = {
      ...(await edit()),
      confirmRestart: true as const,
      idempotencyKey: "request-0123456789",
    };
    await applyCapacity(ctx, input);
    const meta = h.trigger.mock.calls[0]![1].reuseSnapshot.meta;
    h.existing.mockResolvedValue({ id: "adjustment", meta, status: "queued" });
    h.authorize.mockImplementation(async (_ctx, permission) => {
      if (permission.resourceId === "db") throw new AppError("Forbidden", 403);
    });
    await expect(applyCapacity(ctx, input)).rejects.toMatchObject({ statusCode: 403 });
    expect(h.kickoff).not.toHaveBeenCalled();
    h.authorize.mockResolvedValue(undefined);
    expect(await applyCapacity(ctx, input)).toMatchObject({ deploymentId: "adjustment" });
    expect(h.kickoff).toHaveBeenCalledOnce();
    expect(h.trigger).toHaveBeenCalledOnce();
  });

  it("includes disabled siblings in restart authorization because they may still be running", async () => {
    h.services.mockResolvedValue([...rows, { ...rows[0], id: "disabled", enabled: false }]);
    h.permission.mockImplementation(async (_ctx, request) => request.resourceId !== "disabled");
    expect((await getCapacity(ctx)).projects[0]).toMatchObject({
      editable: false,
      unavailableReason: "permission",
    });
  });

  it("keeps other allocations visible when one host cannot be inspected", async () => {
    h.projects.mockResolvedValue([project, { ...project, id: "unreachable", name: "Unreachable" }]);
    h.active.mockImplementation(async () => null);
    h.workspace.mockRejectedValueOnce(new Error("provider unavailable"));
    const overview = await getCapacity(ctx);
    expect(overview.projects.find((p) => p.id === "unreachable")?.allocation).toMatchObject({
      cpuCores: 2,
    });
  });

  it("can reapply saved limits after a failed attempt without requiring new values", async () => {
    const savedRows = rows.map((s) =>
      s.id === "api"
        ? { ...s, advanced: { resources: { ...resources, cpuCores: 0.25, memoryMb: 512 } } }
        : s,
    );
    h.services.mockResolvedValue(savedRows);
    const input = {
      ...(await edit()),
      confirmRestart: true as const,
      idempotencyKey: "retry-0123456789",
    };
    expect(await applyCapacity(ctx, input)).toMatchObject({ deploymentId: "adjustment" });
    expect(h.trigger.mock.calls[0]![1].serviceIds).toEqual(["api"]);
  });
});
