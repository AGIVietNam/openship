import { resolvePlan, toPricingLocale } from "@repo/core";
import type { ApiPlan } from "./PricingCards";

/** Only explicit capacity can be advertised. Null provider limits are inherited. */
export function planCapacity(plan: ApiPlan) {
  const pool = plan.resourceLimits;
  if (!pool) return null;
  const { max_total_vcpus: cpu, max_total_ram_mb: ram, max_total_disk_gb: disk } = pool;
  if (cpu === null || ram === null || disk === null || ![cpu, ram, disk].every(Number.isFinite))
    return null;
  return { cpu, memoryGb: ram / 1024, diskGb: disk };
}

/** These facts already have dedicated resource rows or the shared usage note. */
const RESOURCE_FEATURES = new Set([
  "usageCredits",
  "finiteUsage",
  "runningServices",
  "oneRunningService",
  "power",
  "projects",
  "projectsUnlimited",
  "buildMinutes",
  "meteredBuilds",
  "freeSubdomains",
  "freeSubdomainsUnlimited",
]);

export function additionalPlanFeatures(plan: ApiPlan, locale = "en"): string[] {
  let keys = plan.featureKeys;
  if (!keys) {
    // An older Cloud API can serve the same catalog without keys. Only recognize
    // an exact match of the complete published list; never parse individual copy.
    const catalog = resolvePlan(plan.id, toPricingLocale(locale));
    if (
      catalog.features.length === plan.features.length &&
      catalog.features.every((feature, index) => feature === plan.features[index])
    ) {
      keys = catalog.featureKeys;
    }
  }
  // Preserve every benefit from unfamiliar or mismatched catalogs.
  if (keys?.length !== plan.features.length) return plan.features;
  const hasCapacity = planCapacity(plan) !== null;
  return plan.features.filter((_, index) => {
    const key = keys[index]!;
    return !RESOURCE_FEATURES.has(key) && !(hasCapacity && key === "namespaceCapacity");
  });
}
