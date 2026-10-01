import { describe, expect, it, vi } from "vitest";
import { RESOURCE_TIER_SPECS } from "@repo/core";
import { CloudComposeSupport } from "./compose";
import type { MultiServiceDeployConfig } from "../types";

function cloudPool() {
  const workspaces = new Map<string, ReturnType<typeof add>>();
  const allocatedCpu = (): number =>
    [...workspaces.values()].reduce((sum, ws) => sum + ws.allocation.cpus, 0);
  function add(id: string, cpus = 1, memory_mb = 1024) {
    const allocation = { cpus, memory_mb, disk_size_mb: 20480 };
    const workspace = {
      id,
      allocation,
      get: vi.fn(async () => ({
        id,
        namespace: "customer",
        status: "active",
        resources: { ...allocation },
      })),
      resources: {
        update: vi.fn(async (next: { cpus: number; memory_mb: number; disk_size_mb?: number }) => {
          if (allocatedCpu() - allocation.cpus + next.cpus > 4) {
            throw Object.assign(new Error("Namespace CPU capacity exceeded"), {
              code: "NAMESPACE_LIMIT_REACHED",
            });
          }
          Object.assign(allocation, { cpus: next.cpus, memory_mb: next.memory_mb });
          return { success: true, relaunched: true };
        }),
      },
      lifecycle: { makePermanent: vi.fn(async () => ({})) },
      workloads: { delete: vi.fn(async () => ({})), create: vi.fn(async () => ({})) },
      network: { get: vi.fn(async () => ({ ingress_ports: [] })), update: vi.fn(async () => ({})) },
      apiAccess: { rawToken: vi.fn(async () => ({ ip: "10.0.0.8" })) },
      runtime: vi.fn(async () => ({})),
      delete: vi.fn(async () => {
        workspaces.delete(id);
      }),
    };
    workspaces.set(id, workspace);
    return workspace;
  }
  const create = vi.fn(async (request: { config: { cpus: number; memory_mb: number } }) => {
    if (allocatedCpu() + request.config.cpus > 4) {
      throw Object.assign(new Error("Namespace CPU capacity exceeded"), {
        code: "NAMESPACE_LIMIT_REACHED",
      });
    }
    const id = `new-workspace-${workspaces.size}`;
    add(id, request.config.cpus, request.config.memory_mb);
    return { id };
  });
  const support = new CloudComposeSupport({
    client: { workspaces: { create } },
    namespace: "customer",
    builtArtifacts: new Map(),
    workspace: (id: string) => workspaces.get(id),
    execAndStream: vi.fn(async () => undefined),
  } as never);
  const deploy = async (id: string, resources = RESOURCE_TIER_SPECS.micro, existing = true) => {
    const config: MultiServiceDeployConfig = {
      deploymentId: `deployment-${id}`,
      projectId: `project-${id}`,
      slug: `project-${id}`,
      serviceName: "app",
      image: "example/app:1",
      ports: [],
      environment: {},
      volumes: [],
      namespaceVolumes: true,
      resources,
      previousWorkspaceId: existing ? id : undefined,
    };
    const group = await support.ensureServiceGroup({
      deploymentId: config.deploymentId,
      projectId: config.projectId,
      slug: config.slug,
    });
    return support.deployServiceWorkload(group, config);
  };
  return { add, create, allocatedCpu, deploy };
}

describe("native Cloud image service resource changes", () => {
  it("applies Micro on redeploy while preserving the existing workspace and disk", async () => {
    const pool = cloudPool();
    const workspace = pool.add("existing");
    await expect(pool.deploy("existing")).resolves.toMatchObject({
      containerId: "existing",
      status: "running",
    });
    expect(workspace.resources.update).toHaveBeenCalledExactlyOnceWith({
      cpus: 0.25,
      memory_mb: 256,
      apply: true,
    });
    expect(workspace.allocation).toEqual({ cpus: 0.25, memory_mb: 256, disk_size_mb: 20480 });
    expect(pool.create).not.toHaveBeenCalled();
    expect(workspace.delete).not.toHaveBeenCalled();
  });

  it("releases four old whole-core reservations so a fifth project fits the same CPU pool", async () => {
    const pool = cloudPool();
    for (let index = 0; index < 4; index++) pool.add(`existing-${index}`);
    expect(pool.allocatedCpu()).toBe(4);
    await expect(pool.deploy("fifth", RESOURCE_TIER_SPECS.medium, false)).rejects.toMatchObject({
      code: "NAMESPACE_LIMIT_REACHED",
    });
    for (let index = 0; index < 4; index++) await pool.deploy(`existing-${index}`);
    expect(pool.allocatedCpu()).toBe(1);
    await expect(pool.deploy("fifth", RESOURCE_TIER_SPECS.medium, false)).resolves.toMatchObject({
      status: "running",
    });
    expect(pool.allocatedCpu()).toBe(2);
  });

  it("does not resize an already matching workspace on every redeploy", async () => {
    const pool = cloudPool();
    const workspace = pool.add("existing", 0.25, 256);
    await pool.deploy("existing");
    expect(workspace.resources.update).not.toHaveBeenCalled();
  });

  it("keeps the disk and refuses success when the provider saves but does not apply the resize", async () => {
    const pool = cloudPool();
    const workspace = pool.add("existing");
    workspace.resources.update.mockResolvedValue({ success: true, relaunched: false });
    await expect(pool.deploy("existing")).rejects.toThrow(/pending verification/i);
    expect(workspace.delete).not.toHaveBeenCalled();
    expect(pool.create).not.toHaveBeenCalled();
    expect(workspace.workloads.create).not.toHaveBeenCalled();
    expect(pool.allocatedCpu()).toBe(1);
  });

  it("verifies the resulting allocation instead of trusting an unchanged success response", async () => {
    const pool = cloudPool();
    const workspace = pool.add("existing");
    workspace.resources.update.mockResolvedValue({ success: true, relaunched: true });
    await expect(pool.deploy("existing")).rejects.toThrow(/allocation.*not.*applied/i);
    expect(workspace.delete).not.toHaveBeenCalled();
    expect(pool.allocatedCpu()).toBe(1);
  });

  it("rejects a different namespace before changing the workspace", async () => {
    const pool = cloudPool();
    const workspace = pool.add("existing");
    workspace.get.mockResolvedValue({
      id: "existing",
      namespace: "other-customer",
      status: "active",
      resources: workspace.allocation,
    });
    await expect(pool.deploy("existing")).rejects.toThrow(/namespace/i);
    expect(workspace.resources.update).not.toHaveBeenCalled();
    expect(workspace.delete).not.toHaveBeenCalled();
  });
});
