/**
 * @file local-invocation-read-ancestry.test.ts
 * @description ISS-10714: the DESKTOP-LOCAL read publishes the reconstructed
 * call chain, so LocalElectron does not drop the depth the cloud read carries
 * for the same record (whitlockk review).
 *
 * The prisma double answers the reader's three statements by SQL shape, which is
 * what lets a page assert the EDGE query actually ran and what it was scoped to
 * — a double that returned the same rows whatever it was asked would prove
 * nothing about the session scoping below.
 */

import assert from "node:assert/strict";
import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
} from "@repo/api/src/types/agent-component-invocation";
import { test } from "vitest";
import { readAgentComponentInvocationPage } from "../src/main/dashboard/local-invocation-read.js";

const COMPONENT_KEY = "code-review-worker";
const KIND = AgentComponentInvocationKind.Subagent;

type Edge = {
  session_id: string;
  external_invocation_id: string;
  parent_external_invocation_id: string | null;
};

function localRow(
  id: string,
  externalInvocationId: string,
  parentExternalInvocationId: string | null,
  componentKind: string = KIND,
  sessionId = "session-1"
) {
  return {
    id,
    session_id: sessionId,
    external_invocation_id: externalInvocationId,
    child_session_id: null,
    component_kind: componentKind,
    component_key: COMPONENT_KEY,
    raw_name: null,
    normalized_name: null,
    relationship: AgentComponentInvocationRelationship.Direct,
    invoked_at: null,
    sequence: 0,
    anchor_kind: AgentComponentInvocationAnchorKind.Session,
    anchor_value: sessionId,
    provider_tool_use_id: null,
    attribution_status: AgentComponentInvocationAttributionStatus.Matched,
    evidence_class: AgentComponentInvocationEvidenceClass.None,
    evidence_pointer:
      parentExternalInvocationId === null
        ? null
        : JSON.stringify({ parentExternalInvocationId }),
    definition_hash: null,
    normalizer_contract_version: null,
    local_component_version_id: null,
    git_branch: null,
    repository_full_name: null,
  };
}

async function readRows(rows: ReturnType<typeof localRow>[], edges: Edge[]) {
  const edgeQueries: unknown[][] = [];
  const queryRawUnsafe = (sql: string, ...params: unknown[]) => {
    if (sql.includes("SELECT DISTINCT component_key")) {
      return Promise.resolve([{ component_key: COMPONENT_KEY }]);
    }
    if (sql.includes("COUNT(*) AS total")) {
      return Promise.resolve([
        { total: rows.length, unmatched_count: 0, ambiguous_count: 0 },
      ]);
    }
    if (sql.includes("parent_external_invocation_id")) {
      edgeQueries.push(params);
      const sessionIds = new Set(params.slice(1));
      return Promise.resolve(
        edges.filter((edge) => sessionIds.has(edge.session_id))
      );
    }
    return Promise.resolve(rows);
  };
  const prisma = { client: { $queryRawUnsafe: queryRawUnsafe } };
  const page = await readAgentComponentInvocationPage(
    prisma as unknown as Parameters<typeof readAgentComponentInvocationPage>[0],
    KIND,
    COMPONENT_KEY,
    []
  );
  if (!page) {
    throw new Error("expected the reader to return a page");
  }
  return { items: page.items, edgeQueries };
}

test("desktop local read publishes the off-page ancestor chain and its depth", async () => {
  // Only the leaf is on the page; `mid` and `root` are two hops away and live in
  // the session's edge set, which is exactly the case a component-scoped read
  // cannot answer from the page alone.
  const { items, edgeQueries } = await readRows(
    [localRow("row-leaf", "leaf", "mid")],
    [
      {
        session_id: "session-1",
        external_invocation_id: "leaf",
        parent_external_invocation_id: "mid",
      },
      {
        session_id: "session-1",
        external_invocation_id: "mid",
        parent_external_invocation_id: "root",
      },
      {
        session_id: "session-1",
        external_invocation_id: "root",
        parent_external_invocation_id: null,
      },
    ]
  );

  assert.deepEqual(items[0]?.ancestry, {
    chain: ["mid", "root"],
    depthFromRootInvocation: 2,
  });
  assert.equal(edgeQueries.length, 1);
  assert.deepEqual(edgeQueries[0], [KIND, "session-1"]);
});

