import {
  AppError,
  MIN_CPU_CORES,
  MIN_MEMORY_MB,
  cloudAllocationShortfalls,
  type CloudAllocation,
} from "@repo/core";
import { OperationError } from "@repo/contracts";
import { DEFAULT_BUILD_RESOURCE_CONFIG, type ResourceConfig } from "@repo/adapters";
import { repos, type Project } from "@repo/db";
import { env } from "../../config/env";
import { listActiveServiceDeployments } from "../../lib/active-deployment";
import { cloudCapacityRequired, readCloudWorkspaceAllocation } from "../../lib/cloud-capacity";
import { readCloudBuildCapacity } from "../../lib/cloud-resource-limits";
import {
  cloudDockerResources,
  cloudServiceNeedsBuild,
  resolveCloudServiceResources,
  resolveRuntimeResources,
  withDefaults,
  type CloudServiceResourceInput,
} from "../../lib/resources";
import type { DeploymentConfigSnapshot } from "./build.service";
import { snapshotToClass } from "./deployment-class";
import { strictRefreshImages } from "./pinned-artifacts";

type Capacity = Awaited<ReturnType<typeof readCloudBuildCapacity>>;
const dimensions = ["cpuCores", "memoryMb", "diskMb"] as const;
const zero = (): CloudAllocation => ({ cpuCores: 0, memoryMb: 0, diskMb: 0 });
const remaining = (value: { used: number; max: number | null }) =>
  Math.max(0, (value.max ?? Infinity) - value.used);

export interface CloudBuildAllocation {
  build: ResourceConfig;
  /** Each source service must use its checked allocation. Native builds run
   * concurrently; shared Docker builds reuse one budget sequentially. */
  services?: Record<string, ResourceConfig>;
  /** Shared Docker host, including protected runtime capacity and overhead. */
  workspace?: ResourceConfig;
}

/** Divide only verified headroom. Runtime reservations are lower bounds;
 * optional build limits are ceilings, never another reservation or pool. */
function distribute(
  available: number,
  floors: number[],
  ceilings: number[],
  quantum: number,
): number[] {
  const values = [...floors];
  let left = available - values.reduce((sum, value) => sum + value, 0);
  let active = values.map((_, i) => i).filter((i) => ceilings[i]! > values[i]!);
  while (left > 1e-9 && active.length) {
    const share = Math.min(left / active.length, ...active.map((i) => ceilings[i]! - values[i]!));
    if (!Number.isFinite(share))
      throw new AppError(
        "Cloud did not report a finite build capacity. Set a build limit or retry when capacity is available.",
        503,
        "CLOUD_CAPACITY_UNAVAILABLE",
      );
    for (const i of active) values[i]! += share;
    left -= share * active.length;
    active = active.filter((i) => ceilings[i]! - values[i]! > 1e-9);
  }
  return values.map((value) => Math.floor((value + 1e-9) / quantum) * quantum);
}

