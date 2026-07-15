import { CommitProvenanceSource } from "@repo/api/src/types/commit";
import type { TransactionClient } from "@repo/database";
import { describe, expect, it, vi } from "vitest";
import { reconcileCommitOnTx } from "./commit-service";

// A commit whose 7-char abbreviation (what the desktop parses) is a prefix of
// its full 40-char sha (what the push webhook sends).
const ABBREV = "1a2b3c4";
const FULL = `${ABBREV}${"d".repeat(33)}`; // 40 lowercase hex chars

const ORG = "org-1";
const REPO = "acme/app";

type FakeRow = {
  id: string;
  organizationId: string;
  repositoryFullName: string;
  sha: string;
  branchArtifactId: string;
  source: string;
  message: string | null;
  committedAt: Date | null;
  authoredAt: Date | null;
  authorName: string | null;
  authorEmail: string | null;
  authorLogin: string | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  filesChanged: number | null;
  isMerge: boolean;
  mergeCommitSha: string | null;
};

/**
 * Minimal in-memory stand-in for the CommitDetail table exercising exactly the
 * three operations reconcileCommitOnTx uses: an (org, repo, sha-prefix)
 * findMany, a create, and an update-by-id. findMany mirrors Postgres
 * `sha: { startsWith }` semantics so the git-style prefix match is tested
 * faithfully without a live database.
 */
function makeFakeTx() {
  const rows: FakeRow[] = [];
  let seq = 0;
  const commitDetail = {
    findMany: vi.fn(
      (args: {
        where: {
          organizationId: string;
          repositoryFullName: string;
          sha?: { startsWith?: string };
        };
      }) => {
        const { where } = args;
        const prefix = where.sha?.startsWith;
        return Promise.resolve(
          rows.filter(
            (r) =>
              r.organizationId === where.organizationId &&
              r.repositoryFullName === where.repositoryFullName &&
              (prefix === undefined || r.sha.startsWith(prefix))
          )
        );
      }
    ),
    create: vi.fn((args: { data: Omit<FakeRow, "id"> }) => {
      const row: FakeRow = { ...args.data, id: `commit-${++seq}` };
      rows.push(row);
      return Promise.resolve(row);
    }),
    update: vi.fn((args: { where: { id: string }; data: Partial<FakeRow> }) => {
      const row = rows.find((r) => r.id === args.where.id);
      if (!row) {
        return Promise.reject(new Error(`no row ${args.where.id}`));
      }
      Object.assign(row, args.data);
      return Promise.resolve(row);
    }),
  };
  return { rows, tx: { commitDetail } as unknown as TransactionClient };
}

function desktopInput(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: ORG,
    repositoryFullName: REPO,
    sha: ABBREV,
    branchArtifactId: "branch-1",
    source: CommitProvenanceSource.DesktopSync,
    ...overrides,
  };
}

function webhookInput(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: ORG,
    repositoryFullName: REPO,
    sha: FULL,
    branchArtifactId: "branch-1",
    source: CommitProvenanceSource.PushWebhook,
    ...overrides,
  };
}

