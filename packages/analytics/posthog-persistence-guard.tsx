"use client";

import { usePostHog } from "@posthog/next";
import type { PostHog } from "posthog-js/react";
import { useRef } from "react";
import {
  ANALYTICS_PERSISTENCE_REPAIRED_EVENT,
  PERSISTED_PERSON_INFO_SITES,
  type PersistedPersonInfoRepair,
} from "./posthog-persistence-repair";

type PersistenceRepairClient = Pick<
  PostHog,
  "get_property" | "register" | "capture"
>;

/**
 * Repairs posthog-js's persisted person-info records before anything captures
 * (ISS-8660). Renders nothing.
 *
 * Mounted after capture-time attribution and before capturing descendants of
 * `<PostHogProvider>`, and it sweeps DURING ITS
 * OWN RENDER rather than from an effect. Both halves are load-bearing.
 *
 * `ClientPostHogProvider` calls `posthog.init` during its own render, so the
 * client is already live by the time this child renders — that is what makes a
 * render-phase sweep possible at all, and it is pinned by the sibling
 * integration suite against the real provider.
 *
 * The render phase rather than a layout effect, because a layout effect is not
 * early enough (tamsinb review on the duplicate of this ticket). React runs the
 * ENTIRE render pass over the subtree before it commits and fires any layout
 * effect, so sibling order buys nothing against a descendant that captures while
 * IT renders — and one does. `@posthog/next` re-exports posthog-js's
 * `useFeatureFlagResult` as `useFeatureFlag`, which this package's own
 * `client.ts` wraps and the web feature-flag port adapter
 * (`apps/app/lib/app-core-adapters.tsx`) calls unconditionally for every port
 * `<FeatureFlagged>` and `useFeatureFlagEnabled` read; that hook runs
 * `client.getFeatureFlagResult(flag)` inside a `useState` initializer, with no
 * `send_event: false`, and `getFeatureFlagResult` defaults to sending — it
 * reaches `capture('$feature_flag_called')` synchronously, mid-render. That
 * capture builds its properties through `getSetOnceProps`, which is the throw
 * this guard exists to prevent, so from a layout effect the guard would lose the
 * race on precisely the poisoned browsers it is for. `bootstrapFlags` on
 * `apps/app`'s root layout makes it worse rather than better: it opens
 * posthog-js's `_hasLoadedFlags` gate on the very first render.
 *
 * A `useRef` write during render, which is React's sanctioned lazy-init escape
 * hatch and is what keeps this to once per client. It is also belt-and-braces:
 * the sweep is idempotent, so a second pass finds repaired records, rewrites
 * nothing and reports nothing — which is what makes StrictMode's double render
 * and a discarded concurrent render both harmless.
 *
 * Skipped on the server, where there is no persistence to repair and no capture
 * to lose. `@posthog/next` ships `capture_pageview: false`, so posthog-js sends
 * nothing of its own before any of this.
 */
export function PostHogPersistenceGuard() {
  const posthog = usePostHog();
  const sweptClient = useRef<PersistenceRepairClient | null>(null);

  if (isBrowser && posthog && sweptClient.current !== posthog) {
    sweptClient.current = posthog;
    sweepPersistedPersonInfo(posthog);
  }

  return null;
}

const isBrowser = globalThis.window !== undefined;

function sweepPersistedPersonInfo(posthog: PersistenceRepairClient): void {
  const repairs: PersistedPersonInfoRepair[] = [];
  for (const site of PERSISTED_PERSON_INFO_SITES) {
    const repair = site.repair(posthog.get_property(site.key));
    if (!repair) {
      continue;
    }
    // Through posthog-js's own persistence layer, so storage is repaired too
    // and the next load starts clean.
    posthog.register({ [site.key]: repair.value });
    repairs.push(repair);
  }
  if (repairs.length === 0) {
    return;
  }
  // AFTER the rewrite, never before: the value being reported is the one that
  // makes `capture` throw, so a report emitted first is swallowed by the outage
  // it describes. `send_instantly` because this is the only signal the outage
  // happened and a poisoned browser is often mid-redirect, where a batched
  // event never flushes — the option posthog-js uses for its own `$pageview`.
  posthog.capture(
    ANALYTICS_PERSISTENCE_REPAIRED_EVENT,
    {
      // Arrays, not a delimited string: PostHog breaks down on array members
      // natively, and a joined string would need parsing in the dashboard.
      repairedKeys: repairs.map((repair) => repair.key),
      droppedFields: describeDroppedFields(repairs),
      // Kept apart from `droppedFields` because they count different things: a
      // drop is THIS outage, a redaction is the ISS-8295 migration arriving on
      // an old browser. Collapsing them would make the outage uncountable, which
      // is the one thing this event exists to do.
      redactedFields: describeRedactedFields(repairs),
    },
    { send_instantly: true }
  );
}

function describeDroppedFields(
  repairs: readonly PersistedPersonInfoRepair[]
): string[] {
  return repairs.flatMap((repair) =>
    repair.dropped.map(
      (dropped) => `${repair.key}.${dropped.field}:${dropped.valueType}`
    )
  );
}

/** Field names only — never the value, for the reason `valueType` exists. */
function describeRedactedFields(
  repairs: readonly PersistedPersonInfoRepair[]
): string[] {
  return repairs.flatMap((repair) =>
    repair.redacted.map((field) => `${repair.key}.${field}`)
  );
}