export function allocateCloudBuildResources(input: {
  projectId: string;
  capacity: Capacity;
  configured?: ResourceConfig | Record<string, unknown> | null;
  /** One slot for a shared builder, or one per concurrently built native service. */
  slots: Array<{ name: string; runtime: CloudAllocation }>;
  /** Capacity needed alongside the builders (Docker runtime, or image services). */
  reserved?: CloudAllocation;
  existing?: CloudAllocation;
  additionalWorkspaces: number;
  docker?: boolean;
}): CloudBuildAllocation {
  const { pool, workspace: maximum } = input.capacity;
  const reserved = input.reserved ?? zero();
  const existing = input.existing ?? zero();
  const configured = withDefaults(input.configured, {
    cpuCores: 0,
    memoryMb: 0,
    diskMb: DEFAULT_BUILD_RESOURCE_CONFIG.diskMb,
  });
  const caps = {
    cpuCores: configured.cpuCores > 0 ? configured.cpuCores : Infinity,
    memoryMb: configured.memoryMb > 0 ? configured.memoryMb : Infinity,
  };
  const memoryStep = input.docker ? 256 : 1;
  const minimums = input.slots.map((slot) => ({
    cpuCores: Math.max(MIN_CPU_CORES, slot.runtime.cpuCores),
    memoryMb: Math.ceil(Math.max(MIN_MEMORY_MB, slot.runtime.memoryMb) / memoryStep) * memoryStep,
    diskMb: Math.max(
      configured.diskMb || DEFAULT_BUILD_RESOURCE_CONFIG.diskMb,
      slot.runtime.diskMb,
    ),
  }));
  const total = (builders: CloudAllocation[]): CloudAllocation => ({
    cpuCores: reserved.cpuCores + builders.reduce((n, r) => n + r.cpuCores, 0),
    memoryMb: reserved.memoryMb + builders.reduce((n, r) => n + r.memoryMb, 0),
    diskMb: input.docker
      ? Math.max(reserved.diskMb, ...builders.map((r) => r.diskMb))
      : reserved.diskMb + builders.reduce((n, r) => n + r.diskMb, 0),
  });
  const minimumRequest = total(minimums);
  const minimumBuilder = {
    cpuCores: MIN_CPU_CORES,
    memoryMb: Math.max(MIN_MEMORY_MB, memoryStep),
    diskMb: configured.diskMb || DEFAULT_BUILD_RESOURCE_CONFIG.diskMb,
  };
  const buildMode = input.configured ? ("custom" as const) : ("automatic" as const);
  const workspaceRequests = input.docker ? [minimumRequest] : minimums;
  if (
    workspaceRequests.some((request) =>
      dimensions.some((d) => maximum[d] !== null && request[d] > maximum[d]!),
    )
  ) {
    throw new OperationError(
      "The Cloud workspace has no room for this runtime and a build. Adjust resources or choose a larger plan.",
      409,
      "CLOUD_CAPACITY_REQUIRED",
      {
        projectId: input.projectId,
        capacity: {
          requested: minimumRequest,
          buildResources: minimumBuilder,
          buildMode,
          scope: "workspace",
        },
      },
    );
  }
  if (
    cloudAllocationShortfalls(pool, minimumRequest, input.existing, input.additionalWorkspaces)
      .length
  ) {
    throw cloudCapacityRequired({
      projectId: input.projectId,
      pool,
      requested: minimumRequest,
      existing: input.existing,
      additionalWorkspaces: input.additionalWorkspaces,
      buildResources: minimumBuilder,
      buildMode,
    });
  }
  const values = (dimension: "cpuCores" | "memoryMb", quantum: number) => {
    const available = remaining(pool[dimension]) + existing[dimension] - reserved[dimension];
    const maximumBuilder = Math.max(
      0,
      (maximum[dimension] ?? Infinity) - (input.docker ? reserved[dimension] : 0),
    );
    return distribute(
      available,
      minimums.map((r) => r[dimension]),
      minimums.map((r) => Math.max(r[dimension], Math.min(caps[dimension], maximumBuilder))),
      quantum,
    );
  };
  const cpus = values("cpuCores", 0.000001);
  const memory = values("memoryMb", memoryStep);
  const allocations = minimums.map((r, i) => ({
    ...r,
    cpuCores: Math.min(cpus[i]!, caps.cpuCores),
    memoryMb: Math.min(memory[i]!, caps.memoryMb),
  }));
  // A smaller explicit cap can build below its eventual runtime allocation.
  // The minimum request above still ensures the runtime fits after activation.
  const requested = total(
    allocations.map((r, i) => ({
      ...r,
      cpuCores: Math.max(r.cpuCores, minimums[i]!.cpuCores),
      memoryMb: Math.max(r.memoryMb, minimums[i]!.memoryMb),
    })),
  );
  if (input.docker) return { build: allocations[0]!, workspace: requested };
  return {
    build: allocations[0]!,
    services: Object.fromEntries(input.slots.map((slot, i) => [slot.name, allocations[i]!])),
  };
}

/** Read Oblien again at worker start; a queue-time preview is not a reservation.
 * The provider remains the final atomic authority when deployments race. */
