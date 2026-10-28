import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
} from "@repo/api/src/types/session-artifact-link";
import { afterEach, describe, expect, it } from "vitest";
import { settleStaleBranches } from "../scripts/vibe-profile/settle-stale-branches";
import {
  openSqliteAgentDatabase,
  type SqliteAgentDatabase,
} from "../src/main/database/sqlite.js";
import { insertSqliteSession } from "./sqlite-session-fixtures.js";

const NOW = "2026-10-07T00:00:00.000Z";
const WEEKS_AGO = "2026-09-01T10:00:00.000Z";
const EARLIER = "2026-08-20T10:00:00.000Z";
const ACME_WEB = "acme-co/acme-web";
const TOOLKIT = "acme-co/agent-toolkit";
const ACME_CWD = "/Users/dreyes/acme-web";
const GIT_PUSH = "git_push";
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function openStore(): Promise<SqliteAgentDatabase> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vibe-settle-12394-"));
  dirs.push(dir);
  return openSqliteAgentDatabase({
    dataDir: path.join(dir, "store"),
    detectBillingMode: () => "api",
  });
}

let linkSeq = 0;

async function link(
  db: SqliteAgentDatabase,
  input: {
    session: string;
    kind: ArtifactRefTargetKind;
    branch: string | null;
    repo?: string | null;
    pr?: number | null;
    relation: string;
    method: string;
    at: string;
  }
): Promise<void> {
  linkSeq += 1;
  const id = `artifact-${linkSeq}`;
  await db.run(
    `INSERT INTO artifacts (id, identity_key, kind, branch_name, pr_number, repo_full_name, observed_at, created_at, last_seen_at)
     VALUES ($1, $1, $2, $3, $4, $5, $6, $6, $6)`,
    id,
    input.kind,
    input.branch,
    input.pr ?? null,
    input.repo ?? null,
    input.at
  );
  await db.run(
    `INSERT INTO session_artifact_links (id, session_id, artifact_id, relation, method, evidence, extractor_version, observed_at, created_at)
     VALUES ($1, $2, $3, $4, $5, '{}', 1, $6, $6)`,
    `link-${linkSeq}`,
    input.session,
    id,
    input.relation,
    input.method,
    input.at
  );
}

function push(
  session: string,
  branch: string | null,
  at: string,
  extra: { repo?: string | null; method?: string; relation?: string } = {}
) {
  return {
    session,
    kind: ArtifactRefTargetKind.Branch,
    branch,
    repo: extra.repo ?? null,
    relation: extra.relation ?? ArtifactRefRelation.Created,
    method: extra.method ?? GIT_PUSH,
    at,
  };
}

function openedPullRequests(db: SqliteAgentDatabase) {
  return db.prisma.client.$queryRawUnsafe<
    {
      sessionId: string;
      repo: string;
      branchName: string;
      prNumber: number;
      observedAt: string;
      url: string;
    }[]
  >(
    `SELECT l.session_id AS sessionId, a.repo_full_name AS repo,
            a.branch_name AS branchName, a.pr_number AS prNumber,
            l.observed_at AS observedAt, a.url AS url
       FROM session_artifact_links l JOIN artifacts a ON a.id = l.artifact_id
      WHERE a.kind = 'pull_request' AND l.method = $1
      ORDER BY a.repo_full_name, a.pr_number`,
    ArtifactRefMethod.PrCreateOutput
  );
}

