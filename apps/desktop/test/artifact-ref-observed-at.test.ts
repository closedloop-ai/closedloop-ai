/**
 * @file artifact-ref-observed-at.test.ts
 * @description When an artifact ref is dated FROM — the `observed_at` basis.
 *
 * Split out of `artifact-ref-extractor.test.ts` (ISS-5236), which is on the
 * `noExcessiveLinesPerFile` shrink-only grandfather list. These suites share one
 * responsibility — proving which instant a ref is stamped with — so they move
 * together rather than growing a file that must never grow:
 *
 *  - FEA-2531: a ref derived from a dated tool use takes that event's time.
 *  - FEA-3635: a CREATED PR ref anchors its open marker to the create turn.
 *  - ISS-5236: a ref with NO event of its own is dated from the session's own
 *    `startedAt` — never the caller's import wall clock, which is what every
 *    scan-time ref used to carry.
 *  - ISS-5427: whichever instant wins, it is stamped in the canonical UTC 'Z'
 *    form, because the column it lands in is compared LEXICALLY.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { extractArtifactRefs } from "../src/main/collectors/parsing/artifact-ref-extractor.js";
import { extractLaunchMetadataRefs } from "../src/main/collectors/parsing/artifact-ref-launch-metadata.js";
import {
  resolveRefObservedAt,
  resolveSessionObservedAt,
} from "../src/main/collectors/parsing/artifact-ref-observed-at.js";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import { isCanonicalUtcTimestamp } from "../src/main/database/session-timestamp-form.js";
import { makeSession as baseSession } from "./normalized-session-test-utils.js";

/**
 * The fixture session's own start instant — source-derived, captured by the
 * parser from the transcript. ISS-5236: this, NOT `NOW`, is what a scan-time ref
 * (one with no event of its own to date it) must be stamped with. Kept strictly
 * earlier than `NOW` so the two can never be confused by an assertion.
 */
const SESSION_STARTED_AT = "2024-01-01T00:00:00.000Z";

/**
 * The caller's import wall clock. Before ISS-5236 every scan-time ref was
 * stamped with this; it must now never reach a ref's `observedAt`.
 */
const NOW = "2024-01-01T12:00:00.000Z";

function makeSession(
  overrides: Partial<NormalizedSession> & {
    messages?: NormalizedSession["messages"];
    toolUses?: NormalizedSession["toolUses"];
  } = {}
): NormalizedSession {
  return baseSession({
    sessionId: "test-session-1",
    name: "test",
    cwd: null,
    model: null,
    startedAt: SESSION_STARTED_AT,
    endedAt: null,
    ...overrides,
  });
}

describe("FEA-2531: per-ref observedAt from tool event time", () => {
  test("branch ref from a tool use stamps observedAt from the tool timestamp, not scan time", () => {
    const TOOL_TIME = "2026-06-08T08:00:00.000Z";
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: TOOL_TIME,
          input: { command: "git push -u origin feat/fea-2531" },
        },
      ],
    });
    // NOW (2024) is the scan/import time; it must not leak onto the branch ref.
    const branchRef = extractArtifactRefs(session, NOW).find(
      (r) => r.targetKind === "branch" && r.method === "git_push"
    );
    assert.ok(branchRef);
    assert.equal(branchRef?.observedAt, TOOL_TIME);
    assert.notEqual(branchRef?.observedAt, NOW);
  });

  test("branch ref with no tool timestamp falls back to session start, not the import clock", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: null,
          input: { command: "git push -u origin feat/fea-2531" },
        },
      ],
    });
    const branchRef = extractArtifactRefs(session, NOW).find(
      (r) => r.targetKind === "branch" && r.method === "git_push"
    );
    assert.ok(branchRef);
    // ISS-5236: with no event of its own to date it, the ref falls back to the
    // session's source-derived start — never the caller's import clock.
    assert.equal(branchRef?.observedAt, SESSION_STARTED_AT);
    assert.notEqual(branchRef?.observedAt, NOW);
  });

  test("session start-branch ref is stamped with session start, not the import clock", () => {
    // `session.gitBranch` is captured once, AT SESSION START, so session start
    // IS when this ref was observed. Before ISS-5236 it carried whichever moment
    // the import (or a later rebuild) happened to run.
    const session = makeSession({ gitBranch: "feat/fea-2531" });
    const branchRef = extractArtifactRefs(session, NOW).find(
      (r) => r.targetKind === "branch" && r.method === "start_branch"
    );
    assert.ok(branchRef);
    assert.equal(branchRef?.observedAt, SESSION_STARTED_AT);
    assert.notEqual(branchRef?.observedAt, NOW);
  });
});

