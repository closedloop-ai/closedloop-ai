import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { encodeBranchId } from "@repo/api/src/types/branch.js";
import {
  BranchTraceCompletenessState,
  BranchTraceSessionHydrationState,
  BranchTraceUnavailableReason,
  normalizeBranchTraceResult,
} from "@repo/api/src/types/branch-trace.js";
import { getSharedBranchTrace } from "../src/main/branch/shared-branch-trace.js";
import {
  link,
  makeSource,
  syncedSession,
} from "./shared-branches-test-helpers.js";

const branchId = encodeBranchId({
  repoFullName: "acme/web",
  branchName: "feature/x",
});
const PRIVATE_IPC_DETAIL_RE = /private IPC detail/;

describe("getSharedBranchTrace", () => {
  test("synthesizes one ordered session start per Session and an idle gap", async () => {
    const source = makeSource({
      links: [link({ session_id: "s1" }), link({ session_id: "s2" })],
      sessions: [
        syncedSession({
          externalSessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
        }),
        syncedSession({
          externalSessionId: "s2",
          startedAt: "2026-06-10T12:00:00.000Z",
        }),
      ],
    });

    const result = await getSharedBranchTrace(source, branchId);
    const starts = result.items.filter((item) => item.type === "sessionstart");
    const idle = result.items.find((item) => item.type === "idle");

    assert.deepEqual(
      starts.map((item) => item.sessionId),
      ["s1", "s2"]
    );
    assert.ok(idle?.type === "idle" && idle.gapMs >= 120_000);
  });

  test("returns honest empty evidence for missing sources and unmatched branches", async () => {
    const missing = await getSharedBranchTrace(null, branchId);
    const empty = await getSharedBranchTrace(makeSource({}), branchId);
    const unmatched = await getSharedBranchTrace(
      makeSource({ links: [link({ branch_name: "other" })] }),
      branchId
    );

    assert.equal(missing.qualifyingSessionCount, null);
    assert.deepEqual(empty.items, []);
    assert.deepEqual(unmatched.items, []);
  });

  test("enumerates 0, 1, 30, 31, and many Sessions through one cache-preserving db-host call", async () => {
    for (const count of [0, 1, 30, 31, 125]) {
      const ids = Array.from(
        { length: count },
        (_, index) => `session-${String(index).padStart(3, "0")}`
      );
      const requestSizes: number[] = [];
      const source = makeSource({
        links: ids.map((sessionId, index) =>
          link({
            session_id: sessionId,
            observed_at: new Date(
              Date.UTC(2026, 5, 10, 10, 0, index)
            ).toISOString(),
          })
        ),
        sessions: ids.map((externalSessionId) =>
          syncedSession({ externalSessionId })
        ),
      });
      const originalLoader = source.syncSource?.loadSyncedSessions;
      assert.ok(originalLoader);
      source.syncSource = {
        ...source.syncSource,
        loadSyncedSessions: (...args) => {
          requestSizes.push(args[0].length);
          return originalLoader(...args);
        },
      };

      const result = await getSharedBranchTrace(source, branchId);

      assert.equal(result.qualifyingSessionCount, count);
      assert.equal(result.sessions.length, count);
      assert.equal(
        result.completeness.state,
        BranchTraceCompletenessState.Complete
      );
      assert.deepEqual(requestSizes, [count]);
    }
  });

  test("dedupes identities, tie-breaks by id, and ignores loader return order", async () => {
    const source = makeSource({
      links: [
        link({ session_id: "s2" }),
        link({ session_id: "s1" }),
        link({ session_id: "s1" }),
      ],
      sessions: [
        syncedSession({ externalSessionId: "s1" }),
        syncedSession({ externalSessionId: "s2" }),
      ],
    });
    const originalLoader = source.syncSource?.loadSyncedSessions;
    assert.ok(originalLoader);
    source.syncSource = {
      ...source.syncSource,
      loadSyncedSessions: async (...args) =>
        (await originalLoader(...args)).toReversed(),
    };

    const result = await getSharedBranchTrace(source, branchId);

    assert.deepEqual(
      result.sessions.map(({ identity }) => identity.artifactId),
      ["s1", "s2"]
    );
    assert.equal(result.qualifyingSessionCount, 2);
  });

  test("retains missing, malformed, and cancelled identities with typed provenance", async () => {
    const ids = ["s1", "s2", "s3", "s4", "s5"];
    const source = makeSource({
      links: ids.map((sessionId) => link({ session_id: sessionId })),
    });
    source.syncSource = {
      ...source.syncSource,
      loadSyncedSessions: () =>
        Promise.resolve([
          syncedSession({ externalSessionId: "s1" }),
          syncedSession({ externalSessionId: "s4", startedAt: "malformed" }),
        ]),
    };

    const result = await getSharedBranchTrace(source, branchId);
    const reasonById = new Map(
      result.sessions.map((session) => [
        session.identity.artifactId,
        session.state === BranchTraceSessionHydrationState.Unavailable
          ? session.reason
          : null,
      ])
    );

    assert.equal(reasonById.get("s1"), null);
    assert.equal(reasonById.get("s2"), BranchTraceUnavailableReason.NotFound);
    assert.equal(reasonById.get("s3"), BranchTraceUnavailableReason.NotFound);
    assert.equal(reasonById.get("s4"), BranchTraceUnavailableReason.Malformed);
    assert.equal(reasonById.get("s5"), BranchTraceUnavailableReason.NotFound);
    assert.equal(
      result.aggregateCompleteness.state,
      BranchTraceCompletenessState.Incomplete
    );
  });

  test("classifies a rejected db-host hydration call for every retained identity", async () => {
    const source = makeSource({
      links: [link({ session_id: "s1" }), link({ session_id: "s2" })],
    });
    source.syncSource = {
      ...source.syncSource,
      loadSyncedSessions: () =>
        Promise.reject(
          Object.assign(new Error("cancelled"), { name: "AbortError" })
        ),
    };

    const result = await getSharedBranchTrace(source, branchId);

    assert.deepEqual(
      result.sessions.map((session) =>
        session.state === BranchTraceSessionHydrationState.Unavailable
          ? session.reason
          : null
      ),
      [
        BranchTraceUnavailableReason.Cancelled,
        BranchTraceUnavailableReason.Cancelled,
      ]
    );
  });

  test("status evidence wins over AbortError and database failures are unknown", async () => {
    const source = makeSource({ links: [link({ session_id: "s1" })] });
    source.syncSource = {
      ...source.syncSource,
      loadSyncedSessions: () =>
        Promise.reject({ name: "AbortError", status: 401 }),
    };
    const authentication = await getSharedBranchTrace(source, branchId);
    const readFailureSource = makeSource({});
    readFailureSource.prisma.client.sessionArtifactLink.findMany = () =>
      Promise.reject(new Error("database unavailable"));
    const readFailure = await getSharedBranchTrace(readFailureSource, branchId);

    assert.equal(
      authentication.sessions[0]?.state ===
        BranchTraceSessionHydrationState.Unavailable
        ? authentication.sessions[0].reason
        : null,
      BranchTraceUnavailableReason.Authentication
    );
    assert.equal(
      readFailure.completeness.reason,
      BranchTraceUnavailableReason.Unknown
    );
  });

  test("the structured-clone IPC envelope normalizes additively without leaking raw fields", async () => {
    const source = makeSource({
      links: [link({ session_id: "s1" })],
      sessions: [syncedSession({ externalSessionId: "s1" })],
    });
    const produced = await getSharedBranchTrace(source, branchId);
    const cloned = structuredClone({
      ...produced,
      futureEnvelopeField: true,
      items: produced.items.map((item) => ({
        ...item,
        rawError: "private IPC detail",
      })),
    });

    const normalized = normalizeBranchTraceResult(cloned);

    assert.equal(normalized.qualifyingSessionCount, 1);
    assert.equal(
      normalized.sessions[0]?.state,
      BranchTraceSessionHydrationState.Loaded
    );
    assert.doesNotMatch(JSON.stringify(normalized), PRIVATE_IPC_DETAIL_RE);
  });
});
