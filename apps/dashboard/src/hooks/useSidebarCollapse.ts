"use client";

import { useState } from "react";

/** Keep the normal sidebar preference separate from each section's temporary override. */
export function useSidebarCollapse(autoCollapseScope: string | null) {
  const [state, setState] = useState({
    autoCollapseScope,
    preferredCollapsed: false,
    override: null as boolean | null,
  });

  // Reset between sections, before children paint at the previous section's width.
  if (state.autoCollapseScope !== autoCollapseScope) {
    setState({ ...state, autoCollapseScope, override: null });
  }

  const collapsed =
    autoCollapseScope !== null ? (state.override ?? true) : state.preferredCollapsed;
  const toggleCollapsed = () => {
    setState((current) =>
      autoCollapseScope !== null
        ? { ...current, override: !(current.override ?? true) }
        : { ...current, preferredCollapsed: !current.preferredCollapsed },
    );
  };

  return { collapsed, toggleCollapsed };
}