export async function prepareCloudBuildResources(input: {
  project: Project;
  snapshot: DeploymentConfigSnapshot;
  services?: CloudServiceResourceInput[];
  dockerWorkspace: boolean;
}): Promise<CloudBuildAllocation | undefined> {
  if (env.CLOUD_MODE !== true) return;
  const { project, snapshot } = input;
  const retained = strictRefreshImages(snapshot);
  let selected = input.services?.filter((service) => service.enabled !== false);
  if (selected && (snapshot.targetServiceIds?.length || snapshot.refreshServiceIds?.length)) {
    const rows = await repos.service.listByProject(project.id);
    const selectedNames = new Set(
      rows
        .filter(
          (row) =>
            (!snapshot.targetServiceIds?.length || snapshot.targetServiceIds.includes(row.id)) &&
            !snapshot.refreshServiceIds?.includes(row.id),
        )
        .map((row) => row.name),
    );
    selected = selected.filter((service) => service.name && selectedNames.has(service.name));
  }
  const sources = selected?.filter((service) => cloudServiceNeedsBuild(service, retained));
  if (sources ? sources.length === 0 : snapshot.refreshAppDeploymentId || snapshot.releaseImageRef)
    return;
  const org = await repos.organization.findById(project.organizationId);
  if (!org?.oblienNamespace)
    throw new AppError("Connect Cloud before starting a build.", 503, "CLOUD_NOT_CONNECTED");
  const namespace = org.oblienNamespace;
  const binding = input.dockerWorkspace
    ? await repos.cloudDockerWorkspace.find(project.id, project.organizationId)
    : null;
  if (binding && binding.namespace !== namespace)
    throw new AppError("Cloud workspace ownership changed", 409, "CLOUD_NAMESPACE_MISMATCH");
  const workspaceId =
    binding?.workspaceId ??
    (!input.dockerWorkspace && !sources ? snapshot.uploadWorkspaceId : undefined);
  const existing = workspaceId
    ? (await readCloudWorkspaceAllocation(workspaceId, namespace)).allocation
    : undefined;
  let reserved = zero();
  let additionalWorkspaces = existing ? 0 : 1;
  let slots: Array<{ name: string; runtime: CloudAllocation }>;
  if (input.dockerWorkspace) {
    const runtime = cloudDockerResources({
      resources: snapshot.resources,
      services: (input.services ?? []).map((service) => ({
        enabled: service.enabled,
        resources: service.advanced?.resources,
      })),
    });
    // A smaller pending runtime configuration has not released anything yet.
    reserved = {
      cpuCores: Math.max(runtime.cpuCores, existing?.cpuCores ?? 0),
      memoryMb: Math.max(runtime.memoryMb, existing?.memoryMb ?? 0),
      diskMb: Math.max(runtime.diskMb, existing?.diskMb ?? 0),
    };
    slots = [{ name: "build", runtime: zero() }];
  } else if (sources) {
    slots = sources.map((service) => ({
      name: service.name!,
      runtime: resolveCloudServiceResources(service.advanced?.resources, snapshot.resources),
    }));
    additionalWorkspaces = sources.length;
    const previous = await listActiveServiceDeployments(project);
    for (const service of selected ?? []) {
      if (sources.includes(service)) continue;
      const desired = resolveCloudServiceResources(service.advanced?.resources, snapshot.resources);
      const prior = previous.find((row) => row.serviceName === service.name && row.containerId);
      const allocation = prior?.containerId
        ? (await readCloudWorkspaceAllocation(prior.containerId, namespace)).allocation
        : undefined;
      // Image workspaces are reused; reserve only increases, without crediting
      // an unrelated decrease until Oblien confirms it actually happened.
      for (const d of dimensions) reserved[d] += Math.max(0, desired[d] - (allocation?.[d] ?? 0));
      if (!allocation) additionalWorkspaces++;
    }
  } else {
    slots = [
      {
        name: "build",
        runtime:
          snapshotToClass(snapshot).workload === "static"
            ? zero()
            : resolveRuntimeResources(snapshot.resources, { isCloud: true }),
      },
    ];
  }
  const capacity = await readCloudBuildCapacity(namespace);
  const allocation = allocateCloudBuildResources({
    projectId: project.id,
    capacity,
    configured: snapshot.buildResources,
    slots,
    reserved,
    existing,
    additionalWorkspaces,
    docker: input.dockerWorkspace,
  });
  if (input.dockerWorkspace && sources) {
    allocation.services = Object.fromEntries(
      sources.map((service) => [service.name!, allocation.build]),
    );
  }
  return allocation;
}
