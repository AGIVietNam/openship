import { beforeEach, describe, expect, it, vi } from "vitest";
import { OperationError } from "@repo/contracts";
const h = vi.hoisted(() => ({
  cloud: true,
  org: vi.fn(),
  binding: vi.fn(),
  workspace: vi.fn(),
  namespace: vi.fn(),
}));
vi.mock("@repo/platform/engine/config/env", () => ({
  env: {
    get CLOUD_MODE() {
      return h.cloud;
    },
  },
}));
vi.mock("@repo/db", () => ({
  repos: { organization: { findById: h.org }, cloudDockerWorkspace: { find: h.binding } },
}));
vi.mock("@repo/platform/engine/lib/oblien-client", () => ({
  getOblienClient: () => ({
    workspaces: { get: h.workspace },
    namespaces: { get: h.namespace },
  }),
}));
import {
  assertCloudWorkspaceCapacity,
  cloudCapacityFailure,
  readCloudWorkspaceAllocation,
} from "@repo/platform/engine/lib/cloud-capacity";
import { readCloudCapacityPool } from "@repo/platform/engine/lib/cloud-resource-limits";

const input = {
  organizationId: "org",
  projectId: "project",
  reuseDockerWorkspace: true,
  requested: { cpuCores: 1, memoryMb: 2048, diskMb: 8192 },
};
const namespace = {
  success: true,
  data: {
    slug: "tenant",
    effective_resource_limits: {
      max_workspaces: 4,
      max_total_vcpus: 4,
      max_total_ram_mb: 8192,
      max_total_disk_gb: 32,
    },
    allocated_resource_usage: {
      workspaces: 4,
      vcpus: 4,
      ram_mb: 8192,
      disk_gb: 32,
      pending_updates: 0,
    },
  },
};
beforeEach(() => {
  vi.resetAllMocks();
  h.cloud = true;
  h.org.mockResolvedValue({ oblienNamespace: "tenant" });
  h.binding.mockResolvedValue({ workspaceId: "workspace", namespace: "tenant" });
  h.workspace.mockResolvedValue({
    id: "workspace",
    namespace: "tenant",
    resources: { cpus: 2, memory_mb: 3072, disk_size_mb: 8192 },
  });
  h.namespace.mockResolvedValue(structuredClone(namespace));
});