describe("FEA-3635: PR-open marker anchors to the transcript turn", () => {
  test("created PR ref stamps observedAt from the create tool-use timestamp, not scan time", () => {
    const TOOL_TIME = "2026-06-08T09:15:00.000Z";
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: TOOL_TIME,
          input: { command: "gh pr create --title 'Fix' --body 'body'" },
          output: "https://github.com/closedloop-ai/symphony-alpha/pull/3240\n",
        },
      ],
    });
    // NOW (2024) is the scan/import time; it must NOT leak onto the created PR
    // ref, or the PR-opened dot would bunch at import time (comment 3).
    const prRef = extractArtifactRefs(session, NOW).find(
      (r) => r.targetKind === "pull_request" && r.relation === "created"
    );
    assert.ok(prRef, "expected a created PR ref");
    assert.equal(prRef?.prNumber, 3240);
    assert.equal(prRef?.observedAt, TOOL_TIME);
    assert.notEqual(prRef?.observedAt, NOW);
  });

  test("created PR ref with no tool timestamp falls back to session start, not the import clock", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: null,
          input: { command: "gh pr create --fill" },
          output: "https://github.com/closedloop-ai/symphony-alpha/pull/44\n",
        },
      ],
    });
    const prRef = extractArtifactRefs(session, NOW).find(
      (r) => r.targetKind === "pull_request" && r.relation === "created"
    );
    assert.ok(prRef);
    assert.equal(prRef?.observedAt, SESSION_STARTED_AT);
    assert.notEqual(prRef?.observedAt, NOW);
  });

  test("a later re-mention of the same PR keeps the open marker at the create turn (comment 2)", () => {
    const CREATE_TIME = "2026-06-08T09:15:00.000Z";
    const REMENTION_TIME = "2026-06-08T11:45:00.000Z";
    const prUrl = "https://github.com/closedloop-ai/symphony-alpha/pull/3240";
    const session = makeSession({
      toolUses: [
        // The PR is OPENED here.
        {
          name: "Bash",
          timestamp: CREATE_TIME,
          input: { command: "gh pr create --fill" },
          output: `${prUrl}\n`,
        },
        // Later in the timeline the SAME PR is merely re-mentioned in a recap.
        {
          name: "Bash",
          timestamp: REMENTION_TIME,
          input: { command: `echo "everything is on ${prUrl}"` },
          output: `${prUrl}\n`,
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const created = refs.find(
      (r) => r.targetKind === "pull_request" && r.relation === "created"
    );
    // The created marker anchors to the OPEN turn, not the last mention.
    assert.ok(created, "expected a created PR ref");
    assert.equal(created?.observedAt, CREATE_TIME);
    assert.notEqual(created?.observedAt, REMENTION_TIME);
    // The re-mention surfaces as a `referenced` ref (mints no marker), so it
    // cannot drag the open dot forward.
    const referenced = refs.find(
      (r) => r.targetKind === "pull_request" && r.relation === "referenced"
    );
    assert.ok(referenced, "re-mention still detected as a referenced PR");
  });

  test("referenced-only PR mention keeps the session-scoped observedAt (mints no marker)", () => {
    // FEA-3635 deliberately does NOT stamp a referenced ref from its mention's
    // event time: only created/workspace relations mint a lifecycle marker, and
    // dating a re-mention would let it drag the PR-open marker forward. That
    // choice is unchanged here. ISS-5236 only changes what the non-event branch
    // resolves TO — the session's own start instead of the import wall clock —
    // so the mention's own timestamp (2026-06-08) is still correctly ignored.
    const session = makeSession({
      toolUses: [
        {
          name: "Read",
          timestamp: "2026-06-08T10:00:00.000Z",
          input: { file: "README.md" },
          output:
            "See https://github.com/closedloop-ai/symphony-alpha/pull/10 for context.",
        },
      ],
    });
    const prRef = extractArtifactRefs(session, NOW).find(
      (r) => r.targetKind === "pull_request" && r.relation === "referenced"
    );
    assert.ok(prRef);
    assert.equal(prRef?.observedAt, SESSION_STARTED_AT);
    assert.notEqual(prRef?.observedAt, NOW);
  });

  test("a FEAT slug referenced in the transcript is linked to the session (comment 1)", () => {
    // The recap names FEA-3628 as a TODO — the extractor must surface it as a
    // closedloop_artifact ref so the session→FEAT link can be shown on detail.
    const session = makeSession({
      messages: [
        {
          role: "assistant",
          timestamp: null,
          text: "Recap: FEA-3628 — pack-scanner worker, assigned to Mike.",
        },
      ],
    });
    const featRef = extractArtifactRefs(session, NOW).find(
      (r) =>
        r.targetKind === "closedloop_artifact" &&
        r.targetIdentity === "FEA-3628"
    );
    assert.ok(featRef, "expected a FEA-3628 closedloop_artifact ref");
    assert.equal(featRef?.slug, "FEA-3628");
  });
});

// ---------------------------------------------------------------------------
// ISS-5236: observed_at is source-derived, never the import wall clock
// ---------------------------------------------------------------------------

/**
 * A session that exercises every scan-time ref family at once — the ones that
 * had NO event of their own to date them and so were all stamped with the
 * caller's `now` before ISS-5236: `start_branch` (from `session.gitBranch`),
 * `slug_in_cwd`, `slug_in_session_slug`, plus commit and MCP refs.
 */
function makeScanTimeRefSession(): NormalizedSession {
  return makeSession({
    gitBranch: "feat/iss-5236-observed-at",
    // The slug must be the LAST path component for `slug_in_cwd` to fire, and
    // each family needs a DISTINCT slug — same-slug `closedloop_artifact` refs
    // dedup to one by canonical key, which would hide a family from this sweep.
    cwd: "/work/PLN-657",
    slug: "PRD-516",
    toolUses: [
      {
        name: "Bash",
        timestamp: null,
        input: { command: "git log --oneline -1" },
        output: "abc1234 feat: land the thing\n",
      },
    ],
  });
}

describe("ISS-5236: scan-time observed_at is source-derived", () => {
  test("the caller's import clock reaches NO emitted ref", () => {
    const refs = extractArtifactRefs(makeScanTimeRefSession(), NOW);

    assert.ok(
      refs.length > 0,
      "fixture must emit refs for this to mean anything"
    );
    const leaked = refs.filter((r) => r.observedAt === NOW);
    assert.deepEqual(
      leaked.map((r) => `${r.method}:${r.targetIdentity}`),
      [],
      "no ref may carry the import wall clock as its observed_at"
    );
  });

  test("every scan-time ref is stamped with the session's own start", () => {
    const refs = extractArtifactRefs(makeScanTimeRefSession(), NOW);
    const scanTimeMethods = [
      "start_branch",
      "slug_in_cwd",
      "slug_in_session_slug",
    ];

    for (const method of scanTimeMethods) {
      const ref = refs.find((r) => r.method === method);
      assert.ok(ref, `fixture must emit a ${method} ref`);
      assert.equal(
        ref?.observedAt,
        SESSION_STARTED_AT,
        `${method} must be dated from session start, not the import clock`
      );
    }
  });

  test("re-importing the same session at a later clock yields identical observed_at", () => {
    // This is the property ISS-5148 needed and could not get: the import clock
    // advances between the first import and every later DATA_REVISION rebuild,
    // so an import-clock observed_at churned on every rebuild and defeated the
    // synced-child-row "true sync no-op" path. Source-derived values are stable.
    const MUCH_LATER = "2029-09-09T09:09:09.000Z";
    const first = extractArtifactRefs(makeScanTimeRefSession(), NOW);
    const second = extractArtifactRefs(makeScanTimeRefSession(), MUCH_LATER);

    assert.deepEqual(
      second.map((r) => r.observedAt),
      first.map((r) => r.observedAt),
      "a rebuild at a later clock must not move any ref's observed_at"
    );
  });

  test("a ref WITH its own event instant still keeps that instant, not session start", () => {
    // The fix must not flatten every ref onto session start — a ref derived from
    // a dated transcript event is still dated from that event.
    const TOOL_TIME = "2024-01-01T06:30:00.000Z";
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: TOOL_TIME,
          input: { command: "git push -u origin feat/iss-5236" },
        },
      ],
    });
    const branchRef = extractArtifactRefs(session, NOW).find(
      (r) => r.targetKind === "branch" && r.method === "git_push"
    );
    assert.ok(branchRef);
    assert.equal(branchRef?.observedAt, TOOL_TIME);
    assert.notEqual(branchRef?.observedAt, SESSION_STARTED_AT);
    assert.notEqual(branchRef?.observedAt, NOW);
  });

  test("the launch-metadata ref is dated from the caller's session instant", () => {
    // `.closedloop-ai/work/launch-metadata.json` is written ONCE, at launch, so
    // the session's start is its honest observation instant. write-core passes
    // `resolveSessionObservedAt(session, now)` rather than the bare import clock.
    const refs = extractLaunchMetadataRefs(
      { sourceArtifactId: "ISS-5236" },
      resolveSessionObservedAt(makeScanTimeRefSession(), NOW)
    );
    assert.equal(refs.length, 1);
    assert.equal(refs[0]?.observedAt, SESSION_STARTED_AT);
    assert.notEqual(refs[0]?.observedAt, NOW);
  });
});

