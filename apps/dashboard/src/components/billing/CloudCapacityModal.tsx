"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Icon } from "@repo/ui/icons";
import { cloudAllocationShortfalls, formatCpuCores, formatMemoryMb, MIN_CPU_CORES, MIN_MEMORY_MB } from "@repo/core";
import type {
  CloudCapacityEdit,
  CloudCapacityOverview,
  CloudCapacityPreview,
  DeploymentBuildStatus,
} from "@repo/contracts";
import { useI18n } from "@/components/i18n-provider";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { billingApi } from "@/lib/api/billing";
import { deployApi } from "@/lib/api/deploy";
import { projectsApi } from "@/lib/api/projects";
import { getApiErrorMessage } from "@/lib/api/client";
import { randomUUID } from "@/lib/random-uuid";
import type { CloudCapacityRestriction } from "@/lib/cloud-deploy-pricing";

export function CloudCapacityModal({
  restriction,
  onClose,
  onRetry,
}: {
  restriction?: CloudCapacityRestriction;
  onClose: () => void;
  onRetry?: () => Promise<unknown>;
}) {
  const { t } = useI18n();
  const copy = t.billing.capacityEditor;
  const titleId = useId();
  const { dialog, onKeyDown } = useDialogFocus(onClose);
  const mounted = useRef(false);
  const busy = useRef(false);
  const [overview, setOverview] = useState<CloudCapacityOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, { cpu: string; memory: string }>>({});
  const [preview, setPreview] = useState<CloudCapacityPreview | null>(null);
  const pending = useRef<
    (CloudCapacityEdit & { idempotencyKey: string; confirmRestart: true }) | null
  >(null);
  const [operation, setOperation] = useState<{
    deploymentId: string;
    projectId: string;
    after: CloudCapacityPreview["after"];
  } | null>(null);
  const [operationState, setOperationState] = useState<
    "running" | "verifying" | "complete" | "failed" | "timeout"
  >("running");
  const [pollVersion, setPollVersion] = useState(0);
  const [buildResources, setBuildResources] = useState(restriction?.buildResources);
  const [buildMode, setBuildMode] = useState(restriction?.buildMode);
  const [buildEdit, setBuildEdit] = useState<{ cpu: string; memory: string; diskMb: number; automatic: boolean } | null>(null);
  const [requestChanged, setRequestChanged] = useState(false);

  const refresh = useCallback(
    async (failedProjectId?: string) => {
      if (busy.current) return;
      busy.current = true;
      setLoading(true);
      setError(null);
      try {
        const data = await billingApi.getCapacity();
        if (mounted.current) {
          setOverview(data);
          setPreview(null);
          pending.current = null;
          setSelected(null);
          const failedProject = data.projects.find((p) => p.id === failedProjectId);
          if (
            failedProjectId &&
            !failedProject?.activeAdjustmentId &&
            failedProject?.unavailableReason !== "busy"
          )
            setOperation(null);
        }
      } catch (e) {
        if (mounted.current) setError(getApiErrorMessage(e, copy.loadError));
      } finally {
        busy.current = false;
        if (mounted.current) setLoading(false);
      }
    },
    [copy.loadError],
  );

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  // One bounded, sequential poll. Navigating away stops all future reads; it
  // never cancels a durable deployment or starts another resource adjustment.
  useEffect(() => {
    if (!operation) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + 5 * 60_000;
    const check = async () => {
      try {
        const status: DeploymentBuildStatus = await deployApi.getBuildStatus(
          operation.deploymentId,
        );
        if (disposed) return;
        const deploymentStatus = status.deploymentStatus ?? status.status;
        if (
          ["failed", "cancelled", "partial_failure", "action_required", "no_changes"].includes(
            deploymentStatus,
          )
        ) {
          setOperationState("failed");
          setError(status.errorMessage || copy.failed);
          return;
        }
        if (deploymentStatus === "ready") {
          setOperationState("verifying");
          const fresh = await billingApi.getCapacity();
          if (disposed) return;
          setOverview(fresh);
          const project = fresh.projects.find((p) => p.id === operation.projectId);
          const allocation = project?.allocation;
          if (
            allocation &&
            !status.completionPending &&
            !project.activeAdjustmentId &&
            project.unavailableReason !== "busy" &&
            Math.abs(allocation.cpuCores - operation.after.cpuCores) < 1e-9 &&
            allocation.memoryMb === operation.after.memoryMb &&
            allocation.diskMb >= operation.after.diskMb
          ) {
            setOperationState("complete");
            setSelected(null);
            setPreview(null);
            setError(null);
            if (operation.projectId === restriction?.projectId) setRequestChanged(true);
            return;
          }
        }
      } catch (e) {
        if (disposed) return;
        // An interrupted read is not proof that the operation failed. Preserve
        // the operation ID, show the error, and permit checking the same run.
        setError(getApiErrorMessage(e, copy.loadError));
      }
      if (Date.now() >= deadline) {
        setOperationState("timeout");
        return;
      }
      if (!disposed) timer = setTimeout(check, 5000);
    };
    void check();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [operation, pollVersion, copy.failed, copy.loadError, restriction?.projectId]);

  const working = !!operation && ["running", "verifying"].includes(operationState);
  const unsettled = working || (!!operation && operationState === "timeout");
  const project = overview?.projects.find((p) => p.id === selected);
  const shortfalls =
    overview && restriction?.requested && restriction.scope !== "workspace" && !requestChanged
      ? cloudAllocationShortfalls(
          overview.pool,
          restriction.requested,
          restriction.reusesWorkspace
            ? overview.projects.find((p) => p.id === restriction.projectId)?.allocation
            : undefined,
          restriction.additionalWorkspaces,
        )
      : [];
  const canRetry =
    !loading &&
    !working &&
    !buildEdit &&
    overview &&
    shortfalls.length === 0 &&
    (!operation || operationState === "complete");

  async function editBuild() {
    if (!restriction || busy.current || unsettled) return;
    busy.current = true;
    setLoading(true);
    setError(null);
    try {
      const { data } = await projectsApi.getResources(restriction.projectId);
      if (!data.requiresLimit) throw new Error(copy.buildUnavailable);
      if (mounted.current) {
        setBuildResources(data.build);
        setBuildMode(data.buildMode);
        setBuildEdit({ cpu: String(data.build.cpuCores || buildResources?.cpuCores || MIN_CPU_CORES),
          memory: String(data.build.memoryMb || buildResources?.memoryMb || MIN_MEMORY_MB),
          diskMb: data.build.diskMb, automatic: data.buildMode === "automatic" });
        setSelected(null);
        setPreview(null);
        pending.current = null;
      }
    } catch (e) {
      if (mounted.current) setError(getApiErrorMessage(e, copy.loadError));
    } finally {
      busy.current = false;
      if (mounted.current) setLoading(false);
    }
  }

  async function saveBuild() {
    if (!restriction || !buildEdit || busy.current || unsettled) return;
    const cpuCores = Number(buildEdit.cpu);
    const memoryMb = Number(buildEdit.memory);
    if (!buildEdit.automatic && (!Number.isFinite(cpuCores) || cpuCores < MIN_CPU_CORES || !Number.isInteger(memoryMb) || memoryMb < MIN_MEMORY_MB)) {
      setError(copy.buildInvalid);
      return;
    }
    busy.current = true;
    setLoading(true);
    setError(null);
    try {
      const { data } = await projectsApi.updateResources(restriction.projectId, {
        // Preserve the saved disk and every production setting. This config
        // applies to the next build; it does not resize a live workspace.
        build: buildEdit.automatic ? null : { cpuCores, memoryMb, diskMb: buildEdit.diskMb },
      });
      if (!mounted.current) return;
      setBuildResources(data.build);
      setBuildMode(data.buildMode);
      setBuildEdit(null);
      setRequestChanged(true);
      setSelected(null);
      setPreview(null);
      pending.current = null;
      // A new project revision invalidates any old runtime adjustment preview.
      const fresh = await billingApi.getCapacity();
      if (mounted.current) setOverview(fresh);
    } catch (e) {
      if (mounted.current) setError(getApiErrorMessage(e, copy.buildSaveError));
    } finally {
      busy.current = false;
      if (mounted.current) setLoading(false);
    }
  }

  function choose(projectId: string) {
    const row = overview?.projects.find((p) => p.id === projectId);
    if (!row?.editable || busy.current || unsettled) return;
    setSelected(projectId);
    setPreview(null);
    setError(null);
    pending.current = null;
    setEdits(
      Object.fromEntries(
        row.services.map((s) => [
          s.id,
          { cpu: String(s.resources.cpuCores), memory: String(s.resources.memoryMb) },
        ]),
      ),
    );
    if (operation) setOperation(null);
  }

  async function review() {
    if (!project || busy.current) return;
    busy.current = true;
    setLoading(true);
    setError(null);
    try {
      const input: CloudCapacityEdit = {
        projectId: project.id,
        revision: project.revision,
        services: project.services.map((s) => ({
          serviceId: s.id,
          cpuCores: Number(edits[s.id]?.cpu),
          memoryMb: Number(edits[s.id]?.memory),
        })),
      };
      const next = await billingApi.previewCapacity(input);
      if (mounted.current) {
        setPreview(next);
        pending.current = { ...input, idempotencyKey: randomUUID(), confirmRestart: true };
      }
    } catch (e) {
      if (mounted.current) setError(getApiErrorMessage(e, copy.loadError));
    } finally {
      busy.current = false;
      if (mounted.current) setLoading(false);
    }
  }

  async function apply() {
    if (!pending.current || !preview || busy.current) return;
    busy.current = true;
    setLoading(true);
    setError(null);
    try {
      const result = await billingApi.applyCapacity(pending.current);
      if (mounted.current) {
        setOperationState("running");
        setOperation({ ...result, after: preview.after });
      }
    } catch (e) {
      if (mounted.current) setError(getApiErrorMessage(e, copy.applyError));
    } finally {
      busy.current = false;
      if (mounted.current) setLoading(false);
    }
  }

  async function retry() {
    if (!onRetry || busy.current || !canRetry) return;
    busy.current = true;
    setLoading(true);
    setError(null);
    try {
      await onRetry();
      if (mounted.current) onClose();
    } catch (e) {
      if (mounted.current) setError(getApiErrorMessage(e, copy.retryError));
    } finally {
      busy.current = false;
      if (mounted.current) setLoading(false);
    }
  }

  // The general resource formatter treats zero as "unlimited". Here it means
  // an empty measured pool, so keep its numeric meaning.
  const cpu = (value: number) => (value === 0 ? "0 vCPU" : formatCpuCores(value));
  const memory = (value: number) => (value === 0 ? "0 MB" : formatMemoryMb(value));
  const size = (allocation: CloudCapacityPreview["after"]) =>
    `${cpu(allocation.cpuCores)} · ${memory(allocation.memoryMb)}`;
  const reason = (key: string | null) =>
    key && Object.hasOwn(copy.unavailable, key)
      ? copy.unavailable[key as keyof typeof copy.unavailable]
      : copy.unavailable.unverified;

  return (
    <div
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex max-h-[calc(100dvh-2rem)] min-h-0 flex-col outline-none"
    >
      <header className="flex shrink-0 items-center justify-between gap-3 px-5 py-3">
        <h2 id={titleId} className="text-lg font-semibold tracking-tight">
          {copy.title}
        </h2>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label={copy.close}>
          <Icon name="close" className="size-4" />
        </Button>
      </header>
      <div className="min-h-0 space-y-5 overflow-y-auto overscroll-contain px-5 pb-5">
        <p className="text-sm text-muted-foreground">
          {(!requestChanged && restriction?.message) || copy.description}
        </p>
        {error && (
          <p role="alert" className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </p>
        )}
        {loading && !overview && (
          <p role="status" className="py-8 text-center text-sm text-muted-foreground">
            {copy.loading}
          </p>
        )}
        {overview && (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {(["cpuCores", "memoryMb", "diskMb"] as const).map((dimension) => {
                const meter = overview.pool[dimension];
                const format = dimension === "cpuCores" ? cpu : memory;
                return (
                  <div key={dimension} className="rounded-xl bg-muted/50 p-3">
                    <p className="text-xs text-muted-foreground">{copy[dimension]}</p>
                    <p className="mt-1 text-sm font-medium">
                      {format(meter.used)}
                      {meter.max !== null && ` / ${format(meter.max)}`}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">{copy.allocated}</p>
                  </div>
                );
              })}
            </div>
            {requestChanged ? (
              <p role="status" className="text-sm text-muted-foreground">{copy.requestChanged}</p>
            ) : restriction?.requested && (
              <p className="text-sm">
                <span className="text-muted-foreground">{copy.requested}: </span>
                {size(restriction.requested)} · {memory(restriction.requested.diskMb)} {copy.diskMb}
              </p>
            )}
            {shortfalls.length > 0 && (
              <p role="status" className="text-sm text-muted-foreground">
                {copy.needCapacity}{" "}
                {shortfalls
                  .map((s) =>
                    s.dimension === "workspaces"
                      ? `${s.missing} ${copy.workspaces}`
                      : s.dimension === "cpuCores"
                        ? cpu(s.missing)
                        : memory(s.missing),
                  )
                  .join(" · ")}
              </p>
            )}
            {buildResources ? (
              <section className="space-y-3 rounded-xl bg-muted/30 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-medium">{copy.build}</h3>
                    <p className="text-xs text-muted-foreground">{buildMode === "automatic" ? copy.automaticBuild : size(buildResources)}</p>
                  </div>
                  {!buildEdit && (
                    <Button variant="secondary" size="sm" disabled={loading || unsettled} onClick={() => void editBuild()}>
                      {copy.editBuild}
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">{copy.buildDescription}</p>
                {buildEdit && (
                  <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void saveBuild(); }}>
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" size="sm" variant={buildEdit.automatic ? "default" : "secondary"}
                        aria-pressed={buildEdit.automatic} disabled={loading || unsettled}
                        onClick={() => setBuildEdit({ ...buildEdit, automatic: true })}>{copy.automaticBuild}</Button>
                      <Button type="button" size="sm" variant={!buildEdit.automatic ? "default" : "secondary"}
                        aria-pressed={!buildEdit.automatic} disabled={loading || unsettled}
                        onClick={() => setBuildEdit({ ...buildEdit, automatic: false })}>{copy.customBuildLimit}</Button>
                    </div>
                    {!buildEdit.automatic && <div className="grid grid-cols-2 gap-3">
                      <ResourceFields
                        name={copy.build}
                        value={buildEdit}
                        onChange={(value) => setBuildEdit({ ...buildEdit, ...value })}
                        disabled={loading || unsettled}
                      />
                    </div>}
                    <div className="flex justify-end gap-2">
                      <Button type="button" variant="ghost" disabled={loading} onClick={() => setBuildEdit(null)}>{copy.cancel}</Button>
                      <Button type="submit" variant="secondary" disabled={loading || unsettled}>{copy.saveBuild}</Button>
                    </div>
                  </form>
                )}
              </section>
            ) : buildResources === null && (
              <p className="text-xs text-muted-foreground">{copy.imageOnly}</p>
            )}
            {operation && (
              <div
                role="status"
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-muted/40 p-3 text-sm"
              >
                <span>{copy[operationState]}</span>
                <a
                  className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                  href={`/build/${operation.deploymentId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {copy.logs}
                  <Icon name="arrow-up-right" className="size-4" />
                </a>
              </div>
            )}
            {preview && !operation ? (
              <section className="space-y-4 rounded-xl bg-muted/30 p-4">
                <h3 className="text-sm font-semibold">{preview.projectName}</h3>
                <p className="text-sm">
                  {size(preview.before)} <span aria-hidden="true">→</span> {size(preview.after)}
                </p>
                <p className="text-sm text-muted-foreground">{copy.restartNotice}</p>
                <ul className="flex flex-wrap gap-2" aria-label={copy.affected}>
                  {preview.restartServices.map((name) => (
                    <li key={name} className="rounded-lg bg-muted px-3 py-1 text-sm">
                      {name}
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-muted-foreground">{copy.preserved}</p>
              </section>
            ) : (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold">{copy.projects}</h3>
                {overview.projects.length === 0 && (
                  <p className="text-sm text-muted-foreground">{copy.empty}</p>
                )}
                {overview.projects.map((row) => (
                  <section key={row.id} className="rounded-xl bg-muted/30 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{row.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {row.allocation ? size(row.allocation) : copy.noAllocation}
                        </p>
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={!row.editable || unsettled || loading || !!buildEdit}
                        onClick={() => choose(row.id)}
                      >
                        {copy.adjust}
                      </Button>
                    </div>
                    {!row.editable && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        {reason(row.unavailableReason)}
                      </p>
                    )}
                    {selected === row.id && !operation && (
                      <form
                        className="mt-4 space-y-3"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void review();
                        }}
                      >
                        {row.services.map((service) => (
                          <div
                            key={service.id}
                            className="grid grid-cols-2 items-end gap-3 sm:grid-cols-[minmax(0,1fr)_8rem_10rem]"
                          >
                            <span className="col-span-2 pb-2 text-sm sm:col-span-1">
                              {service.name}
                            </span>
                            <ResourceFields
                              name={service.name}
                              value={edits[service.id] ?? { cpu: "", memory: "" }}
                              onChange={(value) => setEdits((prev) => ({ ...prev, [service.id]: value }))}
                              disabled={loading}
                              limit={overview.serviceLimit ?? undefined}
                            />
                          </div>
                        ))}
                        <div className="flex justify-end">
                          <Button type="submit" variant="secondary" disabled={loading}>
                            {copy.review}
                          </Button>
                        </div>
                      </form>
                    )}
                  </section>
                ))}
              </div>
            )}
            <p className="text-xs text-muted-foreground">{copy.allocationNote}</p>
          </>
        )}
        <a
          className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
          href="/billing/plans"
          target="_blank"
          rel="noopener noreferrer"
        >
          {copy.plans}
          <Icon name="arrow-up-right" className="size-4" />
        </a>
      </div>
      <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border/40 px-5 py-3">
        {preview && !operation ? (
          <>
            <Button
              variant="ghost"
              disabled={loading}
              onClick={() => {
                setPreview(null);
                pending.current = null;
              }}
            >
              {copy.back}
            </Button>
            <Button disabled={loading} onClick={() => void apply()}>
              {loading ? copy.applying : copy.confirm}
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="secondary"
              disabled={loading || working}
              onClick={() => {
                if (operation && operationState === "timeout") {
                  setOperationState("running");
                  setPollVersion((n) => n + 1);
                } else void refresh(operationState === "failed" ? operation?.projectId : undefined);
              }}
            >
              <Icon name="refresh" className={`size-4 ${loading ? "animate-spin" : ""}`} />
              {copy.check}
            </Button>
            {onRetry && restriction && (
              <Button disabled={!canRetry} onClick={() => void retry()}>
                {copy.retryDeploy}
              </Button>
            )}
            <Button variant="ghost" onClick={onClose}>
              {copy.close}
            </Button>
          </>
        )}
      </footer>
    </div>
  );
}

/** Build and runtime edits use the same units, controls and accessibility. */
function ResourceFields({ name, value, onChange, disabled, limit }: {
  name: string;
  value: { cpu: string; memory: string };
  onChange: (value: { cpu: string; memory: string }) => void;
  disabled: boolean;
  limit?: { cpuCores: number; memoryMb: number };
}) {
  const { t } = useI18n();
  const copy = t.billing.capacityEditor;
  return ([
    { key: "cpu", label: copy.cpuCores, unit: "vCPU", min: 0.25, step: 0.25, max: limit?.cpuCores },
    { key: "memory", label: copy.memoryMb, unit: "MB", min: 128, step: 1, max: limit?.memoryMb },
  ] as const).map((field) => (
    <label key={field.key} className="space-y-1 text-xs text-muted-foreground">
      <span>{field.label} ({field.unit})</span>
      <Input
        type="number"
        variant="filled"
        min={field.min}
        max={field.max}
        step={field.step}
        required
        disabled={disabled}
        aria-label={`${name} ${field.label}`}
        value={value[field.key]}
        onChange={(event) => onChange({ ...value, [field.key]: event.target.value })}
      />
    </label>
  ));
}
