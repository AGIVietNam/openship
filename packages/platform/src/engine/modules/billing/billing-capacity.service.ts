/** Capacity edits use the ordinary deployment queue, retained images and logs.
 * Provider allocations are authoritative; a queued/ready deployment is not
 * evidence that its host has released resources yet. */
import { createHash } from "node:crypto";
import { AppError, planServiceResources, cloudAllocationShortfalls } from "@repo/core";
import { cloudWorkspaceStatus } from "@repo/adapters";
import { repos, type Project } from "@repo/db";
import type {
  BillingOperations,
  CloudCapacityEdit,
  CloudCapacityProject,
  CloudCapacityPreview,
} from "@repo/contracts";
import type { ExecutionContext } from "../../../context";
import { authorization } from "../../lib/authorization";
import { listAuthorizedProjects } from "../../lib/authorized-projects";
import { readCloudCapacityPool } from "../../lib/cloud-resource-limits";
import { cloudCapacityRequired, readCloudWorkspaceAllocation } from "../../lib/cloud-capacity";
import { withProjectRuntimeLock } from "../../lib/project-runtime-lock";
import { assertResourcesFitPlan, assertWorkspaceResourcesFitPlan } from "../../lib/plan-guard";
import { resolveCloudServiceResources, cloudDockerResources } from "../../lib/resources";
import { syncOblienEntitlement } from "./billing-oblien-quota";
import { projectServicesToDeployableServices } from "../deployments/compose/project-services";
import { effectiveServiceArtifacts } from "../deployments/retained-artifacts";
import { withoutPinnedArtifacts } from "../deployments/pinned-artifacts";
import { triggerDeployment, type DeploymentConfigSnapshot } from "../deployments/build.service";
import { kickoffBuild } from "../deployments/build-pipeline";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function namespaceFor(organizationId: string) {
  const org = await repos.organization.findById(organizationId);
  if (!org?.oblienNamespace)
    throw new AppError(
      "Cloud capacity is not available until this workspace is connected.",
      409,
      "CLOUD_CAPACITY_UNAVAILABLE",
    );
  return org.oblienNamespace;
}

async function inspectProject(ctx: ExecutionContext, project: Project, namespace: string) {
  const [binding, active, services, inFlight] = await Promise.all([
    repos.cloudDockerWorkspace.find(project.id, ctx.organizationId),
    project.activeDeploymentId ? repos.deployment.findById(project.activeDeploymentId) : null,
    repos.service.listByProject(project.id),
    repos.deployment.listInFlightByProject(project.id),
  ]);
  if (active && (active.projectId !== project.id || active.organizationId !== ctx.organizationId)) {
    throw new AppError("Active deployment ownership changed", 409, "CLOUD_NAMESPACE_MISMATCH");
  }
  if (binding && binding.namespace !== namespace)
    throw new AppError("Cloud workspace ownership changed", 409, "CLOUD_NAMESPACE_MISMATCH");
  const workspaceId = binding?.workspaceId ?? project.cloudWorkspaceId;
  const verified = workspaceId
    ? await readCloudWorkspaceAllocation(workspaceId, namespace).catch((error) => {
        // An unreachable or removed workspace must not hide the other projects.
        // Never turn an ownership mismatch into a valid capacity measurement.
        if (error instanceof AppError && error.code === "CLOUD_NAMESPACE_MISMATCH") throw error;
        return null;
      })
    : null;
  const workspace = verified?.workspace;
  const allocation = verified?.allocation ?? null;
  const snapshot = active?.meta as DeploymentConfigSnapshot | null;
  const enabled = services.filter(
    (s) => s.enabled && (s.kind === "compose" || s.kind === "monorepo"),
  );
  const visible = [];
  let canWrite = await authorization.checkPermissionOnResource(ctx, {
    resourceType: "project",
    resourceId: project.id,
    action: "write",
  });
  for (const service of services) {
    if (
      !(await authorization.checkPermissionOnResource(ctx, {
        resourceType: "service",
        resourceId: service.id,
        action: "read",
      }))
    ) {
      canWrite = false;
      continue;
    }
    // A host resize can restart every service, including ones not edited.
    canWrite &&= await authorization.checkPermissionOnResource(ctx, {
      resourceType: "service",
      resourceId: service.id,
      action: "write",
    });
    if (!enabled.includes(service)) continue;
    visible.push({
      id: service.id,
      name: service.name,
      resources: resolveCloudServiceResources(
        service.advanced?.resources,
        snapshot?.resources ?? (project.resources as Record<string, unknown> | null),
      ),
    });
  }
  const reason = !canWrite
    ? "permission"
    : project.deletionInProgress
      ? "deleting"
      : inFlight.length
        ? "busy"
        : !active
          ? "not-deployed"
          : !binding?.workspaceId
            ? "native-workspace"
            : !allocation
              ? "unverified"
              : !workspace || !["active", "running"].includes(cloudWorkspaceStatus(workspace))
                ? "not-running"
                : !enabled.length
                  ? "no-services"
                  : null;
  const revision = digest({
    project: project.id,
    updatedAt: project.updatedAt,
    active: active?.id,
    allocation,
    services: services
      .map((s) => [s.id, s.updatedAt, s.advanced?.resources])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  });
  const publicProject: CloudCapacityProject = {
    id: project.id,
    name: project.name,
    revision,
    allocation,
    services: visible,
    editable: reason === null,
    unavailableReason: reason,
    activeAdjustmentId:
      inFlight.find((d) => (d.meta as DeploymentConfigSnapshot | null)?.capacityAdjustment)?.id ??
      null,
  };
  return {
    project,
    active,
    snapshot,
    enabled,
    allServices: services,
    publicProject,
    restartServiceNames: services.map((s) => s.name),
  };
}

