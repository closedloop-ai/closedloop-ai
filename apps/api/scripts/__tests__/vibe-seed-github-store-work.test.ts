/**
 * ISS-12017: what the vibe seed's GitHub stages read out of a golden Desktop
 * store: the resolvable branch/PR/commit links, each pushed branch's work, and
 * the sync-wire refs the session-links stage re-delivers.
 */
import type { DatabaseSync } from "node:sqlite";
import {
  BranchLifecycleBoundaryKind,
  BranchParticipationKind,
} from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import {
  ArtifactRefRelation,
  ArtifactRefTargetKind,
} from "@repo/api/src/types/session-artifact-link";
import { SessionPrRelationType } from "@repo/api/src/types/session-pr-link-metadata";
import {
  VIBE_SEED_BRANCH_NAMES,
  vibeSeedPullRequestTopic,
} from "@repo/api/src/vibe-seed-corpus";
import { describe, expect, it } from "vitest";
import { pullRequestBody } from "../vibe-seed/github/pull-request-projection";
import { readStoreLinks } from "../vibe-seed/github/store-links";
import { buildGoldenSessionRefs } from "../vibe-seed/github/store-refs";
import { branchWorkKey, readBranchWork } from "../vibe-seed/github/store-work";
import { insertSession, withSnapshot } from "./perf-import-snapshot-fixture";

const REPOSITORY = "closedloop-ai/closedloop-ai";
const OTHER_REPOSITORY = "acme/other";
const CWD = "/Users/octocat/closedloop-ai";
const REPOSITORIES = [
  { fullName: REPOSITORY, cwdPattern: /(?:^|\/)closedloop-ai(?:\/|$)/ },
];
const BRANCH = "feat/iss-1-login";
const OTHER_BRANCH = "kaitoc/fix-thing";
const PR_NUMBER = 101;
const PROSE_PR_NUMBER = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const PUSHED_AT = "2026-08-01T10:30:00.000Z";

const STORE_DDL = [
  `CREATE TABLE artifacts (
     id TEXT PRIMARY KEY, kind TEXT NOT NULL, repo_full_name TEXT,
     branch_name TEXT, pr_number INTEGER, sha TEXT, title TEXT,
     committed_at TEXT, observed_at TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE session_artifact_links (
     id TEXT PRIMARY KEY, session_id TEXT NOT NULL, artifact_id TEXT NOT NULL,
     relation TEXT NOT NULL, method TEXT NOT NULL, observed_at TEXT NOT NULL)`,
];

type LinkSeed = {
  session: string;
  kind: string;
  relation: string;
  method: string;
  at: string;
  repo?: string;
  branch?: string;
  pr?: number;
};

function seedStore(db: DatabaseSync): void {
  seedStoreOn(db, BRANCH);
}

