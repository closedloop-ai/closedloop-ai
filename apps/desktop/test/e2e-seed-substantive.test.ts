/**
 * FEA-3343 guard: the signal the E2E session seeds rely on must keep satisfying
 * the `isSubstantiveSession` SSOT.
 *
 * Why this exists: this is the SECOND time a new default display gate silently
 * blanked the E2E seeded corpus.
 *   - FEA-2531 added a write/push evidence gate to Branches; the seeded `seeded`
 *     method stopped qualifying (see `e2e/helpers/seed-branches-db.ts`, the
 *     `git_push` comment). Caught only by a 25-minute e2e run.
 *   - FEA-3284 added `quality=substantive` to the Sessions list, which hides
 *     0-turn/0-token/0-tool rows. The bare seeds became invisible, `desktop-e2e`
 *     went red on `main` for 12/12 runs, and it surfaced as three unrelated-
 *     looking spec failures rather than "the seeds are hidden".
 *
 * The seeds answer that gate with a synthetic `PreToolUse` tool event per session
 * (FEA-1421, `substantiveToolEventBatchItem`), i.e. they depend on `toolUseCount
 * > 0` still counting as substantive. This guard pins exactly that dependency, so
 * a PR that moves the SSOT boundary fails HERE — in seconds, by name, in the PR
 * that moves it — rather than hours later as a mystery e2e failure on someone
 * else's branch. It runs in the `desktop` job, whose path filter includes
 * `packages/api/**` (`.github/workflows/pr-test.yml`), which is where the SSOT
 * lives.
 *
 * SCOPE — stated rather than implied. This guard covers ONE failure mode: the
 * `isSubstantiveSession` boundary moving out from under the seeds' chosen signal.
 * It does NOT cover:
 *   - Whether the seeder actually emits the tool event (`substantiveToolEventBatchItem`
 *     is module-private, and proving the row lands needs a real SQLite write).
 *   - A future default-hiding gate change in `matchesListQuery`
 *     (`src/main/session/shared-agent-sessions-api.ts`) — not exported, and evaluating it
 *     needs a fully hydrated `SyncedAgentSession`.
 * Both are carried by `e2e/sessions-idle-quality.spec.ts`, the only thing that
 * runs seed -> SQLite -> hydration -> list gate -> rendered row. That division is
 * mutation-tested: dropping the tool event or forcing `matchesListQuery` false
 * fails that spec while this guard stays green.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { isSubstantiveSession } from "@repo/api/src/agent-session-filters";

test("a single tool use still makes a seeded session substantive", () => {
  // The exact dependency the seeds take on the SSOT: every seeded session's only
  // activity signal is one synthetic PreToolUse row. If `isSubstantiveSession`
  // stops treating a lone tool use as substantive, EVERY seeded session goes
  // invisible and desktop-e2e goes red across unrelated specs -- the FEA-3343
  // outage, exactly.
  assert.equal(isSubstantiveSession({ toolUseCount: 1 }), true);
});

test("a session with no activity signal at all is idle", () => {
  // The `idle: true` seed withholds every signal. This pins that such a row is
  // genuinely idle under the SSOT, so the hide half of
  // sessions-idle-quality.spec.ts cannot pass for the wrong reason.
  assert.equal(isSubstantiveSession({}), false);
  assert.equal(
    isSubstantiveSession({
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      toolUseCount: 0,
      turns: 0,
    }),
    false
  );
});