test("desktop local read keeps two sessions apart when they reuse one invocation id", async () => {
  // `shared` exists in both sessions with DIFFERENT parents. A session-agnostic
  // edge index resolves one session's chain through the other's row.
  const { items } = await readRows(
    [
      localRow("row-a", "shared", "one-root", KIND, "session-1"),
      localRow("row-b", "shared", "two-mid", KIND, "session-2"),
    ],
    [
      {
        session_id: "session-1",
        external_invocation_id: "shared",
        parent_external_invocation_id: "one-root",
      },
      {
        session_id: "session-1",
        external_invocation_id: "one-root",
        parent_external_invocation_id: null,
      },
      {
        session_id: "session-2",
        external_invocation_id: "shared",
        parent_external_invocation_id: "two-mid",
      },
      {
        session_id: "session-2",
        external_invocation_id: "two-mid",
        parent_external_invocation_id: "two-root",
      },
      {
        session_id: "session-2",
        external_invocation_id: "two-root",
        parent_external_invocation_id: null,
      },
    ]
  );

  assert.deepEqual(items[0]?.ancestry?.chain, ["one-root"]);
  assert.deepEqual(items[1]?.ancestry?.chain, ["two-mid", "two-root"]);
});

test("desktop local read omits ancestry for a kind no parent linker runs for", async () => {
  // The edge row EXISTS, so a walk would have resolved. The refusal has to come
  // from the kind: a `0` depth on a skill row is a confident false root.
  const { items, edgeQueries } = await readRows(
    [
      localRow(
        "row-skill",
        "skill-a",
        null,
        AgentComponentInvocationKind.Skill
      ),
    ],
    [
      {
        session_id: "session-1",
        external_invocation_id: "skill-a",
        parent_external_invocation_id: null,
      },
    ]
  );

  assert.ok(items[0]);
  assert.equal(Object.hasOwn(items[0], "ancestry"), false);
  assert.equal(edgeQueries.length, 0);
});

test("desktop local read omits ancestry rather than truncating a dangling chain", async () => {
  const { items } = await readRows(
    [localRow("row-leaf", "leaf", "gone")],
    [
      {
        session_id: "session-1",
        external_invocation_id: "leaf",
        parent_external_invocation_id: "gone",
      },
    ]
  );

  assert.ok(items[0]);
  assert.equal(Object.hasOwn(items[0], "ancestry"), false);
});

test("desktop local read keeps its rows when the ancestry read rejects", async () => {
  const queryRawUnsafe = (sql: string) => {
    if (sql.includes("SELECT DISTINCT component_key")) {
      return Promise.resolve([{ component_key: COMPONENT_KEY }]);
    }
    if (sql.includes("COUNT(*) AS total")) {
      return Promise.resolve([
        { total: 1, unmatched_count: 0, ambiguous_count: 0 },
      ]);
    }
    if (sql.includes("parent_external_invocation_id")) {
      return Promise.reject(new Error("edge read exploded"));
    }
    return Promise.resolve([localRow("row-leaf", "leaf", "mid")]);
  };
  const prisma = { client: { $queryRawUnsafe: queryRawUnsafe } };
  const page = await readAgentComponentInvocationPage(
    prisma as unknown as Parameters<typeof readAgentComponentInvocationPage>[0],
    KIND,
    COMPONENT_KEY,
    []
  );

  assert.equal(page?.items.length, 1);
  assert.ok(page?.items[0]);
  assert.equal(Object.hasOwn(page.items[0], "ancestry"), false);
});