describe("Cloud allocation admission", () => {
  it("does not read or enforce Cloud quotas on self-hosted deployments", async () => {
    h.cloud = false;
    await assertCloudWorkspaceCapacity(input);
    expect(h.org).not.toHaveBeenCalled();
    expect(h.workspace).not.toHaveBeenCalled();
    expect(h.namespace).not.toHaveBeenCalled();
  });
  it("allows downsizing a verified Docker workspace in a full pool", async () => {
    await expect(assertCloudWorkspaceCapacity(input)).resolves.toBeUndefined();
    expect(h.binding).toHaveBeenCalledWith("project", "org");
  });
  it("reserves the full allocation for a replacement workspace", async () => {
    await expect(
      assertCloudWorkspaceCapacity({ ...input, reuseDockerWorkspace: false }),
    ).rejects.toMatchObject({
      code: "CLOUD_CAPACITY_REQUIRED",
      details: {
        projectId: "project",
        capacity: {
          shortfalls: expect.arrayContaining([
            expect.objectContaining({ dimension: "workspaces", additional: 1 }),
          ]),
        },
      },
    });
    expect(h.binding).not.toHaveBeenCalled();
    expect(h.workspace).not.toHaveBeenCalled();
  });
  it("never credits an existing host's allocation when its namespace changed", async () => {
    h.binding.mockResolvedValue({ namespace: "foreign", workspaceId: "workspace" });
    await expect(assertCloudWorkspaceCapacity(input)).rejects.toMatchObject({
      code: "CLOUD_NAMESPACE_MISMATCH",
    });
    expect(h.workspace).not.toHaveBeenCalled();
  });
  it.each([
    { id: "different", namespace: "tenant" },
    { id: "workspace", namespace: "foreign" },
  ])("rejects a mismatched provider workspace: %j", async (identity) => {
    h.workspace.mockResolvedValue({
      ...identity,
      resources: { cpus: 2, memory_mb: 3072, disk_size_mb: 8192 },
    });
    await expect(assertCloudWorkspaceCapacity(input)).rejects.toMatchObject({
      code: "CLOUD_NAMESPACE_MISMATCH",
    });
  });
  it.each([
    undefined,
    { cpus: 2, memory_mb: -1, disk_size_mb: 8192 },
    { cpus: NaN, memory_mb: 3072, disk_size_mb: 8192 },
  ])("does not treat malformed workspace resources as free capacity: %j", async (resources) => {
    h.workspace.mockResolvedValue({ id: "workspace", namespace: "tenant", resources });
    await expect(readCloudWorkspaceAllocation("workspace", "tenant")).rejects.toMatchObject({
      code: "CLOUD_CAPACITY_UNAVAILABLE",
    });
    await expect(assertCloudWorkspaceCapacity(input)).resolves.toBeUndefined();
  });
  it("requires complete measurements for edits while deferring ordinary admission to the provider", async () => {
    h.namespace.mockResolvedValue({ success: true, data: { slug: "tenant" } });
    await expect(readCloudCapacityPool("tenant")).rejects.toMatchObject({
      code: "CLOUD_CAPACITY_UNAVAILABLE",
    });
    await expect(assertCloudWorkspaceCapacity(input)).resolves.toBeUndefined();
  });
  it.each(["workspace", "namespace"] as const)(
    "does not reject a deployment just because its %s preflight read is unavailable",
    async (read) => {
      h[read].mockRejectedValue(new Error("Provider read timed out"));
      await expect(assertCloudWorkspaceCapacity(input)).resolves.toBeUndefined();
    },
  );
  it("still rejects a namespace mismatch at the provider read boundary", async () => {
    h.namespace.mockResolvedValue({ ...namespace, data: { ...namespace.data, slug: "foreign" } });
    await expect(assertCloudWorkspaceCapacity(input)).rejects.toMatchObject({
      code: "CLOUD_NAMESPACE_MISMATCH",
    });
  });
  it("does not pay for memory growth with a CPU reduction", async () => {
    await expect(
      assertCloudWorkspaceCapacity({ ...input, requested: { ...input.requested, memoryMb: 4096 } }),
    ).rejects.toMatchObject({
      code: "CLOUD_CAPACITY_REQUIRED",
      details: {
        capacity: {
          shortfalls: [
            expect.objectContaining({ dimension: "memoryMb", additional: 1024, missing: 1024 }),
          ],
        },
      },
    });
  });
  it("retains the effective builder size in a measured pool refusal", async () => {
    const buildResources = { cpuCores: 0.25, memoryMb: 1024, diskMb: 8192 };
    await expect(assertCloudWorkspaceCapacity({ ...input, requested: { ...input.requested, memoryMb: 4096 }, buildResources }))
      .rejects.toMatchObject({ code: "CLOUD_CAPACITY_REQUIRED", details: { capacity: { buildResources } } });
  });
  it.each([null, { cpuCores: 0.25, memoryMb: 512, diskMb: 8192 }])("keeps build recovery after an asynchronous provider refusal: %j", (buildResources) => {
    expect(cloudCapacityFailure({ code: "NAMESPACE_LIMIT_REACHED" }, "project", buildResources))
      .toMatchObject({ code: "CLOUD_CAPACITY_REQUIRED", details: { projectId: "project", capacity: { buildResources } } });
  });
  it("preserves a typed build-limit recovery across the worker boundary", () => {
    const error = new OperationError("Build too large", 402, "PLAN_UPGRADE_REQUIRED", {
      projectId: "project", reason: "resource-tier",
      capacity: { buildResources: { cpuCores: 4, memoryMb: 8192, diskMb: 32768 } },
    });
    expect(cloudCapacityFailure(new Error("Preparing workspace", { cause: error }), "project")).toBe(error);
  });
  it("normalizes only the provider's namespace limit error without exposing provider payloads", () => {
    expect(
      cloudCapacityFailure(
        {
          code: "NAMESPACE_LIMIT_REACHED",
          message: "private provider context",
          requestId: "d2d9dcc2-df90-4bcd-82e8-7c8d99106634",
        },
        "project",
      ),
    ).toMatchObject({
      code: "CLOUD_CAPACITY_REQUIRED",
      details: { projectId: "project", reference: "d2d9dcc2-df90-4bcd-82e8-7c8d99106634" },
    });
    for (const code of ["OWNER_LIMIT_REACHED", "FLEET_FULL", "INSUFFICIENT_CAPACITY", "UNKNOWN"]) {
      expect(cloudCapacityFailure({ code }, "project")).toBeNull();
    }
  });
  it("preserves a namespace refusal through adapter context without treating other causes as capacity", () => {
    const refusal = Object.assign(new Error("Provider details"), { code: "NAMESPACE_LIMIT_REACHED" });
    const error = new Error("Could not prepare the existing workspace", { cause: new Error("Could not resize", { cause: refusal }) });
    expect(cloudCapacityFailure(error, "project")).toMatchObject({ code: "CLOUD_CAPACITY_REQUIRED", details: { projectId: "project" } });
    const cyclic = new Error("not a capacity failure");
    cyclic.cause = cyclic;
    expect(cloudCapacityFailure(cyclic, "project")).toBeNull();
    expect(cloudCapacityFailure(new Error("NAMESPACE_LIMIT_REACHED in a log line"), "project")).toBeNull();
  });
});
