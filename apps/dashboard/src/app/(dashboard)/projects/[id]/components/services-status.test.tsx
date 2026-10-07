// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { ModalProvider } from "@/context/ModalContext";
import { baseDictionary } from "@/i18n";
import type { Service, ServiceContainer } from "@/lib/api/services";
import { ServicesTab } from "./ServicesTab";

const mocks = vi.hoisted(() => ({
  containers: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
  toast: vi.fn(),
  context: {
    id: "project-a",
    slug: ["services"],
    projectData: {
      name: "Stack",
      slug: "stack",
      projectType: "services",
      activeDeploymentId: "deployment-a",
      deployTarget: "server",
    },
    servicesData: { services: [] as Service[], isLoading: false, error: null },
  },
}));
vi.mock("@/context/ProjectSettingsContext", () => ({
  useProjectSettings: () => ({ ...mocks.context, refreshServices: mocks.refresh }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: mocks.toast }) }));
vi.mock("@/context/PlatformContext", () => ({
  usePlatform: () => ({ baseDomain: "example.test" }),
}));
vi.mock("@/components/theme-provider", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("@/hooks/useLocalhostForward", () => ({
  useLocalhostForward: () => ({ canForward: false }),
}));
vi.mock("@/hooks/useCloudDeployPricing", () => ({ useCloudDeployPricing: () => () => false }));
vi.mock("@/components/terminal/ServiceTerminal", () => ({
  ServiceTerminal: () => <div>Interactive shell</div>,
}));
vi.mock("./services/AddServiceModal", () => ({ AddServiceModal: () => null }));
vi.mock("./services/LinkedAppsCard", () => ({ LinkedAppsCard: () => null }));
vi.mock("./services/ServiceSettingsForm", () => ({ ServiceSettingsForm: () => null }));
vi.mock("./UseInProjectModal", () => ({ UseInProjectModal: () => null }));
vi.mock("./UsedByCard", () => ({ UsedByCard: () => null }));
vi.mock("@/lib/api/services", async (original) => {
  const actual = await original<typeof import("@/lib/api/services")>();
  return {
    ...actual,
    servicesApi: {
      ...actual.servicesApi,
      containers: mocks.containers,
      getEnv: async () => ({ success: true, vars: [] }),
    },
  };
});

const service: Service = {
  id: "service-a",
  name: "api",
  kind: "compose",
  enabled: true,
  image: "example/api:current",
  build: null,
  ports: [],
  volumes: [],
  dockerfile: null,
  buildArgs: null,
  dependsOn: [],
  environment: null,
  command: null,
  restart: null,
  exposed: false,
  exposedPort: null,
  domain: null,
  customDomain: null,
  domainType: null,
  sortOrder: 0,
};
type ContainerResponse = { success: boolean; containers: ServiceContainer[] };
const detail = baseDictionary.projectDetail.services.detail;
const labels = baseDictionary.projects.services;
const checking = "Checking…";
let host: HTMLDivElement;
let root: Root;

function deferred() {
  let resolve!: (value: ContainerResponse) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ContainerResponse>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function response(
  status: string,
  containerId: string | null = "container-a",
  serviceId = service.id,
): ContainerResponse {
  return {
    success: true,
    containers: [
      {
        serviceId,
        serviceName: service.name,
        containerId,
        status,
        ip: null,
        hostPort: null,
        imageRef: service.image,
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.context.id = "project-a";
  mocks.context.slug = ["services"];
  mocks.context.servicesData.services = [service];
  mocks.refresh.mockResolvedValue(undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function render(view: "list" | "detail" = "list", tab = "overview") {
  mocks.context.slug =
    view === "list" ? ["services"] : ["services", mocks.context.servicesData.services[0]!.id, tab];
  await act(async () =>
    root.render(
      <I18nProvider>
        <ModalProvider>
          <ServicesTab />
        </ModalProvider>
      </I18nProvider>,
    ),
  );
}
function button(label: string) {
  return [...host.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
}
async function click(label: string) {
  const element = button(label);
  expect(element, `button ${label}`).toBeDefined();
  await act(async () => element!.click());
}

describe("service runtime status", () => {
  it("checks the list initially and preserves a confirmed status during refresh", async () => {
    const first = deferred();
    mocks.containers.mockReturnValueOnce(first.promise);
    await render();
    expect(host.textContent).toContain(checking);
    expect(host.textContent).not.toContain("Stopped");

    await act(async () => first.resolve(response("running")));
    expect(host.textContent).toContain("Running");
    expect(host.textContent).not.toContain(checking);

    const next = deferred();
    mocks.containers.mockReturnValueOnce(next.promise);
    await click(labels.refresh);
    expect(host.textContent).toContain("Running");
    expect(host.textContent).not.toContain(checking);
    await act(async () => next.resolve(response("stopped")));
    expect(host.textContent).toContain("Stopped");
    expect(host.textContent).not.toContain("Running");
  });

  it("waits for confirmed stopped state before offering Start in service settings", async () => {
    const pending = deferred();
    mocks.containers.mockReturnValueOnce(pending.promise);
    await render("detail", "settings");
    expect(host.textContent).toContain(checking);
    expect(host.textContent).not.toContain("Stopped");
    expect(button(detail.start)).toBeUndefined();

    await act(async () => pending.resolve(response("stopped", null)));
    expect(button(detail.start)?.disabled).toBe(false);
    const badge = [...host.querySelectorAll("span")].find(
      (element) => element.textContent?.trim() === "Stopped",
    );
    expect(badge?.className).toContain("text-muted-foreground");
    expect(badge?.className).not.toContain("text-danger");
  });

  it("checks before telling a user to start the service for a shell", async () => {
    const pending = deferred();
    mocks.containers.mockReturnValueOnce(pending.promise);
    await render("detail", "terminal");
    expect(host.textContent).toContain(checking);
    expect(host.textContent).not.toContain(detail.startShellHint);
    await act(async () => pending.resolve(response("running")));
    expect(host.textContent).toContain("Interactive shell");
  });

  it.each(["list", "detail"] as const)(
    "shows an unknown status and retry after a failed check in the %s",
    async (view) => {
      const failed = deferred();
      mocks.containers.mockReturnValueOnce(failed.promise);
      await render(view);
      await act(async () => failed.reject(new Error("Status check timed out")));
      expect(host.textContent).toContain("Unknown");
      expect(host.textContent).toContain("Status check timed out");
      expect(host.textContent).not.toContain("Stopped");
      expect(host.textContent).not.toContain(checking);

      const retry = deferred();
      mocks.containers.mockReturnValueOnce(retry.promise);
      await click(labels.retry);
      expect(host.textContent).toContain(checking);
      await act(async () => retry.resolve(response("running")));
      expect(host.textContent).toContain("Running");
      expect(host.textContent).not.toContain("Status check timed out");
    },
  );

  it("does not claim stopped or offer Start when the API returns success false", async () => {
    mocks.containers.mockResolvedValueOnce({ success: false, containers: [] });
    await render("detail", "settings");
    expect(host.textContent).toContain("Unknown");
    expect(host.textContent).toContain(labels.failedLoad);
    expect(host.textContent).not.toContain("Stopped");
    expect(button(detail.start)).toBeUndefined();
  });

  it("keeps omitted runtime results unknown while recognizing a disabled service", async () => {
    mocks.context.servicesData.services = [
      service,
      { ...service, id: "disabled", name: "disabled-worker", enabled: false },
    ];
    mocks.containers.mockResolvedValueOnce({ success: true, containers: [] });
    await render();
    expect(host.textContent).toContain("Unknown");
    expect(host.textContent).toContain("Disabled");
    expect(host.textContent).not.toContain("Stopped");
    expect(host.textContent).not.toContain(checking);
  });

  it("does not let an older check overwrite the newest runtime result", async () => {
    const older = deferred();
    const newer = deferred();
    mocks.containers.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    await render();
    await click(labels.refresh);
    await act(async () => newer.resolve(response("running")));
    expect(host.textContent).toContain("Running");
    await act(async () => older.resolve(response("stopped")));
    expect(host.textContent).toContain("Running");
    expect(host.textContent).not.toContain("Stopped");
  });

  it("ignores a previous project's response after switching projects", async () => {
    const previous = deferred();
    const current = deferred();
    mocks.containers.mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise);
    await render("detail");
    mocks.context.id = "project-b";
    mocks.context.servicesData.services = [{ ...service, id: "service-b" }];
    await render("detail");
    await act(async () => current.resolve(response("running", "container-b", "service-b")));
    expect(host.textContent).toContain("Running");
    await act(async () => previous.resolve(response("stopped")));
    expect(host.textContent).toContain("Running");
    expect(host.textContent).not.toContain("Stopped");
  });
});