export async function getCapacity(ctx: ExecutionContext) {
  const namespace = await namespaceFor(ctx.organizationId);
  const [pool, owned, plan] = await Promise.all([
    readCloudCapacityPool(namespace),
    listAuthorizedProjects(ctx, ctx.organizationId),
    syncOblienEntitlement(ctx.organizationId, { syncResourceLimits: false }),
  ]);
  const projects: CloudCapacityProject[] = [];
  // Bound provider fan-out; do not query every host in an organization at once.
  for (let i = 0; i < owned.length; i += 4) {
    const inspected = await Promise.all(
      owned.slice(i, i + 4).map((project) => inspectProject(ctx, project, namespace)),
    );
    for (const item of inspected) {
      if (
        item.publicProject.allocation ||
        item.project.cloudWorkspaceId ||
        item.snapshot?.deployTarget === "cloud" ||
        item.project.appTemplateId
      )
        projects.push(item.publicProject);
    }
  }
  return {
    pool,
    projects,
    serviceLimit: planServiceResources(plan.limits),
    measuredAt: new Date().toISOString(),
  };
}

async function prepare(ctx: ExecutionContext, input: CloudCapacityEdit) {
  await authorization.authorize(ctx, {
    resourceType: "project",
    resourceId: input.projectId,
    action: "write",
  });
  const project = await repos.project.findByIdInOrganization(input.projectId, ctx.organizationId);
  if (!project) throw new AppError("Project not found", 404, "PROJECT_NOT_FOUND");
  const namespace = await namespaceFor(ctx.organizationId);
  const state = await inspectProject(ctx, project, namespace);
  if (state.publicProject.revision !== input.revision)
    throw new AppError(
      "The project changed. Refresh capacity and review the adjustment again.",
      409,
      "CLOUD_CAPACITY_CHANGED",
    );
  if (
    !state.publicProject.editable ||
    !state.active ||
    !state.snapshot ||
    !state.publicProject.allocation
  ) {
    throw new AppError(
      "This project cannot be resized here right now. Refresh capacity to see its status.",
      409,
      "CLOUD_CAPACITY_UNAVAILABLE",
    );
  }
  const requested = new Map(input.services.map((s) => [s.serviceId, s]));
  if (
    requested.size !== input.services.length ||
    input.services.some((s) => !state.enabled.some((row) => row.id === s.serviceId))
  ) {
    throw new AppError(
      "Choose each enabled service only once from this project.",
      400,
      "CLOUD_CAPACITY_INVALID",
    );
  }
  let changed = state.publicProject.services.filter((s) => {
    const edit = requested.get(s.id);
    return (
      edit && (edit.cpuCores !== s.resources.cpuCores || edit.memoryMb !== s.resources.memoryMb)
    );
  });
  const plan = await syncOblienEntitlement(ctx.organizationId, { syncResourceLimits: false });
  const services = state.publicProject.services.map((s) => {
    const edit = requested.get(s.id);
    if (!edit) return s;
    assertResourcesFitPlan(plan.tier, edit, plan.limits);
    return {
      ...s,
      resources: { ...s.resources, cpuCores: edit.cpuCores, memoryMb: edit.memoryMb },
    };
  });
  const after = cloudDockerResources({
    reserveBuild: false,
    services: services.map((s) => ({ resources: s.resources })),
  });
  // Filesystems cannot be shrunk. Lower CPU/RAM never promises released disk.
  after.diskMb = Math.max(state.publicProject.allocation.diskMb, after.diskMb);
  assertWorkspaceResourcesFitPlan(plan.tier, after, plan.resourceLimits);
  if (!changed.length) {
    // A previous attempt may have saved the desired limits but failed before
    // applying them. Reapplying must not require changing them a second time.
    if (
      after.cpuCores === state.publicProject.allocation.cpuCores &&
      after.memoryMb === state.publicProject.allocation.memoryMb
    ) {
      throw new AppError(
        "Change at least one service allocation.",
        400,
        "CLOUD_CAPACITY_UNCHANGED",
      );
    }
    changed = state.publicProject.services.filter((s) => requested.has(s.id));
  }
  const pool = await readCloudCapacityPool(namespace);
  if (cloudAllocationShortfalls(pool, after, state.publicProject.allocation).length) {
    throw cloudCapacityRequired({
      projectId: project.id,
      pool,
      requested: after,
      existing: state.publicProject.allocation,
    });
  }
  const preview: CloudCapacityPreview = {
    projectId: project.id,
    projectName: project.name,
    revision: input.revision,
    before: state.publicProject.allocation,
    after,
    services,
    // Resizing the shared host may restart every running service, not just the edits.
    restartServices: state.restartServiceNames,
  };
  return { ...state, active: state.active, snapshot: state.snapshot, preview, changed };
}

