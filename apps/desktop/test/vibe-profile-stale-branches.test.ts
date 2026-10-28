import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
} from "@repo/api/src/types/session-artifact-link";
import { afterEach, describe, it } from "vitest";
import { settleStaleBranches } from "../scripts/vibe-profile/settle-stale-branches";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { insertSqliteSession } from "./sqlite-session-fixtures.js";

const NOW = "2026-10-07T00:00:00.000Z";
const WEEKS_AGO = "2026-09-01T10:00:00.000Z";
const YESTERDAY = "2026-10-06T10:00:00.000Z";
const REPOSITORY = "acme-co/acme-web";
const PROSE_METHOD = "pr_mention_in_prose";
const HARNESS_LINK_METHOD = "harness_pr_link";
const dirs: string[] = [];

type Db = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function openStore(): Promise<Db> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vibe-stale-branches-"));
  dirs.push(dir);
  return openSqliteAgentDatabase({
    dataDir: path.join(dir, "store"),
    detectBillingMode: () => "api",
  });
}

async function link(
  db: Db,
  input: {
    session: string;
    kind: "branch" | "pull_request";
    branch?: string | null;
    pr?: number;
    relation: string;
    method: string;
    at: string;
  }
): Promise<void> {
  const id = `${input.kind}:${input.branch ?? ""}:${input.pr ?? ""}:${input.method}`;
  await db.run(
    `INSERT INTO artifacts (id, identity_key, kind, branch_name, pr_number, repo_full_name, observed_at, created_at, last_seen_at)
     VALUES ($1, $1, $2, $3, $4, $5, $6, $6, $6)`,
    id,
    input.kind,
    input.branch ?? null,
    input.pr ?? null,
    input.kind === "pull_request" ? REPOSITORY : null,
    input.at
  );
  await db.run(
    `INSERT INTO session_artifact_links (id, session_id, artifact_id, relation, method, evidence, extractor_version, observed_at, created_at)
     VALUES ($1, $2, $3, $4, $5, '{}', 1, $6, $6)`,
    `link:${id}`,
    input.session,
    id,
    input.relation,
    input.method,
    input.at
  );
}

function openedPullRequests(db: Db) {
  return db.prisma.client.$queryRawUnsafe<
    {
      sessionId: string;
      branchName: string;
      prNumber: number;
      method: string;
    }[]
  >(
    `SELECT l.session_id AS sessionId, a.branch_name AS branchName,
            a.pr_number AS prNumber, l.method
       FROM session_artifact_links l JOIN artifacts a ON a.id = l.artifact_id
      WHERE a.kind = 'pull_request' AND l.relation = 'created'
      ORDER BY a.pr_number`
  );
}

describe("settleStaleBranches", () => {
  it("opens a pull request from the pushing session on a branch pushed over a week ago, numbered past every non-prose ref", async () => {
    const db = await openStore();
    try {
      await insertSqliteSession(db, "s1", { cwd: "/Users/dreyes/acme-web" });
      await link(db, {
        session: "s1",
        kind: "branch",
        branch: "feat/old",
        relation: ArtifactRefRelation.Created,
        method: "git_push",
        at: WEEKS_AGO,
      });
      await link(db, {
        session: "s1",
        kind: "branch",
        branch: "feat/recent",
        relation: ArtifactRefRelation.Created,
        method: "git_push",
        at: YESTERDAY,
      });
      await link(db, {
        session: "s1",
        kind: "pull_request",
        branch: "feat/old",
        pr: 40,
        relation: ArtifactRefRelation.Referenced,
        method: HARNESS_LINK_METHOD,
        at: WEEKS_AGO,
      });
      await link(db, {
        session: "s1",
        kind: "pull_request",
        branch: null,
        pr: 465_049,
        relation: ArtifactRefRelation.Referenced,
        method: PROSE_METHOD,
        at: WEEKS_AGO,
      });

      assert.equal(await settleStaleBranches(db, NOW), 1);

      assert.deepEqual(await openedPullRequests(db), [
        {
          sessionId: "s1",
          branchName: "feat/old",
          prNumber: 41,
          method: ArtifactRefMethod.PrCreateOutput,
        },
      ]);
    } finally {
      await db.close();
    }
  });

  it("leaves a branch alone when its session already opened a pull request", async () => {
    const db = await openStore();
    try {
      await insertSqliteSession(db, "s1", { cwd: "/Users/dreyes/acme-web" });
      await link(db, {
        session: "s1",
        kind: "branch",
        branch: "feat/old",
        relation: ArtifactRefRelation.Created,
        method: "git_push",
        at: WEEKS_AGO,
      });
      await link(db, {
        session: "s1",
        kind: "pull_request",
        branch: "feat/old",
        pr: 40,
        relation: ArtifactRefRelation.Created,
        method: ArtifactRefMethod.PrCreateOutput,
        at: WEEKS_AGO,
      });

      assert.equal(await settleStaleBranches(db, NOW), 0);
    } finally {
      await db.close();
    }
  });

  it("leaves a branch in a repository outside the vibe org alone", async () => {
    const db = await openStore();
    try {
      await insertSqliteSession(db, "s1", { cwd: "/Users/dreyes/acme-web" });
      await link(db, {
        session: "s1",
        kind: "branch",
        branch: "chore/infra",
        relation: ArtifactRefRelation.Created,
        method: "git_push",
        at: WEEKS_AGO,
      });
      await db.run(
        `INSERT INTO artifacts (id, identity_key, kind, branch_name, pr_number, repo_full_name, observed_at, created_at, last_seen_at)
         VALUES ('infra-pr', 'infra-pr', 'pull_request', 'chore/infra', 7, 'acme-co/infra-live', $1, $1, $1)`,
        WEEKS_AGO
      );
      await db.run(
        `INSERT INTO session_artifact_links (id, session_id, artifact_id, relation, method, evidence, extractor_version, observed_at, created_at)
         VALUES ('infra-link', 's1', 'infra-pr', 'referenced', $1, '{}', 1, $2, $2)`,
        HARNESS_LINK_METHOD,
        WEEKS_AGO
      );

      assert.equal(await settleStaleBranches(db, NOW), 0);
    } finally {
      await db.close();
    }
  });
});
