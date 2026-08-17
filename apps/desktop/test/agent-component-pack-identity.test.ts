/**
 * ISS-5534 (wongk review on #4902) — the DESKTOP half of the parent-pack
 * identity the Agents list emits beside each row's `invocations`.
 *
 * The shared Invocations summary card drops a plugin's rolled-up total only when
 * that plugin's OWN children are in the same population. It can only do that if
 * the producer says which pack each row belongs to, and the desktop reader is a
 * SECOND producer from the cloud one — so this pins the desktop emit against the
 * same contract `apps/api/app/agent-components/__tests__/plugin-child-usage.test.ts`
 * pins cloud-side. A split between the two would land the fix on web and leave
 * desktop either double-counting or zeroing plugins.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emitPackIdentity,
  pluginPackCandidates,
} from "../src/main/dashboard/agent-component-pack-identity.js";

test("a plugin emits the SAME candidate set its usage rollup summed over", () => {
  const merged = {
    packIds: new Set(["p2", "p1"]),
    representative: { component_key: "rtk" },
  };

  assert.deepEqual(emitPackIdentity(merged, true), {
    packIds: ["p1", "p2", "rtk"],
  });
  // The emitted identity and the emitted number must describe the same thing:
  // `resolvePluginUsage` sums over exactly `pluginPackCandidates`.
  assert.deepEqual(
    emitPackIdentity(merged, true).packIds,
    [...pluginPackCandidates(merged)].sort()
  );
});

test("a child row emits the pack it belongs to, not its own key", () => {
  assert.deepEqual(
    emitPackIdentity(
      {
        packIds: new Set(["rtk"]),
        representative: { component_key: "code-review" },
      },
      false
    ),
    { packIds: ["rtk"] }
  );
});

test("a component in no pack OMITS the field rather than emitting an empty list", () => {
  // Absence is the skew-safe wire shape (never `[]`, never `null`), and on a
  // non-plugin row it honestly means "belongs to no pack" — which is what stops
  // an unrelated child-kind row from being mistaken for some plugin's child.
  assert.deepEqual(
    emitPackIdentity(
      {
        packIds: new Set<string>(),
        representative: { component_key: "orchestrator" },
      },
      false
    ),
    {}
  );
});

test("a key-less plugin with no folded packs OMITS the field", () => {
  // Nothing to say ⇒ say nothing. The card then falls back to its population-wide
  // heuristic for this row, which can only under-count.
  assert.deepEqual(
    emitPackIdentity(
      { packIds: new Set<string>(), representative: { component_key: null } },
      true
    ),
    {}
  );
});
