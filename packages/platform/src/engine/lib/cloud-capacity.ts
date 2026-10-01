import {
  AppError,
  cloudAllocationShortfalls,
  type CloudAllocation,
  type CloudCapacityPool,
} from "@repo/core";
import { OperationError } from "@repo/contracts";
import { repos } from "@repo/db";
import { env } from "../config/env";
import { getOblienClient } from "./oblien-client";
import { readCloudCapacityPool } from "./cloud-resource-limits";
import { z } from "zod";

const workspaceResources = z.object({
  cpus: z.number().finite().positive(),
  memory_mb: z.number().int().positive(),
  disk_size_mb: z.number().int().positive(),
});

/** One ownership/shape check for both previews and deployment admission. */
export async function readCloudWorkspaceAllocation(workspaceId: string, namespace: string) {
  const workspace = await getOblienClient().workspaces.get(workspaceId);
  if (workspace.id !== workspaceId || workspace.namespace !== namespace) {
    throw new AppError("Cloud workspace ownership changed", 409, "CLOUD_NAMESPACE_MISMATCH");
  }
  const parsed = workspaceResources.safeParse(workspace.resources);
  if (!parsed.success)
    throw new AppError(
      "Cloud workspace allocation could not be verified",
      503,
      "CLOUD_CAPACITY_UNAVAILABLE",
    );
  const resources = parsed.data;
  return {
    workspace,
    allocation: {
      cpuCores: resources.cpus,
      memoryMb: resources.memory_mb,
      diskMb: resources.disk_size_mb,
    },
  };
}

export function cloudCapacityRequired(input: {
  projectId: string;
  pool: CloudCapacityPool;
  requested: CloudAllocation;
  existing?: CloudAllocation | null;
  additionalWorkspaces?: number;
  /** Null means this deployment uses only existing images. */
  buildResources?: CloudAllocation | null;
  buildMode?: "automatic" | "custom";
}) {
  const shortfalls = cloudAllocationShortfalls(input.pool, input.requested, input.existing, input.additionalWorkspaces);
  return new OperationError(
    "Your Cloud resource pool does not have enough available capacity. Adjust project allocations or choose a larger plan.",
    409,
    "CLOUD_CAPACITY_REQUIRED",
    {
      projectId: input.projectId,
      capacity: { ...input, shortfalls },
    },
  );
}

/** Advisory admission before queueing, repeated before provisioning. Oblien's
 * atomic reservation remains authoritative if measurements are unavailable or
 * another deployment wins the race. Explicit edits require verified reads. */
export async function assertCloudWorkspaceCapacity(input: {
  organizationId: string;
  projectId: string;
  requested: CloudAllocation;
  buildResources?: CloudAllocation | null;
  /** Only a verified, durable Docker host is resized in place. Native deploys
   * create replacement workspaces and must reserve their full allocation. */
  reuseDockerWorkspace: boolean;
}): Promise<void> {
  if (!env.CLOUD_MODE) return;
  const org = await repos.organization.findById(input.organizationId);
  if (!org?.oblienNamespace) return; // Normal billing/provisioning owns onboarding.
  const binding = input.reuseDockerWorkspace
    ? await repos.cloudDockerWorkspace.find(input.projectId, input.organizationId)
    : null;
  if (binding && binding.namespace !== org.oblienNamespace) {
    throw new AppError("Cloud workspace ownership changed", 409, "CLOUD_NAMESPACE_MISMATCH");
  }
  let existing: CloudAllocation | undefined;
  let pool: CloudCapacityPool;
  try {
    if (binding?.workspaceId) {
      existing = (await readCloudWorkspaceAllocation(binding.workspaceId, org.oblienNamespace))
        .allocation;
    }
    pool = await readCloudCapacityPool(org.oblienNamespace);
  } catch (error) {
    // Do not turn an optional preflight read into a new deployment dependency.
    // Normal provisioning still enforces the quota and reports its own errors;
    // unknown measurements never count as free capacity in the editor.
    if (error instanceof AppError && error.code === "CLOUD_NAMESPACE_MISMATCH") throw error;
    return;
  }
  if (cloudAllocationShortfalls(pool, input.requested, existing).length) {
    throw cloudCapacityRequired({
      projectId: input.projectId,
      pool,
      requested: input.requested,
      existing,
      buildResources: input.buildResources,
    });
  }
}

/** Retain actionable capacity errors across an asynchronous deployment failure.
 * Only an allowlisted provider code enters this recovery; account/fleet failures
 * keep their support diagnosis rather than encouraging an unnecessary upgrade. */
export function cloudCapacityFailure(
  error: unknown,
  projectId: string,
  buildResources?: CloudAllocation | null,
): OperationError | null {
  const seen = new Set<unknown>();
  // Adapter context must not hide an actionable provider refusal. Inspect only
  // typed causes, never parse arbitrary messages or provider response bodies.
  let current = error;
  while (current && typeof current === "object" && seen.size < 8 && !seen.has(current)) {
    seen.add(current);
    if (current instanceof OperationError && (
      current.code === "CLOUD_CAPACITY_REQUIRED" ||
      (current.code === "PLAN_UPGRADE_REQUIRED" && current.details?.capacity)
    )) return current;
    const value = current as { code?: unknown; requestId?: unknown; cause?: unknown };
    if (typeof value.code === "string" && value.code.toUpperCase() === "NAMESPACE_LIMIT_REACHED") {
      return new OperationError(
        "Cloud capacity changed before this deployment could start. Review project allocations and retry.",
        409,
        "CLOUD_CAPACITY_REQUIRED",
        {
          projectId,
          ...(buildResources !== undefined ? { capacity: { buildResources } } : {}),
          ...(typeof value.requestId === "string" && /^[a-f0-9-]{36}$/i.test(value.requestId)
            ? { reference: value.requestId }
            : {}),
        },
      );
    }
    current = value.cause;
  }
  return null;
}
