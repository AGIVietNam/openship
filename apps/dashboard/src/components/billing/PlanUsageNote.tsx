"use client";

import { useI18n } from "@/components/i18n-provider";
import { formatMilliCredits } from "@/lib/billing-usage";
import type { ApiPlan } from "./PricingCards";
import { planCapacity } from "./plan-presentation";

/** One note per comparison (or standalone offer), using the selected live allowance. */
export function PlanUsageNote({
  plans,
  interval = "monthly",
}: {
  plans: ApiPlan[];
  interval?: "monthly" | "annual";
}) {
  const { t, locale } = useI18n();
  const copy = t.billing.resourcesGuide;
  const metered = plans.filter((plan) => plan.id !== "free" && plan.id !== "enterprise");
  if (!metered.length) return null;
  return (
    <aside role="note" className="space-y-2 text-xs leading-relaxed text-muted-foreground">
      <p>
        <span className="font-medium text-foreground">{copy.usageNote}</span> {copy.planUsageNote}
      </p>
      {metered.some((plan) => planCapacity(plan) !== null) && <p>{copy.poolNote}</p>}
      <div>
        <p className="font-medium">{copy.creditAllowances}</p>
        <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 tabular-nums">
          {metered.map((plan) => {
            const credits = interval === "annual" ? plan.annualCredits : plan.monthlyCredits;
            return (
              <li key={plan.id}>
                <bdi>{plan.name}</bdi>
                {": "}
                <bdi>{credits == null ? "—" : formatMilliCredits(credits, locale)}</bdi>
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}
