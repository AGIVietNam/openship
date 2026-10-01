"use client";

import { Icon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import type { ApiPlan } from "./PricingCards";
import { additionalPlanFeatures } from "./plan-presentation";

/** Benefits stay visible; numbers already shown in PlanResources stay there. */
export function PlanFeatures({ plan }: { plan: ApiPlan }) {
  const { locale } = useI18n();
  const features = additionalPlanFeatures(plan, locale);
  if (!features.length) return null;
  return (
    <ul className="space-y-2.5 border-t border-border/40 pt-4">
      {features.map((feature) => (
        <li
          key={feature}
          className="flex items-start gap-2 text-sm leading-relaxed text-foreground/80"
        >
          <Icon name="check" className="mt-1 size-3.5 shrink-0 text-primary" aria-hidden="true" />
          <span>{feature}</span>
        </li>
      ))}
    </ul>
  );
}