describe("ISS-5236: resolveSessionObservedAt precedence", () => {
  test("the session's startedAt wins over the caller's import clock", () => {
    assert.equal(
      resolveSessionObservedAt({ startedAt: SESSION_STARTED_AT }, NOW),
      SESSION_STARTED_AT
    );
  });

  test("a session with no startedAt degrades to the caller's clock, never throws", () => {
    // `startedAt` falsy means the parser returned null and the caller skipped the
    // session (packages/lib/harness/types.ts), so this branch is unreachable in
    // production. It degrades to exactly the pre-ISS-5236 value rather than
    // aborting an import, because `session_artifact_links.observed_at` is
    // TEXT NOT NULL and an import must not fail on a malformed partial parse.
    assert.equal(resolveSessionObservedAt({ startedAt: null }, NOW), NOW);
  });

  test("always returns a non-empty string — the column is NOT NULL", () => {
    const resolved = resolveSessionObservedAt({ startedAt: null }, undefined);
    assert.equal(typeof resolved, "string");
    assert.ok(resolved.length > 0);
    assert.ok(
      !Number.isNaN(Date.parse(resolved)),
      "the fallback must still be a parseable instant"
    );
  });
});

describe("ISS-5236: the dedup survivor carries the event instant", () => {
  const MESSAGE_TIME = "2024-01-01T06:30:00.000Z";
  const TOOL_TIME = "2024-01-01T07:45:00.000Z";
  const SLUG = "ISS-5236";
  const SLUG_URL = `https://app.closedloop.ai/my-org/issues/${SLUG}`;

  /**
   * A Closedloop URL and its bare slug collapse onto ONE link row: both push
   * `closedloop_artifact|<slug>|input`, and `deduplicateRefs` keeps the winner
   * WHOLESALE (no field merge, no earliest-wins on `observedAt`). `url_match`
   * outranks `slug_match_in_prose` in CONFIDENCE_RANK and its pass runs FIRST,
   * so the URL record is always the survivor — which is why dating only the
   * bare-slug pass left the event instant unreachable in the persisted row.
   */
  function inputRefsFor(session: NormalizedSession) {
    return extractArtifactRefs(session, NOW).filter(
      (r) => r.targetIdentity === SLUG && r.relation === "input"
    );
  }

  test("a slug and its URL in one message keep the message instant", () => {
    const refs = inputRefsFor(
      makeSession({
        messages: [
          {
            role: "human",
            timestamp: MESSAGE_TIME,
            text: `${SLUG} — see ${SLUG_URL} for details.`,
          },
        ],
      })
    );
    assert.equal(
      refs.length,
      1,
      "the URL and the bare slug must collapse onto one link row"
    );
    // Assert the SURVIVOR is the url_match record, so a regression cannot pass
    // by having the bare-slug record win dedup instead.
    assert.equal(refs[0].confidence, "url_match");
    assert.equal(refs[0].observedAt, MESSAGE_TIME);
    assert.notEqual(refs[0].observedAt, SESSION_STARTED_AT);
    assert.notEqual(refs[0].observedAt, NOW);
  });

  test("a URL in tool input keeps the tool-use instant", () => {
    const refs = inputRefsFor(
      makeSession({
        toolUses: [
          {
            name: "Bash",
            timestamp: TOOL_TIME,
            input: { command: `curl ${SLUG_URL}` },
          },
        ],
      })
    );
    assert.equal(refs.length, 1);
    assert.equal(refs[0].confidence, "url_match");
    assert.equal(refs[0].observedAt, TOOL_TIME);
    assert.notEqual(refs[0].observedAt, NOW);
  });

  test("a URL on an undated message still falls back to session start", () => {
    const refs = inputRefsFor(
      makeSession({
        messages: [{ role: "human", timestamp: null, text: `See ${SLUG_URL}` }],
      })
    );
    assert.equal(refs.length, 1);
    assert.equal(refs[0].observedAt, SESSION_STARTED_AT);
    assert.notEqual(refs[0].observedAt, NOW);
  });
});

