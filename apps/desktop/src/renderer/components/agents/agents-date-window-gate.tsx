import type { AgentComponentsDataSource } from "@repo/app/agents/data-source/agent-components-data-source";
import {
  AgentComponentsDataSourceProvider,
  useAgentComponentsDataSource,
} from "@repo/app/agents/data-source/provider";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { AGENTS_LOCAL_DATE_WINDOW_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { type ReactNode, useMemo } from "react";
import { DesktopAppCoreMode } from "../../shared-agent-sessions/desktop-app-core-mode";
import { useDesktopAppCoreMode } from "../../shared-agent-sessions/desktop-app-core-provider";
import { withLocalDateWindowWithheld } from "../../shared-agent-sessions/local-agent-components-data-source";

/**
 * ISS-6888 — the rollout gate for the desktop LOCAL source's date-window
 * comparisons (the prior-period delta and the unwindowed facet universe).
 *
 * This component remains the narrow owner of the date-window rollout and
 * re-provides only the selected source.
 * `DesktopFeatureFlagProvider` now wraps the app-core mode stack, so both this
 * view-level gate and source selectors read the same PostHog-backed adapter.
 *
 * LOCAL MODE ONLY, via the canonical app-core mode rather than a scope string —
 * inferring "which source is this" from `scope` is the exact habit ISS-6888
 * exists to end. In Cloud mode desktop reads the HTTP source, which has served
 * both window-relative reads since FEA-3178; withholding there would remove a
 * shipped capability instead of withholding a new one.
 *
 * It re-provides the SAME source object when the gate is open or the mode is
 * Cloud, so the React Query cache identity and every other port member are
 * untouched; only the closed-local case substitutes a withheld declaration.
 */
export function DesktopAgentsDateWindowGate({
  children,
}: Readonly<{ children: ReactNode }>) {
  const mode = useDesktopAppCoreMode();
  const source = useAgentComponentsDataSource();
  const localDateWindowEnabled = useFeatureFlagEnabled(
    AGENTS_LOCAL_DATE_WINDOW_FEATURE_FLAG_KEY
  );
  const gated = useMemo<AgentComponentsDataSource>(() => {
    if (mode !== DesktopAppCoreMode.Local || localDateWindowEnabled) {
      return source;
    }
    return withLocalDateWindowWithheld(source);
  }, [mode, source, localDateWindowEnabled]);

  return (
    <AgentComponentsDataSourceProvider dataSource={gated}>
      {children}
    </AgentComponentsDataSourceProvider>
  );
}
