import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@repo/db";
import { cloudAllocationShortfalls, type CloudAllocation } from "@repo/core";
import type { DeploymentConfigSnapshot } from "@repo/platform/engine/modules/deployments/build.service";

const h = vi.hoisted(() => ({
  cloud: true,
  org: vi.fn(),
  binding: vi.fn(),
  namespace: vi.fn(),
  workspace: vi.fn(),
  services: vi.fn(),
  previous: vi.fn(),
}));
vi.mock("@repo/platform/engine/config/env", () => ({
  env: {
    get CLOUD_MODE() {
      return h.cloud;
    },
  },
}));
vi.mock("@repo/db", () => ({
  repos: {
    organization: { findById: h.org },
    cloudDockerWorkspace: { find: h.binding },
    service: { listByProject: h.services },
  },
}));
vi.mock("@repo/platform/engine/lib/active-deployment", () => ({
  listActiveServiceDeployments: h.previous,
}));
vi.mock("@repo/platform/engine/lib/oblien-client", () => ({
  getOblienClient: () => ({
    namespaces: { get: h.namespace },
    workspaces: { get: h.workspace },
  }),
}));
import {
  allocateCloudBuildResources,
  prepareCloudBuildResources,
} from "@repo/platform/engine/modules/deployments/cloud-build-resources";

const micro = { cpuCores: 0.25, memoryMb: 256, diskMb: 8192 };
const zero = { cpuCores: 0, memoryMb: 0, diskMb: 0 };
const host = { ...micro, memoryMb: 1024 };
const project = { id: "project", organizationId: "org" } as Project;
const snapshot = {
  resources: micro,
  buildResources: null,
  workload: "web",
  runtime: "docker",
  framework: "node",
  hasServer: true,
} as unknown as DeploymentConfigSnapshot;
const services = [{ name: "api", build: ".", advanced: { resources: micro } }];
const capacity = () => ({
  pool: {
    cpuCores: { used: 1, max: 4 },
    memoryMb: { used: 2048, max: 8192 },
    diskMb: { used: 32768, max: 65536 },
    workspaces: { used: 4, max: 12 },
  },
  workspace: { cpuCores: 4, memoryMb: 8192, diskMb: 32768 },
});
const providerCapacity = (value = capacity()) => ({
  success: true,
  data: {
    slug: "tenant",
    effective_resource_limits: {
      max_workspaces: value.pool.workspaces.max,
      max_total_vcpus: value.pool.cpuCores.max,
      max_total_ram_mb: value.pool.memoryMb.max,
      max_total_disk_gb: value.pool.diskMb.max! / 1024,
      max_vcpus: value.workspace.cpuCores,
      max_ram_mb: value.workspace.memoryMb,
      max_disk_gb: value.workspace.diskMb / 1024,
    },
    allocated_resource_usage: {
      workspaces: value.pool.workspaces.used,
      vcpus: value.pool.cpuCores.used,
      ram_mb: value.pool.memoryMb.used,
      disk_gb: value.pool.diskMb.used / 1024,
      pending_updates: 0,
    },
  },
});

beforeEach(() => {
  vi.resetAllMocks();
  h.cloud = true;
  h.org.mockResolvedValue({ oblienNamespace: "tenant" });
  h.binding.mockResolvedValue({ namespace: "tenant", workspaceId: "host" });
  h.namespace.mockResolvedValue(providerCapacity());
  h.workspace.mockResolvedValue({
    id: "host",
    namespace: "tenant",
    resources: { cpus: host.cpuCores, memory_mb: host.memoryMb, disk_size_mb: host.diskMb },
  });
  h.services.mockResolvedValue([{ id: "svc-api", name: "api" }]);
  h.previous.mockResolvedValue([]);
});