export async function previewCapacity(ctx: ExecutionContext, input: CloudCapacityEdit) {
  return (await prepare(ctx, input)).preview;
}

export async function applyCapacity(
  ctx: ExecutionContext,
  input: NonNullable<Parameters<BillingOperations["applyCapacity"]>[0]>,
) {
  await authorization.authorize(ctx, {
    resourceType: "project",
    resourceId: input.projectId,
    action: "write",
  });
  if (input.confirmRestart !== true)
    throw new AppError(
      "Confirm the affected services before applying resources.",
      400,
      "CLOUD_CAPACITY_CONFIRMATION_REQUIRED",
    );
  const requestHash = digest({
    revision: input.revision,
    services: [...input.services].sort((a, b) => a.serviceId.localeCompare(b.serviceId)),
  });
  return withProjectRuntimeLock(input.projectId, async () => {
    const existing = await repos.deployment.findCapacityAdjustment(
      input.projectId,
      ctx.organizationId,
      input.idempotencyKey,
    );
    if (existing) {
      if (
        (existing.meta as DeploymentConfigSnapshot).capacityAdjustment?.requestHash !== requestHash
      ) {
        throw new AppError(
          "This adjustment key was already used for different resources.",
          409,
          "CLOUD_CAPACITY_IDEMPOTENCY_CONFLICT",
        );
      }
      // A process may exit between committing the queue and claiming its
      // worker. Resume the same durable request; kickoff owns the execution CAS.
      if (existing.status === "queued") {
        const project = await repos.project.findByIdInOrganization(
          input.projectId,
          ctx.organizationId,
        );
        if (!project) throw new AppError("Project not found", 404, "PROJECT_NOT_FOUND");
        for (const service of await repos.service.listByProject(project.id)) {
          await authorization.authorize(ctx, {
            resourceType: "service",
            resourceId: service.id,
            action: "write",
          });
        }
        await kickoffBuild(project, existing);
      }
      return { deploymentId: existing.id, projectId: input.projectId };
    }
    const state = await prepare(ctx, input);
    const artifacts = await effectiveServiceArtifacts(
      state.active,
      await repos.service.listByDeployment(state.active.id),
    );
    const handoverImages: Record<string, string> = Object.create(null);
    for (const service of state.enabled) {
      const image = artifacts.find((a) => a.serviceId === service.id)?.imageRef;
      if (!image)
        throw new AppError(
          "An active service image is unavailable. Redeploy the project before adjusting capacity.",
          409,
          "CLOUD_CAPACITY_IMAGE_UNAVAILABLE",
        );
      handoverImages[service.name] = image;
    }
    const targetIds = state.changed.map((s) => s.id);
    const next = new Map(state.preview.services.map((s) => [s.id, s.resources]));
    const composeServices = projectServicesToDeployableServices(
      state.enabled.map((s) => ({ ...s, advanced: { ...s.advanced, resources: next.get(s.id)! } })),
    );
    const meta: DeploymentConfigSnapshot = {
      ...withoutPinnedArtifacts(state.snapshot),
      composeServices,
      handoverImages,
      capacityAdjustment: { key: input.idempotencyKey, requestHash },
    };
    const result = await triggerDeployment(ctx, {
      projectId: state.project.id,
      branch: state.active.branch,
      environment: state.active.environment,
      refresh: true,
      serviceIds: targetIds,
      strictServiceScope: true,
      trigger: "capacity",
      reuseSnapshot: { meta, envVars: state.active.envVars as Record<string, string> | null },
      resourceChanges: {
        expectedActiveDeploymentId: state.active.id,
        expectedProjectUpdatedAt: state.project.updatedAt,
        services: state.allServices.map((s) => ({
          serviceId: s.id,
          expectedResources: s.advanced?.resources,
          expectedUpdatedAt: s.updatedAt,
          ...(targetIds.includes(s.id) ? { resources: next.get(s.id)! } : {}),
        })),
      },
    });
    return { deploymentId: result.deployment.id, projectId: input.projectId };
  });
}
