import { describe, expect, it } from "vitest";
import { resolvePlan, type PlanTierId } from "@repo/core";
import { additionalPlanFeatures, planCapacity } from "./plan-presentation";
import type { ApiPlan } from "./PricingCards";

function plan(id: PlanTierId = "pro", locale: "en" | "ar" = "en"): ApiPlan {
  const source = resolvePlan(id, locale);
  return {
    ...source,
    features: [...source.features],
    resourceLimits: source.oblienLimits,
    listPrice: { monthly: source.price.monthly },
    effectivePrice: { monthly: source.price.monthly },
    campaign: null,
  };
}

describe("plan presentation", () => {
  it.each(["en", "ar"] as const)(
    "separates resource facts from visible benefits in %s",
    (locale) => {
      const offer = plan("pro", locale);
      const benefits = additionalPlanFeatures(offer, locale);
      expect(benefits).toEqual([offer.features[offer.featureKeys!.indexOf("prioritySupport")]!]);
    },
  );

  it.each(["en", "ar"] as const)(
    "recognizes the unchanged %s catalog from an older API without guessing changed copy",
    (locale) => {
      const offer = plan("pro", locale);
      expect(additionalPlanFeatures({ ...offer, featureKeys: undefined }, locale)).toEqual(
        additionalPlanFeatures(offer, locale),
      );
      const changed = {
        ...offer,
        featureKeys: undefined,
        features: offer.features.map((feature, index) =>
          index === 0 ? "A different saved allowance" : feature,
        ),
      };
      expect(additionalPlanFeatures(changed, locale)).toEqual(changed.features);
    },
  );

  it("preserves custom catalog features and responses without matching key metadata", () => {
    const offer = plan();
    const features = ["Custom support", "New Cloud capability"];
    expect(
      additionalPlanFeatures({ ...offer, features, featureKeys: ["newSupport", "newCapability"] }),
    ).toEqual(features);
    expect(additionalPlanFeatures({ ...offer, features, featureKeys: undefined })).toEqual(
      features,
    );
    expect(additionalPlanFeatures({ ...offer, features, featureKeys: ["projects"] })).toEqual(
      features,
    );
  });

  it("keeps capacity copy when the offer has no explicit numeric pool to display", () => {
    const offer = { ...plan(), resourceLimits: undefined };
    expect(planCapacity(offer)).toBeNull();
    expect(additionalPlanFeatures(offer)).toContain(
      offer.features[offer.featureKeys!.indexOf("namespaceCapacity")],
    );
    expect(
      planCapacity({
        ...plan(),
        resourceLimits: { ...plan().resourceLimits!, max_total_vcpus: null },
      }),
    ).toBeNull();
  });
});
