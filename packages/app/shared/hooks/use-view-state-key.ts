"use client";

import { useOptionalAuthSnapshot } from "../auth/use-auth-snapshot";
import { useFeatureFlagGateOptional } from "../feature-flags/use-feature-flag-enabled";
import { ORG_SCOPED_TABLE_VIEW_STATE_FEATURE_FLAG_KEY } from "../lib/feature-flags";
import { orgScopedViewStateKey } from "../lib/org-scoped-view-state-key";

/**
 * The localStorage key a surface should persist one piece of table view state
 * under (ISS-9726): `baseKey` namespaced by the signed-in identity once
 * `ORG_SCOPED_TABLE_VIEW_STATE_FEATURE_FLAG_KEY` is on, and `baseKey` itself
 * while it is off.
 *
 * `null` means "hold this value in memory and persist nothing" — the contract
 * `useViewStatePersistence` already had and that `useColumnVisibility` and
 * `useGroupExpansion` were taught for this change.
 *
 * ## Three flag states, not two
 *
 * The GATE, not the bare flag, and the distinction is the whole point of the
 * ticket. `useFeatureFlagEnabledOptional` collapses "PostHog has not answered
 * yet" into `false`, which is indistinguishable from a deliberate `false` — so
 * during hydration an ENABLED reader is handed the LEGACY, un-namespaced key.
 * That window is not harmless: an organization switch inside it restores the
 * previous organization's search text and filters, and the debounced writers
 * behind them persist that value back. The flag whose entire job is to stop view
 * state crossing organizations would itself carry it across, while presenting
 * the appearance that the leak was closed (whitlockk + codex, PR #6875).
 *
 * So `unresolved` is a third state and is answered as one: hold. Read nothing,
 * write nothing, render defaults until the flag actually lands. This is the same
 * loading-vs-false distinction the repo treats as a named defect class
 * everywhere else it appears.
 *
 * The window is bounded, not open-ended. {@link useFeatureFlagGateOptional}
 * latches on {@link FEATURE_FLAG_RESOLUTION_DEADLINE_MS}, so a PostHog outage
 * degrades to `isReady` and the flag-off legacy key — the pre-flag behavior —
 * rather than a table that never persists anything again. An adapter with no
 * asynchronous resolution to report (the desktop shell, the static test adapter)
 * reads as resolved on its first render and never sees this branch at all.
 *
 * The cost, stated plainly: a reader whose provider resolves asynchronously sees
 * default columns/sort/search for that window before their stored view lands.
 * That is a visible flash, and it is the price of not restoring a view under an
 * identity that may not own it. Holding is recoverable; a wrong-organization
 * write is not.
 *
 * The legacy key is never written, read, or deleted by the namespaced path, and
 * that is the whole migration story. No stored value is adopted into an identity
 * it cannot be attributed to — the un-namespaced `table:filters:my-tasks` holds
 * whichever organization was last open, and there is no organization it is
 * honestly the filter for. Enabling the flag therefore presents defaults once
 * per identity, and disabling it restores exactly the view the reader had,
 * because nothing under the old key was touched.
 */
export function useViewStateKey(baseKey: string): string | null {
  const { enabled, isReady } = useFeatureFlagGateOptional(
    ORG_SCOPED_TABLE_VIEW_STATE_FEATURE_FLAG_KEY
  );
  const { userId, orgId } = useOptionalAuthSnapshot();
  if (!isReady) {
    return null;
  }
  if (!enabled) {
    return baseKey;
  }
  return orgScopedViewStateKey(baseKey, userId, orgId);
}