describe("Cloud build allocation from Oblien's shared pool", () => {
  it("uses the remaining CPU/RAM and carries the same allocation to the Docker host", async () => {
    const plan = await prepareCloudBuildResources({
      project,
      snapshot,
      services,
      dockerWorkspace: true,
    });
    expect(plan).toEqual({
      build: { cpuCores: 3, memoryMb: 6144, diskMb: 8192 },
      services: { api: { cpuCores: 3, memoryMb: 6144, diskMb: 8192 } },
      workspace: { cpuCores: 3.25, memoryMb: 7168, diskMb: 8192 },
    });
    expect(cloudAllocationShortfalls(capacity().pool, plan!.workspace!, host)).toEqual([]);
    expect(snapshot.resources).toEqual(micro);
    expect(snapshot.buildResources).toBeNull();
  });
  it("builds with 0.25 CPU of headroom instead of demanding the old fixed 1 CPU/2 GB", async () => {
    const small = capacity();
    small.pool.cpuCores.used = 3.75;
    small.pool.memoryMb.used = 7936;
    h.namespace.mockResolvedValue(providerCapacity(small));
    const plan = await prepareCloudBuildResources({
      project,
      snapshot,
      services,
      dockerWorkspace: true,
    });
    expect(plan!.build).toEqual({ cpuCores: 0.25, memoryMb: 256, diskMb: 8192 });
    expect(plan!.workspace).toEqual({ cpuCores: 0.5, memoryMb: 1280, diskMb: 8192 });
  });
  it("uses the effective provider workspace cap rather than a catalog build tier", async () => {
    const small = capacity();
    small.workspace.cpuCores = 0.5;
    small.workspace.memoryMb = 1536;
    h.namespace.mockResolvedValue(providerCapacity(small));
    expect(
      (await prepareCloudBuildResources({ project, snapshot, services, dockerWorkspace: true }))!
        .build,
    ).toEqual({ cpuCores: 0.25, memoryMb: 512, diskMb: 8192 });
  });
  it("re-reads available capacity at worker start instead of trusting queue-time sizing", async () => {
    const first = await prepareCloudBuildResources({
      project,
      snapshot,
      services,
      dockerWorkspace: true,
    });
    const changed = capacity();
    changed.pool.cpuCores.used = 3.5;
    h.namespace.mockResolvedValue(providerCapacity(changed));
    const second = await prepareCloudBuildResources({
      project,
      snapshot,
      services,
      dockerWorkspace: true,
    });
    expect(first!.build.cpuCores).toBe(3);
    expect(second!.build.cpuCores).toBe(0.5);
    expect(h.namespace).toHaveBeenCalledTimes(2);
  });
  it("bounds a saved oversized build setting to available capacity without changing runtime settings", async () => {
    const plan = await prepareCloudBuildResources({
      project,
      services,
      dockerWorkspace: true,
      snapshot: { ...snapshot, buildResources: { cpuCores: 8, memoryMb: 16384, diskMb: 8192 } },
    });
    expect(plan!.build).toEqual({ cpuCores: 3, memoryMb: 6144, diskMb: 8192 });
  });
  it("honors a smaller explicit build cap and retains Docker overhead", async () => {
    const plan = await prepareCloudBuildResources({
      project,
      services,
      dockerWorkspace: true,
      snapshot: { ...snapshot, buildResources: { cpuCores: 0.25, memoryMb: 128, diskMb: 8192 } },
    });
    expect(plan!.build).toEqual({ cpuCores: 0.25, memoryMb: 128, diskMb: 8192 });
    expect(plan!.workspace!.memoryMb).toBe(1280);
  });
  it("uses one sequential build budget for Docker source services without including image siblings", async () => {
    const plan = await prepareCloudBuildResources({
      project,
      snapshot,
      dockerWorkspace: true,
      services: [
        ...services,
        { ...services[0]!, name: "web" },
        { name: "cache", image: "redis:7" },
      ],
    });
    expect(plan!.services).toEqual({ api: plan!.build, web: plan!.build });
    expect(cloudAllocationShortfalls(capacity().pool, plan!.workspace!, host)).toEqual([]);
  });
  it("reports a full pool before provisioning and never borrows allocated runtime CPU", async () => {
    const full = capacity();
    full.pool.cpuCores.used = 4;
    h.namespace.mockResolvedValue(providerCapacity(full));
    await expect(
      prepareCloudBuildResources({ project, snapshot, services, dockerWorkspace: true }),
    ).rejects.toMatchObject({
      code: "CLOUD_CAPACITY_REQUIRED",
      details: {
        capacity: {
          shortfalls: expect.arrayContaining([
            expect.objectContaining({ dimension: "cpuCores", missing: 0.25 }),
          ]),
        },
      },
    });
  });
  it("does not credit a pending runtime downsize as already-released capacity", async () => {
    h.workspace.mockResolvedValue({
      id: "host",
      namespace: "tenant",
      resources: { cpus: 1, memory_mb: 2048, disk_size_mb: 8192 },
    });
    const full = capacity();
    full.pool.cpuCores.used = 4;
    h.namespace.mockResolvedValue(providerCapacity(full));
    await expect(
      prepareCloudBuildResources({ project, snapshot, services, dockerWorkspace: true }),
    ).rejects.toMatchObject({ code: "CLOUD_CAPACITY_REQUIRED" });
  });
  it("reserves the new project's runtime before selecting its builder", async () => {
    h.binding.mockResolvedValue(null);
    const plan = await prepareCloudBuildResources({
      project,
      snapshot,
      services,
      dockerWorkspace: true,
    });
    expect(plan!.build).toEqual({ cpuCores: 2.75, memoryMb: 5120, diskMb: 8192 });
    expect(plan!.workspace).toEqual({ cpuCores: 3, memoryMb: 6144, diskMb: 8192 });
  });
  it("preserves a larger existing disk without consuming the remaining storage pool", async () => {
    h.workspace.mockResolvedValue({
      id: "host",
      namespace: "tenant",
      resources: { cpus: 0.25, memory_mb: 1024, disk_size_mb: 16384 },
    });
    const plan = await prepareCloudBuildResources({
      project,
      snapshot,
      services,
      dockerWorkspace: true,
    });
    expect(plan!.workspace!.diskMb).toBe(16384);
  });
  it.each(["CPU", "memory", "disk", "workspaces"])(
    "reports insufficient %s for a new builder",
    async (dimension) => {
      h.binding.mockResolvedValue(null);
      const full = capacity();
      const key = { CPU: "cpuCores", memory: "memoryMb", disk: "diskMb", workspaces: "workspaces" }[
        dimension
      ] as keyof typeof full.pool;
      full.pool[key].used = full.pool[key].max;
      h.namespace.mockResolvedValue(providerCapacity(full));
      await expect(
        prepareCloudBuildResources({ project, snapshot, services, dockerWorkspace: true }),
      ).rejects.toMatchObject({ code: "CLOUD_CAPACITY_REQUIRED" });
    },
  );
  it("shares remaining capacity across native source builds instead of multiplying the reservation", async () => {
    const plan = await prepareCloudBuildResources({
      project,
      snapshot,
      dockerWorkspace: false,
      services: [services[0]!, { ...services[0]!, name: "web" }],
    });
    expect(plan!.services).toEqual({
      api: { cpuCores: 1.5, memoryMb: 3072, diskMb: 8192 },
      web: { cpuCores: 1.5, memoryMb: 3072, diskMb: 8192 },
    });
  });
  it("reserves image service increases alongside native source builds", async () => {
    h.previous.mockResolvedValue([{ serviceName: "cache", containerId: "cache" }]);
    h.workspace.mockResolvedValue({
      id: "cache",
      namespace: "tenant",
      resources: { cpus: 0.25, memory_mb: 256, disk_size_mb: 8192 },
    });
    const plan = await prepareCloudBuildResources({
      project,
      snapshot,
      dockerWorkspace: false,
      services: [
        services[0]!,
        { name: "cache", image: "redis:7", advanced: { resources: { ...micro, cpuCores: 0.5 } } },
      ],
    });
    expect(plan!.build.cpuCores).toBe(2.75);
    expect(plan!.build.memoryMb).toBe(6144);
  });
  it("uses a single native build's available capacity without double-counting its future runtime", async () => {
    const plan = await prepareCloudBuildResources({ project, snapshot, dockerWorkspace: false });
    expect(plan!.build).toEqual({ cpuCores: 3, memoryMb: 6144, diskMb: 8192 });
  });
  it("reuses an uploaded build workspace without charging another workspace slot", async () => {
    const full = capacity();
    full.pool.workspaces.used = full.pool.workspaces.max;
    h.namespace.mockResolvedValue(providerCapacity(full));
    const plan = await prepareCloudBuildResources({
      project,
      snapshot: { ...snapshot, uploadWorkspaceId: "host" },
      dockerWorkspace: false,
    });
    expect(plan!.build).toEqual({ cpuCores: 3.25, memoryMb: 7168, diskMb: 8192 });
  });
  it.each([
    { dockerWorkspace: true, services: [{ name: "cache", image: "redis:7" }], snapshot },
    {
      dockerWorkspace: true,
      services,
      snapshot: { ...snapshot, refreshServiceIds: ["svc-api"], targetServiceIds: ["svc-api"] },
    },
    { dockerWorkspace: false, snapshot: { ...snapshot, releaseImageRef: "image@sha256:abc" } },
    { dockerWorkspace: false, snapshot: { ...snapshot, refreshAppDeploymentId: "dep" } },
  ])(
    "does not request a builder for image-only or retained-image operations: %j",
    async (input) => {
      expect(await prepareCloudBuildResources({ project, ...input })).toBeUndefined();
      expect(h.namespace).not.toHaveBeenCalled();
    },
  );
  it("does not apply Cloud build sizing to self-hosted deployments", async () => {
    h.cloud = false;
    expect(
      await prepareCloudBuildResources({ project, snapshot, services, dockerWorkspace: true }),
    ).toBeUndefined();
    expect(h.org).not.toHaveBeenCalled();
    expect(h.namespace).not.toHaveBeenCalled();
  });
  it.each(["binding", "workspace", "namespace"])(
    "rejects a changed %s identity instead of borrowing another tenant's resources",
    async (kind) => {
      if (kind === "binding")
        h.binding.mockResolvedValue({ workspaceId: "host", namespace: "other" });
      if (kind === "workspace")
        h.workspace.mockResolvedValue({
          id: "other",
          namespace: "tenant",
          resources: { cpus: 4, memory_mb: 8192, disk_size_mb: 8192 },
        });
      if (kind === "namespace")
        h.namespace.mockResolvedValue({
          ...providerCapacity(),
          data: { ...providerCapacity().data, slug: "other" },
        });
      await expect(
        prepareCloudBuildResources({ project, snapshot, services, dockerWorkspace: true }),
      ).rejects.toMatchObject({ code: "CLOUD_NAMESPACE_MISMATCH" });
    },
  );
  it("never treats missing provider allocation readings as free capacity", async () => {
    h.namespace.mockResolvedValue({ success: true, data: { slug: "tenant" } });
    await expect(
      prepareCloudBuildResources({ project, snapshot, services, dockerWorkspace: true }),
    ).rejects.toMatchObject({ code: "CLOUD_CAPACITY_UNAVAILABLE" });
  });
  it("respects heterogeneous native runtime sizes while dividing the headroom", () => {
    const plan = allocateCloudBuildResources({
      projectId: project.id,
      capacity: capacity(),
      additionalWorkspaces: 2,
      slots: [
        { name: "api", runtime: { ...micro, cpuCores: 2 } },
        { name: "web", runtime: micro },
      ],
    });
    expect(plan.services!.api!.cpuCores).toBe(2.375);
    expect(plan.services!.web!.cpuCores).toBe(0.625);
  });
  it("does not round small fractional remaining allocations up past the provider pool", () => {
    for (const available of [0.25, 0.3, 0.75, 1, 2.1, 3.999999]) {
      const current = capacity();
      current.pool.cpuCores.used = 4 - available;
      const plan = allocateCloudBuildResources({
        projectId: project.id,
        capacity: current,
        slots: [{ name: "build", runtime: zero }],
        additionalWorkspaces: 1,
      });
      expect(plan.build.cpuCores).toBeGreaterThanOrEqual(0.25);
      expect(plan.build.cpuCores).toBeLessThanOrEqual(available + 1e-9);
    }
  });
});
