// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerDetail } from "@repo/contracts";
import { I18nProvider } from "@/components/i18n-provider";
import { PlatformProvider } from "@/context/PlatformContext";
import { baseDictionary } from "@/i18n";
import { BillingLayout } from "./BillingLayout";
import { BillingPageView, type BillingView } from "./BillingViewContext";
import { BillingContent } from "./BillingContent";

const h = vi.hoisted(() => ({
  userId: "user-a", organizationId: "org-a", path: "/billing/overview", query: "",
  list: vi.fn(), checkouts: vi.fn(), router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
}));
vi.mock("@/lib/auth-client", () => ({ useSession: () => ({
  data: { user: { id: h.userId }, session: { activeOrganizationId: h.organizationId } },
}) }));
vi.mock("next/navigation", () => ({
  usePathname: () => h.path, useSearchParams: () => new URLSearchParams(h.query), useRouter: () => h.router,
}));
vi.mock("@/lib/api/system", () => ({ systemApi: { listServerDestinations: h.list } }));
vi.mock("@/lib/api/billing", async original => ({ ...await original<typeof import("@/lib/api/billing")>(), billingApi: { listCheckouts: h.checkouts } }));
vi.mock("@/context/CloudContext", () => ({ useCloud: () => ({ startConnect: vi.fn(), refresh: vi.fn() }) }));

function server(id: string, name: string, tier = "starter"): ServerDetail {
  return {
    id, name, connection: "cloud", isLocal: false, sshHost: null, sshPort: null,
    sshUser: null, sshAuthMethod: null, sshKeyPath: null, hasStoredKeyMaterial: false,
    sshJumpHost: null, sshArgs: null, country: null, sshTransport: "direct", hostChannel: null,
    createdAt: "2026-10-01T00:00:00Z", projectCount: 0,
    capabilities: { monitor: true, terminal: true, exec: true, hostConfiguration: false, ssh: false },
    managed: { id: `cws-${id}`, serverId: id, name, planTierId: tier, subscriptionStatus: "active",
      projectCount: 0, state: tier === "free" ? "needs_plan" : "running", operation: null,
      resources: tier === "free" ? null : { cpuCores: 1, memoryMb: 4096, diskMb: 25600 },
      createdAt: "2026-10-01T00:00:00Z" },
  };
}
const production = server("production", "Production");
const staging = server("staging", "Staging");
const draft = server("draft", "Draft server", "free");
let root: Root;
let host: HTMLDivElement;
const render = (children: ReactNode, selfHosted = false) => act(async () => root.render(
  <I18nProvider><PlatformProvider selfHosted={selfHosted}><BillingLayout>{children}</BillingLayout></PlatformProvider></I18nProvider>,
));
const page = (overrides: Partial<BillingView> = {}) => (
  <BillingPageView view={{ contextKey: "user-a:org-a", plansOnly: false, ...overrides }}><BillingContent
    layout={overrides.newServer ? "purchase" : h.path === "/billing/plans" ? "plans" : "details"} sidebar={null}>
    <p>Billing content</p>
  </BillingContent></BillingPageView>
);
const tabs = () => [...host.querySelectorAll("nav a")];
const purchaseTabs = () => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
const picker = () => host.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]');
const serverButton = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('aside button[aria-pressed]')].find(button => button.textContent?.includes(name))!;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.userId = "user-a"; h.organizationId = "org-a"; h.path = "/billing/overview"; h.query = "";
  h.list.mockResolvedValue({ servers: [] });
  h.checkouts.mockResolvedValue({ items: [] });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals();
});