describe("ISS-5236: an unparseable source instant is never persisted", () => {
  // `toIso` (@repo/lib/harness/parser-utils) returns an unparseable string
  // VERBATIM instead of null, and Claude's `isoTs` does no parsing at all — both
  // deliberately mirror the vendors' leniency. So junk genuinely reaches
  // `session.startedAt` on every harness and `NormalizedToolUse.timestamp` on
  // OpenCode, whose values come from arbitrary TEXT columns in the user's
  // `opencode.db`. A `??` chain would PREFER that junk, because it is non-null.
  const JUNK = "not-a-timestamp";

  test("resolveRefObservedAt rejects a junk event instant", () => {
    assert.equal(
      resolveRefObservedAt(JUNK, SESSION_STARTED_AT),
      SESSION_STARTED_AT
    );
    assert.equal(
      resolveRefObservedAt("", SESSION_STARTED_AT),
      SESSION_STARTED_AT
    );
    assert.equal(
      resolveRefObservedAt(null, SESSION_STARTED_AT),
      SESSION_STARTED_AT
    );
  });

  test("resolveRefObservedAt still prefers a real event instant", () => {
    // The opposite branch must fail if validation over-rejects: a valid instant
    // has to win, or the fix would flatten every dated ref onto session start.
    const TOOL_TIME = "2024-01-01T06:30:00.000Z";
    assert.equal(
      resolveRefObservedAt(TOOL_TIME, SESSION_STARTED_AT),
      TOOL_TIME
    );
  });

  test("resolveSessionObservedAt rejects a junk startedAt", () => {
    assert.equal(resolveSessionObservedAt({ startedAt: JUNK }, NOW), NOW);
  });

  test("resolveSessionObservedAt falls past a junk import clock too", () => {
    const resolved = resolveSessionObservedAt({ startedAt: JUNK }, JUNK);
    assert.notEqual(resolved, JUNK);
    assert.ok(Number.isFinite(Date.parse(resolved)));
  });

  test("no emitted ref carries an unparseable observed_at", () => {
    // The end-to-end property, driven through the production entry point on an
    // OpenCode-shaped session: junk on BOTH the session start and the tool use.
    // `session_artifact_links.observed_at` is TEXT NOT NULL and rides the wire as
    // `artifactRef.observedAt`, where the cloud validates the whole payload in
    // ONE parse — so a single bad row 400s up to 200 sessions and re-fails on
    // every retry until it dead-letters.
    const session = makeSession({
      startedAt: JUNK,
      gitBranch: "feat/ISS-5236-observed-at",
      cwd: "/tmp/ISS-5236",
      messages: [
        { role: "human", timestamp: JUNK, text: "working on ISS-5236" },
      ],
      toolUses: [
        {
          name: "Bash",
          timestamp: JUNK,
          input: { command: "git push -u origin feat/ISS-5236-observed-at" },
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    assert.ok(refs.length > 0, "the fixture must actually emit refs");
    for (const ref of refs) {
      assert.ok(
        Number.isFinite(Date.parse(ref.observedAt)),
        `${ref.method} emitted an unparseable observed_at: ${ref.observedAt}`
      );
      assert.notEqual(ref.observedAt, JUNK);
    }
  });
});

describe("ISS-5427: the stamped instant is always canonical UTC 'Z'", () => {
  // ISS-5236 replaced the import wall clock (canonical by construction) with the
  // harness-supplied instant, and the resolver only VALIDATED it. Claude's
  // `isoTs` returns a transcript string UNCHANGED, so an offset-form value now
  // reaches `session_artifact_links.observed_at` — a TEXT column every consumer
  // compares lexically: `artifact-link-persistence`'s set-once
  // `first_pushed_at = MIN(COALESCE(first_pushed_at, $2), $2)`, and the
  // `ORDER BY sal.observed_at` reads in `branch-reads` / `component-invocations`.
  const OFFSET_FORM = "2026-08-06T10:00:00-05:00";
  /** The SAME instant as OFFSET_FORM, re-expressed in UTC. */
  const OFFSET_FORM_AS_UTC = "2026-08-06T15:00:00.000Z";

  test("resolveSessionObservedAt canonicalizes an offset-form startedAt", () => {
    const resolved = resolveSessionObservedAt({ startedAt: OFFSET_FORM }, NOW);
    assert.equal(resolved, OFFSET_FORM_AS_UTC);
    assert.ok(isCanonicalUtcTimestamp(resolved));
    // The instant is preserved — only its spelling changed.
    assert.equal(Date.parse(resolved), Date.parse(OFFSET_FORM));
  });

  test("resolveSessionObservedAt canonicalizes an offset-form import clock", () => {
    const resolved = resolveSessionObservedAt({ startedAt: null }, OFFSET_FORM);
    assert.equal(resolved, OFFSET_FORM_AS_UTC);
  });

  test("resolveRefObservedAt canonicalizes an offset-form event instant", () => {
    const resolved = resolveRefObservedAt(OFFSET_FORM, SESSION_STARTED_AT);
    assert.equal(resolved, OFFSET_FORM_AS_UTC);
    assert.equal(Date.parse(resolved), Date.parse(OFFSET_FORM));
  });

  test("a whole-second 'Z' instant is widened to millisecond precision", () => {
    // Mixed precision is wrong in the direction that matters: `…:00Z` sorts
    // AFTER `…:00.500Z` byte-wise (`Z` 0x5A > `.` 0x2E) while being the EARLIER
    // instant — the same defect ISS-5330 fixed in the heal predicate.
    assert.equal(
      resolveRefObservedAt("2026-08-06T15:00:00Z", SESSION_STARTED_AT),
      "2026-08-06T15:00:00.000Z"
    );
  });

  test("an offset-form push ref sorts AFTER an earlier canonical one", () => {
    // The defect end to end, on the comparison that actually loses data: SQLite
    // `MIN()` over TEXT is a string compare, so before this fix the `-05:00`
    // value — a LATER instant — won the earliest-wins `first_pushed_at` slot.
    const earlierInstant = "2026-08-06T12:00:00.000Z";
    const stamped = resolveRefObservedAt(OFFSET_FORM, SESSION_STARTED_AT);
    assert.ok(
      Date.parse(earlierInstant) < Date.parse(OFFSET_FORM),
      "fixture must pin the canonical value as the EARLIER instant"
    );
    assert.ok(
      earlierInstant < stamped,
      "lexical order must now agree with chronological order"
    );
    assert.ok(
      OFFSET_FORM < earlierInstant,
      "the raw offset form must be the case that sorted wrong"
    );
  });

  test("every ref an offset-form session emits is canonical", () => {
    // The end-to-end property through the production entry point: a Claude-shaped
    // session whose `startedAt` and tool-use timestamps are both offset-form.
    const session = makeSession({
      startedAt: OFFSET_FORM,
      gitBranch: "feat/ISS-5427-observed-at",
      cwd: "/tmp/ISS-5427",
      messages: [
        { role: "human", timestamp: OFFSET_FORM, text: "working on ISS-5427" },
      ],
      toolUses: [
        {
          name: "Bash",
          timestamp: OFFSET_FORM,
          input: { command: "git push -u origin feat/ISS-5427-observed-at" },
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    assert.ok(refs.length > 0, "the fixture must actually emit refs");
    for (const ref of refs) {
      assert.ok(
        isCanonicalUtcTimestamp(ref.observedAt),
        `${ref.method} emitted a non-canonical observed_at: ${ref.observedAt}`
      );
    }
  });
});
