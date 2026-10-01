// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { baseDictionary } from "@/i18n";
import { CloudCapacityModal } from "./CloudCapacityModal";
import { ApiError } from "@/lib/api/client";
import type { CloudCapacityRestriction } from "@/lib/cloud-deploy-pricing";
const h = vi.hoisted(() => ({
  capacity: vi.fn(),
  preview: vi.fn(),
  apply: vi.fn(),
  status: vi.fn(),
  close: vi.fn(),
  retry: vi.fn(),
  resources: vi.fn(),
  saveResources: vi.fn(),
}));
vi.mock("@/lib/api/billing", () => ({
  billingApi: { getCapacity: h.capacity, previewCapacity: h.preview, applyCapacity: h.apply },
}));
vi.mock("@/lib/api/deploy", () => ({ deployApi: { getBuildStatus: h.status } }));
vi.mock("@/lib/api/projects", () => ({ projectsApi: { getResources: h.resources, updateResources: h.saveResources } }));
const copy = baseDictionary.billing.capacityEditor;
const allocation = { cpuCores: 2, memoryMb: 2560, diskMb: 8192 };
const after = { cpuCores: 1.25, memoryMb: 2048, diskMb: 8192 };
const buildResources = { cpuCores: 1, memoryMb: 2048, diskMb: 32768 };
const resourceView = {
  requiresLimit: true,
  build: buildResources,
  production: { cpuCores: 0.25, memoryMb: 256, diskMb: 20480 },
};
const view = {
  pool: {
    cpuCores: { used: 4, max: 4 },
    memoryMb: { used: 6144, max: 16384 },
    diskMb: { used: 8192, max: 131072 },
    workspaces: { used: 1, max: 6 },
  },
  measuredAt: "2026-09-30T12:00:00Z",
  serviceLimit: { cpuCores: 4, memoryMb: 16384 },
  projects: [
    {
      id: "existing",
      name: "Production",
      revision: "a".repeat(64),
      allocation,
      editable: true,
      unavailableReason: null,
      activeAdjustmentId: null,
      services: ["api", "db"].map((id) => ({
        id,
        name: id,
        resources: { cpuCores: 1, memoryMb: 1024, diskMb: 8192 },
      })),
    },
  ],
};
let root: Root | null;
let container: HTMLDivElement;
const button = (name: string) => {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === name,
  );
  expect(found, name).toBeDefined();
  return found!;
};
const click = async (name: string) => {
  await act(async () => button(name).click());
};
async function enter(name: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function render(restriction: Partial<CloudCapacityRestriction> = {}) {
  await act(async () =>
    root!.render(
      <I18nProvider>
        <CloudCapacityModal
          restriction={{
            code: "CLOUD_CAPACITY_REQUIRED",
            projectId: "new-project",
            requested: { cpuCores: 0.5, memoryMb: 1024, diskMb: 8192 },
            ...restriction,
          }}
          onClose={h.close}
          onRetry={h.retry}
        />
      </I18nProvider>,
    ),
  );
}
async function review() {
  await click(copy.adjust);
  await enter(`api ${copy.cpuCores}`, "0.25");
  await enter(`api ${copy.memoryMb}`, "512");
  await click(copy.review);
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.capacity.mockResolvedValue(structuredClone(view));
  h.preview.mockResolvedValue({
    projectId: "existing",
    projectName: "Production",
    revision: "a".repeat(64),
    before: allocation,
    after,
    services: view.projects[0]!.services,
    restartServices: ["api", "db"],
  });
  h.apply.mockResolvedValue({ deploymentId: "adjustment", projectId: "existing" });
  h.status.mockResolvedValue({ deploymentStatus: "building" });
  h.resources.mockResolvedValue({ success: true, data: resourceView });
  h.saveResources.mockImplementation(async (_id, input) => ({ success: true, data: { ...resourceView, ...input } }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("capacity recovery", () => {
  it("restores automatic build sizing without changing production resources", async () => {
    await render({ buildResources, buildMode: "custom" });
    await click(copy.editBuild);
    await click(copy.automaticBuild);
    expect(container.querySelector(`input[aria-label="${copy.build} ${copy.cpuCores}"]`)).toBeNull();
    await click(copy.saveBuild);
    expect(h.saveResources).toHaveBeenCalledExactlyOnceWith("new-project", { build: null });
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.retry).not.toHaveBeenCalled();
  });
  it("starts with automatic sizing and allows an optional build cap", async () => {
    h.resources.mockResolvedValue({ success: true, data: { ...resourceView, buildMode: "automatic",
      build: { cpuCores: 0, memoryMb: 0, diskMb: 32768 } } });
    await render({ buildResources, buildMode: "automatic" });
    await click(copy.editBuild);
    expect(button(copy.automaticBuild).getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(`input[aria-label="${copy.build} ${copy.cpuCores}"]`)).toBeNull();
    await click(copy.customBuildLimit);
    await enter(`${copy.build} ${copy.cpuCores}`, "0.5");
    await enter(`${copy.build} ${copy.memoryMb}`, "512");
    await click(copy.saveBuild);
    expect(h.saveResources).toHaveBeenCalledExactlyOnceWith("new-project", { build: { cpuCores: 0.5, memoryMb: 512, diskMb: 32768 } });
  });
  it("reduces only the next build and rechecks capacity instead of retaining a stale shortfall", async () => {
    await render({ buildResources });
    expect(button(copy.retryDeploy).disabled).toBe(true);
    await click(copy.editBuild);
    expect(h.resources).toHaveBeenCalledWith("new-project");
    await enter(`${copy.build} ${copy.cpuCores}`, "0.25");
    await enter(`${copy.build} ${copy.memoryMb}`, "512");
    await act(async () => {
      button(copy.saveBuild).click();
      button(copy.saveBuild).click();
    });
    expect(h.saveResources).toHaveBeenCalledExactlyOnceWith("new-project", {
      build: { cpuCores: 0.25, memoryMb: 512, diskMb: 32768 },
    });
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.retry).not.toHaveBeenCalled();
    expect(container.textContent).toContain(copy.requestChanged);
    expect(container.textContent).not.toContain(copy.needCapacity);
    expect(button(copy.retryDeploy).disabled).toBe(false);
    await click(copy.retryDeploy);
    expect(h.retry).toHaveBeenCalledOnce();
  });
  it("retains build edits and displays a failed save without claiming capacity is available", async () => {
    h.saveResources.mockRejectedValue(new ApiError(403, "Forbidden", { error: "Project write access required" }));
    await render({ buildResources });
    await click(copy.editBuild);
    await enter(`${copy.build} ${copy.cpuCores}`, "0.25");
    await click(copy.saveBuild);
    expect(container.textContent).toContain("Project write access required");
    expect(container.querySelector<HTMLInputElement>(`input[aria-label="${copy.build} ${copy.cpuCores}"]`)?.value).toBe("0.25");
    expect(container.textContent).not.toContain(copy.requestChanged);
    expect(button(copy.retryDeploy).disabled).toBe(true);
    expect(h.retry).not.toHaveBeenCalled();
  });
  it("does not offer build controls for image-only deployments", async () => {
    await render({ buildResources: null });
    expect(container.textContent).toContain(copy.imageOnly);
    expect(container.textContent).not.toContain(copy.editBuild);
    expect(h.resources).not.toHaveBeenCalled();
  });
  it("never changes self-hosted resources from Cloud recovery after a project changes target", async () => {
    h.resources.mockResolvedValue({ success: true, data: { ...resourceView, requiresLimit: false } });
    await render({ buildResources });
    await click(copy.editBuild);
    expect(container.textContent).toContain(copy.buildUnavailable);
    expect(container.querySelector("form")).toBeNull();
    expect(h.saveResources).not.toHaveBeenCalled();
  });
  it("shows a workspace build limit without inventing an additional pool reservation", async () => {
    await render({ buildResources, scope: "workspace", message: "Build exceeds the workspace memory limit" });
    expect(container.textContent).toContain("Build exceeds the workspace memory limit");
    expect(container.textContent).not.toContain(copy.needCapacity);
    await click(copy.editBuild);
    expect(button(copy.retryDeploy).disabled).toBe(true);
    await click(copy.cancel);
    expect(h.saveResources).not.toHaveBeenCalled();
  });
  it("requires review and restart confirmation before changing any resources", async () => {
    await render();
    expect(button(copy.retryDeploy).disabled).toBe(true);
    await review();
    expect(h.preview).toHaveBeenCalledWith(
      expect.objectContaining({
        services: [
          { serviceId: "api", cpuCores: 0.25, memoryMb: 512 },
          { serviceId: "db", cpuCores: 1, memoryMb: 1024 },
        ],
      }),
    );
    expect(container.textContent).toContain(copy.restartNotice);
    expect(container.querySelector(`[aria-label="${copy.affected}"]`)?.textContent).toBe("apidb");
    expect(h.apply).not.toHaveBeenCalled();
    await act(async () => {
      button(copy.confirm).click();
      button(copy.confirm).click();
    });
    expect(h.apply).toHaveBeenCalledOnce();
    expect(h.apply).toHaveBeenCalledWith(
      expect.objectContaining({ confirmRestart: true, idempotencyKey: expect.any(String) }),
    );
  });
  it("waits for provider release after deployment is ready, then enables the original deployment retry", async () => {
    await render();
    await review();
    await click(copy.confirm);
    h.status.mockResolvedValue({ deploymentStatus: "ready" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(container.textContent).toContain(copy.verifying);
    expect(button(copy.retryDeploy).disabled).toBe(true);
    const released = structuredClone(view);
    released.pool.cpuCores.used = 3.25;
    released.projects[0]!.allocation = after;
    h.capacity.mockResolvedValue(released);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(container.textContent).toContain(copy.complete);
    await click(copy.retryDeploy);
    expect(h.retry).toHaveBeenCalledOnce();
    expect(container.querySelector('a[href="/build/adjustment"]')).not.toBeNull();
  });
  it("rechecks the deployment request after adjusting that same project's services", async () => {
    await render({ projectId: "existing", requested: { cpuCores: 8, memoryMb: 16384, diskMb: 8192 }, reusesWorkspace: true });
    await review();
    await click(copy.confirm);
    h.status.mockResolvedValue({ deploymentStatus: "ready" });
    const released = structuredClone(view);
    released.pool.cpuCores.used = 3.25;
    released.projects[0]!.allocation = after;
    h.capacity.mockResolvedValue(released);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(container.textContent).toContain(copy.requestChanged);
    expect(container.textContent).not.toContain(copy.needCapacity);
    expect(button(copy.retryDeploy).disabled).toBe(false);
    await click(copy.retryDeploy);
    expect(h.retry).toHaveBeenCalledOnce();
  });
  it("reuses the request key after an ambiguous transport failure", async () => {
    await render();
    await review();
    h.apply.mockRejectedValueOnce(new TypeError("Lost response"));
    await click(copy.confirm);
    const input = h.apply.mock.calls[0]![0];
    await click(copy.confirm);
    expect(h.apply.mock.calls[1]![0]).toEqual(input);
  });
  it("waits for exact allocation and worker completion before retrying", async () => {
    await render();
    await review();
    await click(copy.confirm);
    h.status.mockResolvedValue({ deploymentStatus: "ready", completionPending: true });
    const fresh = structuredClone(view);
    fresh.pool.cpuCores.used = 3.25;
    fresh.projects[0]!.allocation = after;
    h.capacity.mockResolvedValue(fresh);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(button(copy.retryDeploy).disabled).toBe(true);
    h.status.mockResolvedValue({ deploymentStatus: "ready", completionPending: false });
    fresh.projects[0]!.allocation = { ...after, memoryMb: 1024 };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(button(copy.retryDeploy).disabled).toBe(true);
    fresh.projects[0]!.allocation = after;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(button(copy.retryDeploy).disabled).toBe(false);
  });
  it("keeps the deployment blocked after a failed adjustment and shows its logs", async () => {
    h.status.mockResolvedValue({
      deploymentStatus: "failed",
      errorMessage: "Provider resize failed",
    });
    await render();
    await review();
    await click(copy.confirm);
    expect(container.textContent).toContain("Provider resize failed");
    expect(button(copy.retryDeploy).disabled).toBe(true);
    expect(h.retry).not.toHaveBeenCalled();
  });
  it("can refresh after a failed adjustment and use capacity that was subsequently released", async () => {
    h.status.mockResolvedValue({
      deploymentStatus: "failed",
      errorMessage: "Provider resize failed",
    });
    await render();
    await review();
    await click(copy.confirm);
    const fresh = structuredClone(view);
    fresh.pool.cpuCores.used = 3;
    h.capacity.mockResolvedValue(fresh);
    await click(copy.check);
    expect(button(copy.retryDeploy).disabled).toBe(false);
    expect(h.apply).toHaveBeenCalledOnce();
    await click(copy.retryDeploy);
    expect(h.retry).toHaveBeenCalledOnce();
  });
  it("shows an empty measured pool as zero, never as unlimited", async () => {
    const empty = structuredClone(view);
    empty.pool.cpuCores.used = empty.pool.memoryMb.used = empty.pool.diskMb.used = 0;
    h.capacity.mockResolvedValue(empty);
    await render();
    expect(container.textContent).toContain("0 vCPU / 4 vCPU");
    expect(container.textContent).toContain("0 MB / 16 GB");
    expect(container.textContent).not.toContain("vCPU vCPU");
  });
  it("stops polling after five minutes and checks the same operation only on demand", async () => {
    await render();
    await review();
    await click(copy.confirm);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(305000);
    });
    expect(container.textContent).toContain(copy.timeout);
    const reads = h.status.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(h.status).toHaveBeenCalledTimes(reads);
    expect(h.apply).toHaveBeenCalledOnce();
    expect(button(copy.adjust).disabled).toBe(true);
    await click(copy.check);
    expect(h.status).toHaveBeenCalledTimes(reads + 1);
    expect(h.apply).toHaveBeenCalledOnce();
  });
  it("stops scheduling reads after leaving the dialog without cancelling the running deployment", async () => {
    await render();
    await review();
    await click(copy.confirm);
    const reads = h.status.mock.calls.length;
    await act(async () => {
      root!.unmount();
      root = null;
    });
    await vi.advanceTimersByTimeAsync(30000);
    expect(h.status).toHaveBeenCalledTimes(reads);
    expect(h.apply).toHaveBeenCalledOnce();
  });
});
