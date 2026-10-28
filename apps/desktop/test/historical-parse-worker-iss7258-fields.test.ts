/**
 * @file historical-parse-worker-iss7258-fields.test.ts
 * @description ISS-7258: the four consume fields must SURVIVE the
 * historical-parse worker's `.strict()` response boundary.
 *
 * Why this exists as its own suite rather than a note in the PR. The
 * compile-time key-coverage guards in
 * `historical-parse-worker-session-schema.ts` already force a new
 * `NormalizedSession` field to be
 * declared here — they caught all three of these during the build. What they
 * cannot check is the VALUE surviving: a schema entry can be present and still
 * strip, coerce, or default away what the parser measured.
 *
 * The failure this guards is not a dropped field. `.strict()` rejects the ENTIRE
 * worker response on an unmodelled key, so the session is silently dropped and
 * re-dropped on every retry, and the in-process path never sees it because it
 * skips this schema.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createHistoricalParseWorkerParsedResponse,
  HistoricalParseWorkerResponseType,
  historicalParseWorkerResponseSchema,
} from "../src/main/collectors/engine/historical-parse-worker-protocol.js";
import { normalizedSessionSchema } from "../src/main/collectors/engine/historical-parse-worker-session-schema.js";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import {
  makeSession,
  parsedSessions,
} from "./historical-parse-worker-response-support.js";

const CREATED_ENTRY = {
  worktreePath: "/repo/.claude/worktrees/w1",
  worktreeName: "w1",
  worktreeBranch: "worktree-w1",
  originalCwd: "/repo",
  preEnterOriginalCwd: "/repo",
  originalBranch: "main",
  originalHeadCommit: "2f941c266adf39c4aa61e92807ef796ef6fae89d",
};

const ENTERED_ENTRY = {
  worktreePath: "/repo/.claude/worktrees/w2",
  worktreeName: "w2",
  worktreeBranch: "worktree-w2",
  originalCwd: "/repo/.claude/worktrees/w1",
  preEnterOriginalCwd: "/repo",
  // `as const`: the union arm is `enteredExisting: true`, and a widened
  // `boolean` does not satisfy it.
  enteredExisting: true as const,
};

const COMPACTION = {
  uuid: "compact-1",
  timestamp: "2026-06-07T12:01:00.000Z",
  trigger: "manual",
  preTokens: 552_254,
  postTokens: 19_491,
  cumulativeDroppedTokens: 532_763,
  durationMs: 118_054,
};

function sessionWithIss7258Fields(): NormalizedSession {
  const session = makeSession("iss-7258");
  session.compactions = [COMPACTION];
  session.worktreeEntries = [CREATED_ENTRY, ENTERED_ENTRY];
  session.sessionKind = "bg";
  session.usageExtras = { ...session.usageExtras, efforts: ["xhigh"] };
  return session;
}

function roundTrip(session: NormalizedSession) {
  // The real envelope constructor, not a hand-built literal: a literal would
  // drift from the wire shape and start failing for reasons unrelated to the
  // fields under test.
  return historicalParseWorkerResponseSchema.safeParse(
    createHistoricalParseWorkerParsedResponse("iss-7258-request", [session])
  );
}

test("ISS-7258 fields survive the worker response boundary with their values", () => {
  const [session] = parsedSessions(roundTrip(sessionWithIss7258Fields()));

  // Values, not just presence — a schema entry can be present and still coerce.
  assert.deepEqual(session.compactions, [COMPACTION]);
  assert.deepEqual(session.worktreeEntries, [CREATED_ENTRY, ENTERED_ENTRY]);
  assert.equal(session.sessionKind, "bg");
  assert.deepEqual(session.usageExtras.efforts, ["xhigh"]);
});

test("a payload predating ISS-7258 still validates, and gains no keys", () => {
  // Version skew: an older worker omits all four. It must validate rather than
  // reject the whole response, and must not be handed a fabricated default —
  // `efforts: []` in particular would put a key back on every payload.
  const session = makeSession("iss-7258-legacy");
  const [parsed] = parsedSessions(roundTrip(session));

  assert.deepEqual(parsed.compactions, []);
  assert.equal("worktreeEntries" in parsed, false);
  assert.equal("sessionKind" in parsed, false);
  assert.equal("efforts" in parsed.usageExtras, false);
});

/**
 * Observe what the two layers do with a session, WITHOUT asserting — the tests
 * assert from their own bodies, so a helper that stopped running could never
 * take the coverage with it.
 *
 * `normalizedSessionSchema` is the `.strict()` contract itself. The envelope is
 * one step out: `createHistoricalParseWorkerParsedResponse` catches the clamp's
 * rejection and returns a FAILED response rather than throwing, so
 * `safeParse(envelope).success === false` would be the WRONG expectation — a
 * failed envelope is a perfectly valid response shape. What must hold is that
 * the bad session never arrives as if it were parsed.
 */
function refusalOf(session: NormalizedSession): {
  sessionSchemaAccepted: boolean;
  envelopeValid: boolean;
  envelopeType: string | null;
} {
  const result = historicalParseWorkerResponseSchema.safeParse(
    createHistoricalParseWorkerParsedResponse("iss-7258-request", [session])
  );
  return {
    sessionSchemaAccepted: normalizedSessionSchema.safeParse(session).success,
    envelopeValid: result.success,
    envelopeType: result.success ? result.data.type : null,
  };
}

const REFUSED = {
  sessionSchemaAccepted: false,
  envelopeValid: true,
  envelopeType: HistoricalParseWorkerResponseType.Failed,
};

test("the boundary is genuinely strict — an unmodelled sibling is rejected", () => {
  // The control. Without it, every assertion above would still pass against a
  // schema loosened to accept anything, and this suite would prove nothing
  // about the `.strict()` contract it exists to defend.
  const session = makeSession("iss-7258-unknown") as NormalizedSession &
    Record<string, unknown>;
  session.worktreeEntriesTypo = [CREATED_ENTRY];

  assert.deepEqual(refusalOf(session), REFUSED);
});

test("a half-formed worktree entry is rejected, not carried", () => {
  // The two shapes are a union: `enteredExisting` OR the base pair, never a
  // partial record. Valid-or-absent has to hold at the boundary too, or a
  // malformed entry crosses it and reads as measured provenance.
  // Assigned through the index signature, not a cast to the typed field: the
  // value is malformed BY DESIGN, and a cast that has to be widened through
  // `unknown` to compile is the banned double-cast shape.
  const session = sessionWithIss7258Fields();
  // Written through a plain record view: the field is typed as the two-arm
  // union precisely so a half-formed entry cannot be built, and the value here
  // is malformed BY DESIGN because that is what the boundary must refuse.
  const wire: Record<string, unknown> = session;
  // The key is OMITTED, not set to undefined — a missing key is what a
  // half-formed record actually looks like on the wire.
  const { originalHeadCommit: _dropped, ...halfFormed } = CREATED_ENTRY;
  wire.worktreeEntries = [halfFormed];

  assert.deepEqual(refusalOf(session), REFUSED);
});

test("a compaction with no metadata crosses unchanged", () => {
  // The omission contract, at the boundary: the scalars must not be defaulted
  // back on, or every pre-ISS-7258 compaction gains five keys in transit.
  const session = makeSession("iss-7258-bare-compaction");
  session.compactions = [{ uuid: "c1", timestamp: "2026-06-07T12:01:00.000Z" }];

  const [parsed] = parsedSessions(roundTrip(session));

  assert.deepEqual(parsed.compactions, [
    { uuid: "c1", timestamp: "2026-06-07T12:01:00.000Z" },
  ]);
});