describe("billing navigation by server ownership", () => {
  it.each([false, true])("keeps all pending payments reachable for an unpaid server (self-hosted: %s)", async selfHosted => {
    h.path = "/billing/plans";
    h.query = "workspaceId=cws-draft";
    h.list.mockResolvedValue({ servers: [draft] });
    await render(page({ plansOnly: true, workspaceId: "cws-draft", requestedWorkspaceId: "cws-draft" }), selfHosted);
    const pending = [...host.querySelectorAll<HTMLButtonElement>("header button")].find(node => node.textContent?.includes(baseDictionary.billing.pendingPayments.title));
    expect(pending).toBeDefined();
    expect(h.checkouts).not.toHaveBeenCalled();
    await act(async () => pending!.click());
    expect(h.checkouts).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(baseDictionary.billing.pendingPayments.empty);
    expect(purchaseTabs()).toHaveLength(2);
  });
  it("shows one payments tab and offers top-ups only when the scoped billing state allows them", async () => {
    h.query = "workspaceId=cws-production";
    await render(page({ requestedWorkspaceId: "cws-production", workspaceId: "cws-production", topupsAvailable: false }));
    expect(tabs().map(tab => tab.textContent)).toEqual([
      baseDictionary.billing.tabs.overview, baseDictionary.billing.tabs.usage,
      baseDictionary.billing.tabs.plans, baseDictionary.billing.tabs.payment,
    ]);
    expect(host.querySelector('a[href^="/billing/invoices"]')).toBeNull();
    await render(page({ requestedWorkspaceId: "cws-production", workspaceId: "cws-production", topupsAvailable: true }));
    expect(tabs()).toHaveLength(5);
    expect(host.querySelector('a[href="/billing/topups?workspaceId=cws-production"]')).not.toBeNull();
  });

  it("uses monthly and pay-as-you-go choices for a new customer without a server detour", async () => {
    h.path = "/billing/plans";
    await render(page({ plansOnly: true }));
    expect(host.querySelector("h1")?.textContent).toBe(baseDictionary.billing.onboarding.compareTitle);
    expect(purchaseTabs().map(tab => tab.textContent)).toEqual([baseDictionary.billing.purchase.monthly, baseDictionary.billing.purchase.payg]);
    expect(purchaseTabs()[0]?.getAttribute("aria-selected")).toBe("true");
    expect(picker()).toBeNull();
    expect(host.querySelector('a[href*="newServer=1"]')).toBeNull();
    expect(host.querySelector('a[href="/servers/new"]')).toBeNull();
    expect(h.list).toHaveBeenCalledOnce();
    expect(h.router.replace).not.toHaveBeenCalled();
  });

  it("shows one server in the right card with Get server in the page header", async () => {
    h.list.mockResolvedValue({ servers: [production] });
    await render(page({ workspaceId: "cws-production" }));
    expect(host.querySelector("header")?.textContent).not.toContain("Production");
    expect(host.querySelector("aside")?.textContent).toContain("Production");
    expect(serverButton("Production")).toBeUndefined();
    expect(picker()).toBeNull();
    expect(host.querySelector('header a[href="/billing/plans?newServer=1"]')?.textContent).toContain(baseDictionary.billing.layout.getServer);
    expect(host.querySelectorAll('a[href*="newServer=1"]')).toHaveLength(1);
    expect(host.querySelector('aside a[href*="newServer=1"]')).toBeNull();
    expect(tabs()).toHaveLength(4);
    expect(tabs().every(tab => tab.getAttribute("href")?.includes("workspaceId=cws-production"))).toBe(true);
    expect(h.router.replace).not.toHaveBeenCalled();
  });

  it("switches billing directly from visible server rows without another menu", async () => {
    h.query = "workspaceId=cws-production&organizationId=org-a";
    h.list.mockResolvedValue({ servers: [production, staging] });
    await render(page({ workspaceId: "cws-production", requestedWorkspaceId: "cws-production", organizationId: "org-a" }));
    expect(picker()).toBeNull();
    expect(serverButton("Production").getAttribute("aria-pressed")).toBe("true");
    expect(serverButton("Staging").getAttribute("aria-pressed")).toBe("false");
    await act(async () => serverButton("Staging").click());
    expect(h.router.push).toHaveBeenLastCalledWith("/billing/overview?workspaceId=cws-staging&organizationId=org-a", { scroll: false });
    expect(host.querySelector('header a[href="/billing/plans?newServer=1&organizationId=org-a"]')?.textContent).toContain(baseDictionary.billing.layout.getServer);
    expect(host.querySelectorAll('a[href*="newServer=1"]')).toHaveLength(1);
    expect(h.list).toHaveBeenCalledOnce();
  });

  it("keeps the shared selector and new-server action in the Plans header", async () => {
    h.path = "/billing/plans";
    h.query = "workspaceId=cws-production&organizationId=org-a";
    h.list.mockResolvedValue({ servers: [production, staging] });
    await render(page({ workspaceId: "cws-production", requestedWorkspaceId: "cws-production", organizationId: "org-a" }));
    expect(host.querySelector("aside")).toBeNull();
    expect(picker()?.textContent).toContain("Production");
    expect(host.querySelector("header")?.contains(picker()!)).toBe(true);
    expect(host.querySelectorAll('button[aria-haspopup="listbox"]')).toHaveLength(1);
    await act(async () => picker()!.click());
    expect(document.querySelector('[role="listbox"]')?.textContent).not.toContain(baseDictionary.deploy.targetStep.addServer);
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent?.includes("Staging"))!;
    expect(option).toBeDefined();
    await act(async () => option.click());
    expect(h.router.push).toHaveBeenLastCalledWith("/billing/plans?workspaceId=cws-staging&organizationId=org-a", { scroll: false });
    expect(host.querySelector('header a[href="/billing/plans?newServer=1&organizationId=org-a"]')).not.toBeNull();
    expect(host.querySelectorAll('a[href*="newServer=1"]')).toHaveLength(1);
  });

  it("keeps a single server compact on Plans without presenting a redundant menu", async () => {
    h.path = "/billing/plans";
    h.list.mockResolvedValue({ servers: [production] });
    await render(page({ workspaceId: "cws-production" }));
    expect(host.querySelector("aside")).toBeNull();
    expect(picker()).toBeNull();
    expect(host.querySelector("header")?.textContent).toContain("Production");
    expect(host.querySelector('header a[href="/billing/plans?newServer=1"]')).not.toBeNull();
  });

  it("can switch from a subscribed server to an unpaid server and back without entering new-server checkout", async () => {
    h.path = "/billing/plans";
    h.query = "workspaceId=cws-production&organizationId=org-a";
    h.list.mockResolvedValue({ servers: [production, draft] });
    await render(page({ workspaceId: "cws-production", requestedWorkspaceId: "cws-production", organizationId: "org-a" }));

    await act(async () => picker()!.click());
    const draftOption = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent?.includes(draft.name!))!;
    await act(async () => draftOption.click());
    expect(h.router.push).toHaveBeenLastCalledWith("/billing/plans?workspaceId=cws-draft&organizationId=org-a", { scroll: false });

    h.query = "workspaceId=cws-draft&organizationId=org-a";
    await render(page({ workspaceId: "cws-draft", requestedWorkspaceId: "cws-draft", organizationId: "org-a", plansOnly: true }));
    expect(picker()?.textContent).toContain(draft.name);
    expect(purchaseTabs()).toHaveLength(2);
    expect(host.textContent).not.toContain(baseDictionary.billing.creditAlert.backToBilling);

    await act(async () => picker()!.click());
    const paidOption = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent?.includes(production.name!))!;
    await act(async () => paidOption.click());
    expect(h.router.push).toHaveBeenLastCalledWith("/billing/plans?workspaceId=cws-production&organizationId=org-a", { scroll: false });

    h.query = "workspaceId=cws-production&organizationId=org-a";
    await render(page({ workspaceId: "cws-production", requestedWorkspaceId: "cws-production", organizationId: "org-a" }));
    expect(picker()?.textContent).toContain(production.name);
    expect(host.querySelector("h1")?.textContent).toBe(baseDictionary.billing.layout.title);
    expect(tabs()).toHaveLength(4);
    expect(tabs().every(tab => tab.getAttribute("href")?.includes("workspaceId=cws-production"))).toBe(true);
    expect(purchaseTabs()).toHaveLength(0);
    expect(h.list).toHaveBeenCalledOnce();
  });

  it("keeps multiple unpaid servers selectable", async () => {
    h.path = "/billing/plans";
    h.query = "workspaceId=cws-draft";
    h.list.mockResolvedValue({ servers: [draft, server("second", "Second server", "free")] });
    await render(page({ workspaceId: "cws-draft", requestedWorkspaceId: "cws-draft", plansOnly: true }));
    expect(picker()?.textContent).toContain(draft.name);
    await act(async () => picker()!.click());
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(2);
    expect(purchaseTabs()).toHaveLength(2);
  });

  it("does not carry an unpaid server's plan-only view into another server while its page loads", async () => {
    h.path = "/billing/plans";
    h.query = "workspaceId=cws-draft";
    h.list.mockResolvedValue({ servers: [production, draft] });
    const draftPage = page({ workspaceId: "cws-draft", requestedWorkspaceId: "cws-draft", plansOnly: true });
    await render(draftPage);
    expect(purchaseTabs()).toHaveLength(2);
    h.query = "workspaceId=cws-production";
    await render(draftPage);
    expect(purchaseTabs()).toHaveLength(0);
    expect(host.querySelector("h1")?.textContent).toBe(baseDictionary.billing.layout.title);
    expect(picker()?.textContent).toContain(production.name);
    expect(tabs()).toHaveLength(4);
    expect(tabs().every(tab => tab.getAttribute("href")?.includes("workspaceId=cws-production"))).toBe(true);
  });

  it("does not inherit an existing server's navigation while buying a new one", async () => {
    h.path = "/billing/plans";
    h.query = "newServer=1&workspaceId=cws-production&organizationId=org-a";
    h.list.mockResolvedValue({ servers: [production] });
    await render(page({ workspaceId: "cws-production", requestedWorkspaceId: "cws-production", organizationId: "org-a", newServer: true, plansOnly: true }));
    expect(purchaseTabs()).toHaveLength(2);
    expect(tabs()).toHaveLength(0);
    expect(host.textContent).not.toContain("Production");
    expect(picker()).toBeNull();
    expect(host.querySelector("aside")).toBeNull();
    expect(host.querySelector('header a[href="/billing?organizationId=org-a"]')).not.toBeNull();
    expect(host.querySelector('a[href*="newServer=1"]')).toBeNull();
  });

  it("keeps the Plans server selector mounted while its content refreshes", async () => {
    h.path = "/billing/plans";
    h.query = "workspaceId=cws-production";
    h.list.mockResolvedValue({ servers: [production, staging] });
    await render(page({ workspaceId: "cws-production", requestedWorkspaceId: "cws-production" }));
    const control = picker();
    expect(control?.textContent).toContain("Production");
    await render(<div role="status">Refreshing plans</div>);
    expect(picker()).toBe(control);
    expect(host.querySelector("header")?.contains(control!)).toBe(true);
    expect(h.list).toHaveBeenCalledOnce();
    expect(tabs()).toHaveLength(4);
  });

  it("keeps the header and tabs mounted while another tab loads", async () => {
    h.list.mockResolvedValue({ servers: [production] });
    await render(page({ workspaceId: "cws-production" }));
    const header = host.querySelector("header");
    const nav = host.querySelector("nav");
    const getServer = host.querySelector('header a[href="/billing/plans?newServer=1"]');
    expect(getServer).not.toBeNull();
    h.path = "/billing/usage";
    await render(<div role="status">Loading tab</div>);
    expect(host.querySelector("header")).toBe(header);
    expect(host.querySelector("nav")).toBe(nav);
    expect(host.querySelector('header a[href="/billing/plans?newServer=1"]')).toBe(getServer);
    expect(tabs()).toHaveLength(4);
    expect(h.list).toHaveBeenCalledOnce();
  });

  it("reveals full billing navigation as soon as the subscription activates", async () => {
    h.path = "/billing/plans";
    await render(page({ plansOnly: true }));
    expect(purchaseTabs()).toHaveLength(2);
    await render(page({ plansOnly: false, workspaceId: "cws-production" }));
    expect(host.querySelector("h1")?.textContent).toBe(baseDictionary.billing.layout.title);
    expect(tabs()).toHaveLength(4);
  });

  it("does not expose the current organization's picker while opening a different organization", async () => {
    h.query = "organizationId=org-b";
    h.list.mockResolvedValue({ servers: [production, staging] });
    await render(page());
    expect(picker()).toBeNull();
    expect(host.querySelector("header")?.textContent).not.toContain("Production");
    expect(host.querySelector('a[href*="newServer=1"]')).toBeNull();
    expect(tabs()).toHaveLength(0);
    expect(h.router.replace).not.toHaveBeenCalled();
  });

  it("does not label an unavailable explicit scope as the sole available server", async () => {
    h.query = "workspaceId=cws-missing";
    h.list.mockResolvedValue({ servers: [production] });
    await render(page({ requestedWorkspaceId: "cws-missing" }));
    expect(picker()).toBeNull();
    expect(serverButton("Production").getAttribute("aria-pressed")).toBe("false");
    await act(async () => serverButton("Production").click());
    expect(h.router.push).toHaveBeenLastCalledWith("/billing/overview?workspaceId=cws-production", { scroll: false });
    expect(tabs().every(tab => tab.getAttribute("href")?.includes("workspaceId=cws-missing"))).toBe(true);
    expect(h.router.replace).not.toHaveBeenCalled();
  });

  it("ignores a late page from the previous server while keeping the requested scope", async () => {
    h.query = "workspaceId=cws-production";
    const productionPage = page({ requestedWorkspaceId: "cws-production", workspaceId: "cws-production" });
    await render(productionPage);
    h.query = "workspaceId=cws-staging";
    await render(productionPage);
    expect(tabs().every(tab => tab.getAttribute("href")?.includes("workspaceId=cws-staging"))).toBe(true);
  });

  it("clears navigation and inventory when the account changes", async () => {
    h.list.mockResolvedValueOnce({ servers: [production] });
    const oldPage = page({ workspaceId: "cws-production" });
    await render(oldPage);
    h.userId = "user-b";
    await render(oldPage);
    expect(host.textContent).not.toContain("Production");
    expect(tabs()).toHaveLength(0);
    await render(page({ contextKey: "user-b:org-a", plansOnly: true }));
    expect(purchaseTabs()).toHaveLength(2);
    expect(purchaseTabs()[0]?.getAttribute("aria-selected")).toBe("true");
  });

  it("keeps the billing view visible and offers a retry when inventory cannot load", async () => {
    let reject!: (error: Error) => void;
    h.list.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    await render(page());
    expect(host.textContent).toContain("Billing content");
    await act(async () => reject(new Error("Temporarily unavailable")));
    const retry = host.querySelector<HTMLButtonElement>("aside button")!;
    expect(retry.textContent).toContain("Try again");
    h.list.mockResolvedValueOnce({ servers: [production, staging] });
    await act(async () => retry.click());
    expect(serverButton("Staging")).toBeDefined();
    expect(host.textContent).toContain("Billing content");
    expect(tabs()).toHaveLength(4);
  });

  it("loads the shared managed inventory in self-hosted mode without changing the current billing scope", async () => {
    await render(page(), true);
    expect(tabs()).toHaveLength(4);
    expect(picker()).toBeNull();
    expect(host.querySelector('a[href*="newServer=1"]')).toBeNull();
    expect(h.list).toHaveBeenCalledOnce();
    expect(h.router.replace).not.toHaveBeenCalled();
  });

  it("shows Cloud servers beside an installation's own server and recognizes a canonical checkout scope", async () => {
    const own = { ...production, id: "own-server", name: "Own VPS", managed: null, connection: "ssh" as const };
    const linked = { ...production, cloudReference: { serverId: "cloud-production", workspaceId: "cloud-workspace" } };
    h.list.mockResolvedValue({ servers: [own, linked, { ...staging, source: "cloud" }] });
    h.query = "workspaceId=cloud-workspace";
    await render(page({ requestedWorkspaceId: "cloud-workspace", workspaceId: "cloud-workspace" }), true);
    expect(serverButton("Production").getAttribute("aria-pressed")).toBe("true");
    expect(serverButton("Staging").getAttribute("aria-pressed")).toBe("false");
    expect(host.querySelector("aside")?.textContent).not.toContain("Own VPS");
    await act(async () => serverButton("Staging").click());
    expect(h.router.push).toHaveBeenLastCalledWith("/billing/overview?workspaceId=cws-staging", { scroll: false });
  });
});