describe("settleStaleBranches ordering and resolution", () => {
  it("numbers same-instant pushes by branch name, per repository, opened five minutes after the push", async () => {
    const db = await openStore();
    try {
      await insertSqliteSession(db, "s1", { cwd: ACME_CWD });
      await link(db, push("s1", "feat/zeta", WEEKS_AGO));
      await link(db, push("s1", "feat/alpha", WEEKS_AGO));
      await link(db, push("s1", "feat/tool", WEEKS_AGO, { repo: TOOLKIT }));

      expect(await settleStaleBranches(db, NOW)).toBe(3);

      const opened = "2026-09-01T10:05:00.000Z";
      expect(await openedPullRequests(db)).toEqual([
        {
          sessionId: "s1",
          repo: ACME_WEB,
          branchName: "feat/alpha",
          prNumber: 1,
          observedAt: opened,
          url: `https://github.com/${ACME_WEB}/pull/1`,
        },
        {
          sessionId: "s1",
          repo: ACME_WEB,
          branchName: "feat/zeta",
          prNumber: 2,
          observedAt: opened,
          url: `https://github.com/${ACME_WEB}/pull/2`,
        },
        {
          sessionId: "s1",
          repo: TOOLKIT,
          branchName: "feat/tool",
          prNumber: 1,
          observedAt: opened,
          url: `https://github.com/${TOOLKIT}/pull/1`,
        },
      ]);
    } finally {
      await db.close();
    }
  });

  it("numbers older pushes first, so an earlier branch gets the lower number", async () => {
    const db = await openStore();
    try {
      await insertSqliteSession(db, "s1", { cwd: ACME_CWD });
      await link(db, push("s1", "feat/a-later", WEEKS_AGO));
      await link(db, push("s1", "feat/z-earlier", EARLIER));

      expect(await settleStaleBranches(db, NOW)).toBe(2);

      expect(
        (await openedPullRequests(db)).map((pr) => [pr.branchName, pr.prNumber])
      ).toEqual([
        ["feat/z-earlier", 1],
        ["feat/a-later", 2],
      ]);
    } finally {
      await db.close();
    }
  });

  it("opens the pull request from the session with the latest push of a branch", async () => {
    const db = await openStore();
    try {
      await insertSqliteSession(db, "early", { cwd: ACME_CWD });
      await insertSqliteSession(db, "late", { cwd: ACME_CWD });
      await link(db, push("late", "feat/shared", WEEKS_AGO));
      await link(db, push("early", "feat/shared", EARLIER));

      expect(await settleStaleBranches(db, NOW)).toBe(1);

      expect(
        (await openedPullRequests(db)).map((pr) => [
          pr.sessionId,
          pr.observedAt,
        ])
      ).toEqual([["late", "2026-09-01T10:05:00.000Z"]]);
    } finally {
      await db.close();
    }
  });

  it("skips branch links that are not created pushes, and branches whose repository cannot be resolved", async () => {
    const db = await openStore();
    try {
      await insertSqliteSession(db, "acme", { cwd: ACME_CWD });
      await insertSqliteSession(db, "nowhere", { cwd: "/work/unknown" });
      await link(
        db,
        push("acme", "feat/referenced", WEEKS_AGO, {
          relation: ArtifactRefRelation.Referenced,
        })
      );
      await link(
        db,
        push("acme", "feat/checkout", WEEKS_AGO, { method: "git_checkout" })
      );
      await link(db, push("acme", null, WEEKS_AGO));
      await link(db, push("nowhere", "feat/orphan", WEEKS_AGO));

      expect(await settleStaleBranches(db, NOW)).toBe(0);
      expect(await openedPullRequests(db)).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("names the repository from a pull request on the branch ahead of the session's checkout", async () => {
    const db = await openStore();
    try {
      await insertSqliteSession(db, "s1", { cwd: ACME_CWD });
      await link(db, push("s1", "feat/x", WEEKS_AGO));
      await link(db, {
        session: "s1",
        kind: ArtifactRefTargetKind.PullRequest,
        branch: "feat/x",
        repo: TOOLKIT,
        pr: 12,
        relation: ArtifactRefRelation.Referenced,
        method: "harness_pr_link",
        at: WEEKS_AGO,
      });

      expect(await settleStaleBranches(db, NOW)).toBe(1);

      expect(
        (await openedPullRequests(db)).map((pr) => [pr.repo, pr.prNumber])
      ).toEqual([[TOOLKIT, 13]]);
    } finally {
      await db.close();
    }
  });
  it("names the repository from the first pull request recorded on the branch when two disagree", async () => {
    const db = await openStore();
    try {
      await insertSqliteSession(db, "s1", { cwd: ACME_CWD });
      await link(db, push("s1", "feat/y", WEEKS_AGO));
      for (const [repo, pr] of [
        [TOOLKIT, 3],
        [ACME_WEB, 9],
      ] as const) {
        await link(db, {
          session: "s1",
          kind: ArtifactRefTargetKind.PullRequest,
          branch: "feat/y",
          repo,
          pr,
          relation: ArtifactRefRelation.Referenced,
          method: "harness_pr_link",
          at: WEEKS_AGO,
        });
      }

      expect(await settleStaleBranches(db, NOW)).toBe(1);

      // pins current behavior; "first" is the raw query's row order, which
      // has no ORDER BY and follows insertion order in SQLite today.
      expect(
        (await openedPullRequests(db)).map((pr) => [pr.repo, pr.prNumber])
      ).toEqual([[TOOLKIT, 4]]);
    } finally {
      await db.close();
    }
  });
});