describe("reconcileCommitOnTx", () => {
  it("inserts a new desktop commit keyed on the abbreviated sha", async () => {
    const { rows, tx } = makeFakeTx();
    await reconcileCommitOnTx(
      tx,
      desktopInput({ message: "wip", linesAdded: 5, linesRemoved: 1 })
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sha: ABBREV,
      source: CommitProvenanceSource.DesktopSync,
      message: "wip",
      linesAdded: 5,
      linesRemoved: 1,
      isMerge: false,
    });
  });

  it("normalizes the repo full name and lowercases the sha on insert", async () => {
    const { rows, tx } = makeFakeTx();
    await reconcileCommitOnTx(
      tx,
      desktopInput({ repositoryFullName: "Acme/App.git", sha: "AB12CD3" })
    );
    expect(rows[0].repositoryFullName).toBe("acme/app");
    expect(rows[0].sha).toBe("ab12cd3");
  });

  it("desktop-first then webhook converges to one row, expands to the full sha, and GitHub fields win", async () => {
    const { rows, tx } = makeFakeTx();
    await reconcileCommitOnTx(
      tx,
      desktopInput({
        message: "wip",
        committedAt: new Date("2020-01-01"),
        linesAdded: 5,
      })
    );
    await reconcileCommitOnTx(
      tx,
      webhookInput({
        message: "feat: real subject",
        committedAt: new Date("2026-07-13"),
        authorName: "Grace Hopper",
        authorEmail: "grace@example.com",
        authorLogin: "ghopper",
        filesChanged: 3,
      })
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sha: FULL, // expanded
      source: CommitProvenanceSource.PushWebhook,
      message: "feat: real subject", // GitHub authoritative
      authorName: "Grace Hopper",
      authorLogin: "ghopper",
      filesChanged: 3,
      linesAdded: 5, // desktop value preserved (webhook did not supply it)
    });
    expect(rows[0].committedAt).toEqual(new Date("2026-07-13"));
  });

  it("webhook-first then desktop keeps the full sha and lets desktop fill only null LOC", async () => {
    const { rows, tx } = makeFakeTx();
    await reconcileCommitOnTx(
      tx,
      webhookInput({
        message: "feat: real subject",
        authorName: "Grace Hopper",
        committedAt: new Date("2026-07-13"),
        filesChanged: 3,
      })
    );
    await reconcileCommitOnTx(
      tx,
      desktopInput({
        message: "wip",
        committedAt: new Date("2020-01-01"),
        linesAdded: 5,
        linesRemoved: 2,
        filesChanged: 99,
      })
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sha: FULL, // unchanged (desktop abbrev is shorter)
      source: CommitProvenanceSource.PushWebhook, // authority retained
      message: "feat: real subject", // desktop does not overwrite GitHub message
      authorName: "Grace Hopper",
      filesChanged: 3, // desktop does NOT overwrite a GitHub-set value
      linesAdded: 5, // filled (was null)
      linesRemoved: 2, // filled (was null)
    });
    // committedAt is GitHub-owned: the older desktop timestamp does not clobber it.
    expect(rows[0].committedAt).toEqual(new Date("2026-07-13"));
  });

  it("is idempotent across duplicate desktop syncs", async () => {
    const { rows, tx } = makeFakeTx();
    await reconcileCommitOnTx(tx, desktopInput({ linesAdded: 5 }));
    await reconcileCommitOnTx(tx, desktopInput({ linesAdded: 5 }));
    expect(rows).toHaveLength(1);
    expect(rows[0].linesAdded).toBe(5);
  });

  it("keeps commits with the same (repo, sha) in different orgs as separate rows", async () => {
    const { rows, tx } = makeFakeTx();
    await reconcileCommitOnTx(tx, desktopInput({ organizationId: "org-1" }));
    await reconcileCommitOnTx(tx, desktopInput({ organizationId: "org-2" }));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.organizationId))).toEqual(
      new Set(["org-1", "org-2"])
    );
  });

  it("keeps the same sha in different repos as separate rows", async () => {
    const { rows, tx } = makeFakeTx();
    await reconcileCommitOnTx(
      tx,
      desktopInput({ repositoryFullName: "acme/app" })
    );
    await reconcileCommitOnTx(
      tx,
      desktopInput({ repositoryFullName: "acme/web" })
    );
    expect(rows).toHaveLength(2);
  });

  it("does not merge two distinct commits that share only a 7-char prefix", async () => {
    const { rows, tx } = makeFakeTx();
    const fullA = `${ABBREV}${"a".repeat(33)}`;
    const fullB = `${ABBREV}${"b".repeat(33)}`;
    await reconcileCommitOnTx(tx, webhookInput({ sha: fullA }));
    await reconcileCommitOnTx(tx, webhookInput({ sha: fullB }));
    expect(rows).toHaveLength(2);
  });
});
