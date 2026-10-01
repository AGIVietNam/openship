"use client";

import { useCallback, useEffect, useRef } from "react";
import { useModal } from "@/context/ModalContext";
import { CloudDeployPlanModal } from "@/components/billing/CloudDeployPlanModal";
import { CloudCapacityModal } from "@/components/billing/CloudCapacityModal";
import { cloudDeployRestriction, cloudCapacityRestriction } from "@/lib/cloud-deploy-pricing";

/** Call from an explicit Deploy/Start/Redeploy catch, never from configuration
 * effects or Save. Reading billing first would incorrectly require billing:read
 * permission from every person who is otherwise allowed to deploy. */
export function useCloudDeployPricing() {
  const { showModal, hideModal } = useModal();
  const openModal = useRef<string | null>(null);

  useEffect(() => () => {
    if (openModal.current) hideModal(openModal.current);
    openModal.current = null;
  }, [hideModal]);

  return useCallback((error: unknown, onRetry?: () => Promise<unknown>): boolean => {
    const restriction = cloudDeployRestriction(error);
    const capacity = cloudCapacityRestriction(error);
    if (!restriction && !capacity) return false;
    if (openModal.current) return true;
    const id = showModal({
      customContent: capacity
        ? <CloudCapacityModal restriction={capacity} onClose={() => hideModal(id)} onRetry={onRetry ? async () => {
          // Release this dialog before retrying: a second refusal must be free
          // to open fresh recovery instead of being swallowed by the dedupe ref.
          openModal.current = null;
          hideModal(id);
          return onRetry();
        } : undefined} />
        : <CloudDeployPlanModal restriction={restriction!} onClose={() => hideModal(id)} />,
      width: "100%",
      maxWidth: capacity ? "880px" : "1440px",
      maxHeight: "calc(100dvh - 2rem)",
      overflow: "hidden",
      showCloseButton: false,
      onClose: () => { if (openModal.current === id) openModal.current = null; },
    });
    openModal.current = id;
    return true;
  }, [showModal, hideModal]);
}
