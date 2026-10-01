import { UI, paidLadder, type CloudPricing } from "@/lib/pricing";

export interface FaqItem {
  q: string;
  a: string;
}

export function faq(pricing: CloudPricing): FaqItem[] {
  const ladder = paidLadder(pricing);

  return [
    {
      q: "How much does Openship Cloud cost?",
      a: [
        ladder
          ? `Plans are ${ladder}, ${UI.billedMonthly}.`
          : "See your dashboard for current Cloud plans and availability.",
        "Each plan covers your organization, with no per-seat fees. A paid plan is required to deploy on Cloud.",
        pricing.customTiers.length > 0
          ? "Enterprise limits and pricing are agreed with sales."
          : null,
      ]
        .filter((text): text is string => text !== null)
        .join(" "),
    },
    {
      q: "How do usage credits work?",
      a: "Each billing cycle includes the credits shown on your plan. Apps and builds use the same balance, and how long it lasts depends on your workload. Continuous hosting can require top-ups. Extra credits extend usage without changing your resource limits.",
    },
    {
      q: "How is capacity shared?",
      a: "The shared CPU, RAM, and disk pool is your organization's total capacity. Each service must also fit its per-service limit. Adding projects or services does not multiply that allowance. Your dashboard shows allocations and remaining capacity.",
    },
    {
      q: "Can I change or cancel my plan?",
      a: "You can cancel renewal from Billing and keep access until the end of your paid period. A plan change starts a new full-price billing cycle, without automatic proration or a refund of the previous cycle. Review the details before checkout.",
    },
    {
      q: "Is self-hosting really free?",
      a: "Yes. Run the full Openship platform on your own servers, free under Apache 2.0, with no Openship subscription or per-seat fees. You pay your infrastructure provider directly.",
    },
    {
      q: "Can I move between Cloud and my own servers?",
      a: "Yes. Openship uses standard containers and supports migration between Cloud and your own infrastructure. Your apps are portable, so you can choose where they run as your needs change.",
    },
  ];
}

/** The marketing site sends sign-in and signup to the Cloud dashboard. */
export const CLOUD_CTA_HREF = "/login";
export const SELF_HOST_CTA_HREF = "/docs/getting-started/quickstart";
