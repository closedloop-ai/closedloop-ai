/**
 * @file write-core-pull-requests-observed-at.test.ts
 * @description ISS-5427: the SECOND writer of `session_artifact_links.observed_at`.
 *
 * `persistNormalizedPullRequests` derives one `observedAt` from the session's own
 * `startedAt`/`endedAt` and writes it to three lexically-compared TEXT columns —
 * the `referenced` artifact link's `observed_at`, `artifacts.observed_at`, and
 * `pull_requests.observed_at`. `maxIso` picks the right operand (it compares by
 * INSTANT) but `validIso` returns it VERBATIM, and Claude's `isoTs` passes a
 * transcript string through unparsed, so an offset-form value used to land in the
 * very columns the resolver and the boot heal exist to keep single-format.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isCanonicalUtcTimestamp } from "../src/main/database/session-timestamp-form.js";
import { persistNormalizedPullRequests } from "../src/main/database/write-core-pull-requests.js";
import { makeSession } from "./normalized-session-test-utils.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const REPO = "closedloop-ai/symphony-alpha";
const PR_URL = `https://github.com/${REPO}/pull/5427`;
const NOW = "2026-08-07T00:00:00.000Z";
/** Offset form, as Claude's pass-through `isoTs` can leave `startedAt`. */
const OFFSET_STARTED_AT = "2026-08-06T10:00:00-05:00";
/** The SAME instant as OFFSET_STARTED_AT, re-expressed in UTC. */
const OFFSET_STARTED_AT_AS_UTC = "2026-08-06T15:00:00.000Z";

test("ISS-5427: an offset-form session start is canonicalized on every observed_at the PR writer touches", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await store.query(
      `INSERT INTO sessions (id, status, started_at, updated_at, harness, billing_mode)
       VALUES ($1, 'completed', $2, $2, 'claude', 'metered_api')`,
      ["s-5427", NOW]
    );
    const session = makeSession({
      sessionId: "s-5427",
      startedAt: OFFSET_STARTED_AT,
      endedAt: null,
      artifacts: {
        repo: REPO,
        prs: [{ number: "5427", url: PR_URL }],
        issues: [],
      },
    });

    const captured = await prisma.write((client) =>
      client.$transaction((tx) =>
        persistNormalizedPullRequests(
          tx,
          session,
          "claude",
          NOW,
          new Map(),
          new Map()
        )
      )
    );
    assert.equal(captured, 1, "the fixture must actually persist a PR");

    const links = await prisma.client.$queryRawUnsafe<
      { observed_at: string }[]
    >(
      "SELECT observed_at FROM session_artifact_links WHERE session_id = $1",
      "s-5427"
    );
    assert.equal(links.length, 1);
    assert.equal(links[0].observed_at, OFFSET_STARTED_AT_AS_UTC);
    assert.ok(isCanonicalUtcTimestamp(links[0].observed_at));

    const artifacts = await prisma.client.$queryRawUnsafe<
      { observed_at: string | null }[]
    >("SELECT observed_at FROM artifacts WHERE kind = 'pull_request'");
    assert.equal(artifacts[0].observed_at, OFFSET_STARTED_AT_AS_UTC);

    const prs = await prisma.client.$queryRawUnsafe<
      { observed_at: string | null }[]
    >("SELECT observed_at FROM pull_requests");
    assert.equal(prs[0].observed_at, OFFSET_STARTED_AT_AS_UTC);
  } finally {
    await close();
  }
});

test("ISS-5427: a legacy offset-form stored observed_at is canonicalized when it wins the merge", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await store.query(
      `INSERT INTO sessions (id, status, started_at, updated_at, harness, billing_mode)
       VALUES ($1, 'completed', $2, $2, 'claude', 'metered_api')`,
      ["s-5427", NOW]
    );
    const session = makeSession({
      sessionId: "s-5427",
      // Earlier than the legacy stored value below, so the STORED side wins the
      // `maxIso` and is the operand written back.
      startedAt: "2026-08-06T09:00:00.000Z",
      endedAt: null,
      artifacts: {
        repo: REPO,
        prs: [{ number: "5427", url: PR_URL }],
        issues: [],
      },
    });
    const persist = () =>
      prisma.write((client) =>
        client.$transaction((tx) =>
          persistNormalizedPullRequests(
            tx,
            session,
            "claude",
            NOW,
            new Map(),
            new Map()
          )
        )
      );

    await persist();
    // Stand in for a row written before the write path canonicalized: an offset
    // form that is the LATER instant, so `maxIso` prefers it on the next merge.
    await store.query("UPDATE pull_requests SET observed_at = $1", [
      OFFSET_STARTED_AT,
    ]);

    await persist();

    const prs = await prisma.client.$queryRawUnsafe<{ observed_at: string }[]>(
      "SELECT observed_at FROM pull_requests"
    );
    assert.equal(prs[0].observed_at, OFFSET_STARTED_AT_AS_UTC);
    assert.ok(isCanonicalUtcTimestamp(prs[0].observed_at));
  } finally {
    await close();
  }
});