function seedStoreOn(db: DatabaseSync, pushedBranch: string): void {
  for (const statement of STORE_DDL) {
    db.exec(statement);
  }
  insertSession(db, { id: "s1" });
  insertSession(db, { id: "s2" });
  db.prepare("UPDATE sessions SET cwd = ? WHERE id = ?").run(CWD, "s1");
  db.prepare("UPDATE sessions SET cwd = ? WHERE id = ?").run("/srv/ci", "s2");
  const links: LinkSeed[] = [
    {
      session: "s1",
      kind: "branch",
      relation: "workspace",
      method: "start_branch",
      at: "2026-08-01T10:00:00.000Z",
      branch: pushedBranch,
    },
    {
      session: "s1",
      kind: "branch",
      relation: "created",
      method: "git_push",
      at: PUSHED_AT,
      branch: pushedBranch,
    },
    {
      session: "s1",
      kind: "pull_request",
      relation: "created",
      method: "pr_create_output",
      at: "2026-08-01T10:31:00.000Z",
      repo: REPOSITORY,
      branch: pushedBranch,
      pr: PR_NUMBER,
    },
    {
      session: "s1",
      kind: "pull_request",
      relation: "referenced",
      method: "pr_mention_in_prose",
      at: "2026-08-01T10:32:00.000Z",
      repo: REPOSITORY,
      pr: PROSE_PR_NUMBER,
    },
    {
      session: "s2",
      kind: "branch",
      relation: "created",
      method: "git_push",
      at: "2026-08-02T09:00:00.000Z",
      repo: OTHER_REPOSITORY,
      branch: OTHER_BRANCH,
    },
  ];
  for (const [index, link] of links.entries()) {
    db.prepare(
      `INSERT INTO artifacts (id, kind, repo_full_name, branch_name, pr_number, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      `a${index}`,
      link.kind,
      link.repo ?? null,
      link.branch ?? null,
      link.pr ?? null,
      link.at
    );
    db.prepare(
      `INSERT INTO session_artifact_links (id, session_id, artifact_id, relation, method, observed_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      `l${index}`,
      link.session,
      `a${index}`,
      link.relation,
      link.method,
      link.at
    );
  }
  const insertEvent = db.prepare(
    `INSERT INTO events (id, session_id, event_type, tool_name, data, created_at, git_branch)
     VALUES (?, 's1', 'tool_use', ?, ?, ?, ?)`
  );
  insertEvent.run(
    "e1",
    "Edit",
    JSON.stringify({
      tool_input: {
        file_path: `${CWD}/apps/api/login.ts`,
        old_string: "return null;",
        new_string: "const user = await load();\nreturn user;",
      },
    }),
    "2026-08-01T10:10:00.000Z",
    "HEAD"
  );
  insertEvent.run(
    "e2",
    "Bash",
    JSON.stringify({
      tool_input: {
        command:
          "git add -A && git commit -m \"$(cat <<'EOF'\nfeat(api): load the user on login\n\nReads the session first.\n\nCo-Authored-By: Someone <x@example.com>\nEOF\n)\"",
      },
    }),
    "2026-08-01T10:20:00.000Z",
    "HEAD"
  );
}

function readCorpus(path: string, nowIso: string) {
  const shift = { shiftMs: 0, nowMs: Date.parse(nowIso) };
  const links = readStoreLinks(path, REPOSITORIES, shift);
  return { links, work: readBranchWork(path, links, shift) };
}

describe("golden store GitHub corpus", () => {
  it("resolves a remote-less branch through the pull request that names it", () =>
    withSnapshot(seedStore, (path) => {
      const { links } = readCorpus(path, "2026-09-01T00:00:00.000Z");
      expect(
        links
          .filter((link) => link.sessionId === "s1")
          .map((link) => link.repositoryFullName)
      ).toStrictEqual([REPOSITORY, REPOSITORY, REPOSITORY, REPOSITORY]);
    }));

  it("recovers a pushed branch's commit, file change, pusher, and merged pull request", () =>
    withSnapshot(seedStore, (path) => {
      const { work } = readCorpus(path, "2026-09-01T00:00:00.000Z");
      const branch = work.get(branchWorkKey(REPOSITORY, BRANCH));
      expect(branch?.author.login).toBe("octocat");
      expect(branch?.commits.map((commit) => commit.message)).toStrictEqual([
        "feat(api): load the user on login\n\nReads the session first.",
      ]);
      expect(branch?.files).toMatchObject([
        { path: "apps/api/login.ts", additions: 2, deletions: 1 },
      ]);
      expect(branch?.pushes).toHaveLength(1);
      expect(branch?.pushes[0]?.afterSha).toBe(branch?.commits[0]?.sha);
      expect(branch?.pushes[0]?.at.toISOString()).toBe(PUSHED_AT);
      expect(branch?.pullRequests[0]).toMatchObject({
        number: PR_NUMBER,
        facts: {
          title: "feat(api): load the user on login",
          state: GitHubPRState.Merged,
          additions: 2,
          deletions: 1,
          changedFiles: 1,
        },
      });
    }));

  it("gives a push with no recorded commit one named after the branch, pushed by its prefix owner", () =>
    withSnapshot(seedStore, (path) => {
      const { work } = readCorpus(path, "2026-09-01T00:00:00.000Z");
      const branch = work.get(branchWorkKey(OTHER_REPOSITORY, OTHER_BRANCH));
      expect(branch?.author.login).toBe("kaitoc");
      expect(branch?.commits.map((commit) => commit.message)).toStrictEqual([
        "Fix thing",
      ]);
      expect(branch?.pullRequests).toStrictEqual([]);
      // ISS-12135: no recorded edit still leaves a change, not +0 -0.
      expect(branch?.files).toHaveLength(1);
      expect(branch?.files[0]?.additions).toBeGreaterThan(0);
      expect(branch?.commits[0]?.linesAdded).toBe(branch?.files[0]?.additions);
    }));

  it("keeps a pull request opened within the week open", () =>
    withSnapshot(seedStore, (path) => {
      const { work } = readCorpus(
        path,
        new Date(Date.parse(PUSHED_AT) + DAY_MS).toISOString()
      );
      const facts = work.get(branchWorkKey(REPOSITORY, BRANCH))?.pullRequests[0]
        ?.facts;
      expect(facts?.state).toBe(GitHubPRState.Open);
      expect(facts?.mergedAt).toBeUndefined();
    }));

  it("builds wire refs, attaching facts to the PR that names a branch and keeping prose mentions out of prRefs", () =>
    withSnapshot(seedStore, (path) => {
      const corpus = readCorpus(path, "2026-09-01T00:00:00.000Z");
      const refs = buildGoldenSessionRefs(corpus.links, (repository, number) =>
        repository === REPOSITORY && number === PR_NUMBER
          ? {
              title: "derived title",
              state: GitHubPRState.Open,
              isDraft: false,
              baseRef: "main",
            }
          : undefined
      ).get("s1");
      const prRaised = {
        kind: BranchLifecycleBoundaryKind.PrRaised,
        evidenceId: "desktop-artifact-link:l2",
        observedAt: "2026-08-01T10:31:00.000Z",
      };
      expect(refs?.artifactRefs).toMatchObject([
        {
          kind: ArtifactRefTargetKind.Branch,
          relation: ArtifactRefRelation.Workspace,
          branchLifecycleEvents: [
            { kind: BranchLifecycleBoundaryKind.ReadOnlyReference },
          ],
        },
        {
          kind: ArtifactRefTargetKind.Branch,
          relation: ArtifactRefRelation.Created,
          branchParticipation: BranchParticipationKind.Wrote,
          branchLifecycleEvents: [
            {
              kind: BranchLifecycleBoundaryKind.BranchWrite,
              evidenceId: "desktop-artifact-link:l1",
              observedAt: PUSHED_AT,
            },
          ],
        },
        {
          kind: ArtifactRefTargetKind.PullRequest,
          prNumber: PR_NUMBER,
          branchName: BRANCH,
          title: "derived title",
          branchLifecycleEvents: [prRaised],
        },
        { kind: ArtifactRefTargetKind.PullRequest, prNumber: PROSE_PR_NUMBER },
      ]);
      expect(refs?.artifactRefs[3]).not.toHaveProperty("title");
      expect(refs?.artifactRefs[3]).not.toHaveProperty("branchLifecycleEvents");
      expect(refs?.prRefs).toStrictEqual([
        {
          repositoryFullName: REPOSITORY,
          prNumber: PR_NUMBER,
          relationType: SessionPrRelationType.Created,
          branchLifecycleEvents: [prRaised],
        },
      ]);
    }));
});

describe("golden store pull request topics", () => {
  it("titles a corpus branch's pull request with the topic its session worked on", async () => {
    const topicBranch =
      VIBE_SEED_BRANCH_NAMES.get("corpus/feat/local-verify-command") ?? "";
    const topic = vibeSeedPullRequestTopic(topicBranch);
    expect(topic).toBeDefined();
    await withSnapshot(
      (db) => seedStoreOn(db, topicBranch),
      (path) => {
        const { work } = readCorpus(path, "2026-09-01T00:00:00.000Z");
        const branch = work.get(branchWorkKey(REPOSITORY, topicBranch));
        expect(branch?.commits[0]?.message).toContain(
          "feat(api): load the user on login"
        );
        expect(branch?.pullRequests[0]?.facts.title).toBe(topic?.title);
        expect(branch === undefined ? null : pullRequestBody(branch)).toBe(
          topic?.body
        );
      }
    );
  });

  it("keeps the first commit's subject and body for a branch with no topic", () =>
    withSnapshot(seedStore, (path) => {
      const { work } = readCorpus(path, "2026-09-01T00:00:00.000Z");
      const branch = work.get(branchWorkKey(REPOSITORY, BRANCH));
      expect(vibeSeedPullRequestTopic(BRANCH)).toBeUndefined();
      expect(branch?.pullRequests[0]?.facts.title).toBe(
        "feat(api): load the user on login"
      );
      expect(branch === undefined ? null : pullRequestBody(branch)).toBe(
        "Reads the session first."
      );
    }));
});
