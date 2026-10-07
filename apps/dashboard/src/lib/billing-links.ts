export interface BillingLinkScope {
  workspaceId?: string | null;
  organizationId?: string | null;
}

/** Preserve checkout reconciliation and organization scope through entry redirects. */
export function billingTabHref(tab: "overview" | "plans" | "payment", query: Record<string, string | string[] | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) params.append(key, item);
  }
  const search = params.toString();
  return `/billing/${tab}${search ? `?${search}` : ""}`;
}

/** Keep the chosen subscription and organization through billing navigation. */
export function scopedBillingHref(path: string, { workspaceId, organizationId }: BillingLinkScope = {}) {
  const url = new URL(path, "https://openship.invalid");
  // A new purchase must never inherit the server currently being inspected.
  if (url.searchParams.get("newServer") === "1") url.searchParams.delete("workspaceId");
  else if (workspaceId) url.searchParams.set("workspaceId", workspaceId);
  if (organizationId) url.searchParams.set("organizationId", organizationId);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function newServerBillingHref(organizationId?: string | null) {
  return scopedBillingHref("/billing/plans?newServer=1", { organizationId });
}

export function workspaceBillingHref(path: string, workspaceId?: string | null) {
  return scopedBillingHref(path, { workspaceId });
}
