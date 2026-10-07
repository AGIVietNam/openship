"use client";

import { createContext, useCallback, useContext, useId, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/components/i18n-provider";
import { Tabs } from "@/components/ui/Tabs";

type PurchaseMode = "monthly" | "payg";
type PurchaseContext = {
  mode: PurchaseMode;
  intro: { title: string; description: string };
  selectMode: (mode: PurchaseMode) => void;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  id: string;
  tabs: "header" | "inline" | "none";
  detailsTarget: HTMLDivElement | null;
  setDetailsTarget: (target: HTMLDivElement | null) => void;
  controlsTarget: HTMLElement | null;
  setControlsTarget: (target: HTMLElement | null) => void;
};

const CloudPurchaseContext = createContext<PurchaseContext | null>(null);

/** View selection only. Checkout terms always come from the billing API. */
export function CloudPurchaseProvider({
  children,
  tabs = "inline",
  scopeKey = "",
}: {
  children: ReactNode;
  tabs?: PurchaseContext["tabs"];
  scopeKey?: string;
}) {
  const { t } = useI18n();
  const id = useId();
  const [selection, setSelection] = useState({ scopeKey, mode: "monthly" as PurchaseMode });
  const [pending, setPending] = useState({ scopeKey, busy: false });
  const [detailsTarget, setDetailsTarget] = useState<HTMLDivElement | null>(null);
  const [controlsTarget, setControlsTarget] = useState<HTMLElement | null>(null);
  const mode = tabs !== "none" && selection.scopeKey === scopeKey ? selection.mode : "monthly";
  const busy = pending.scopeKey === scopeKey && pending.busy;
  const setBusy = useCallback(
    (busy: boolean) => {
      setPending((previous) =>
        !busy && previous.scopeKey !== scopeKey ? previous : { scopeKey, busy },
      );
    },
    [scopeKey],
  );

  return (
    <CloudPurchaseContext.Provider
      value={{
        mode,
        intro:
          mode === "payg"
            ? { title: t.billing.purchase.title, description: t.billing.purchase.description }
            : {
                title: t.billing.onboarding.compareTitle,
                description: t.billing.workspaces.description,
              },
        id,
        tabs,
        busy,
        setBusy,
        detailsTarget,
        setDetailsTarget,
        controlsTarget,
        setControlsTarget,
        selectMode: (mode) => {
          if (!busy) setSelection({ scopeKey, mode });
        },
      }}
    >
      {children}
    </CloudPurchaseContext.Provider>
  );
}

/** Standalone server setup and destination dialogs reuse the same purchase view. */
export function CloudPurchaseScope({ children }: { children: ReactNode }) {
  const parent = useContext(CloudPurchaseContext);
  return parent ? children : <CloudPurchaseProvider>{children}</CloudPurchaseProvider>;
}

export function useOptionalCloudPurchase() {
  return useContext(CloudPurchaseContext);
}

export function useCloudPurchase() {
  const context = useOptionalCloudPurchase();
  if (!context) throw new Error("Cloud purchase controls require CloudPurchaseProvider");
  return context;
}

export function CloudPurchaseTabs() {
  const { t } = useI18n();
  const purchase = useCloudPurchase();
  return (
    <div className="space-y-4">
      {purchase.tabs === "inline" && (
        <div ref={purchase.setDetailsTarget} className="empty:hidden" />
      )}
      <fieldset disabled={purchase.busy} aria-busy={purchase.busy} className="min-w-0">
        <div className="flex min-w-0 items-center gap-3 border-b border-border/50">
          <Tabs
            tabs={[
              { key: "monthly", label: t.billing.purchase.monthly },
              { key: "payg", label: t.billing.purchase.payg },
            ]}
            value={purchase.mode}
            onChange={purchase.selectMode}
            idPrefix={purchase.id}
            ariaLabel={t.billing.purchase.mode}
            className="flex-1 border-b-0"
          />
          {purchase.tabs === "inline" && (
            <div
              ref={purchase.setControlsTarget}
              hidden={purchase.mode === "payg"}
              className="shrink-0 empty:hidden"
            />
          )}
        </div>
      </fieldset>
    </div>
  );
}

/** Keep the picker and its form state in one place while sharing the page's purchase header. */
export function CloudPurchaseHeaderContent({
  details,
  controls,
}: {
  details: ReactNode;
  controls: ReactNode;
}) {
  const purchase = useCloudPurchase();
  return (
    <>
      {purchase.detailsTarget && createPortal(details, purchase.detailsTarget)}
      {purchase.controlsTarget && createPortal(controls, purchase.controlsTarget)}
    </>
  );
}
