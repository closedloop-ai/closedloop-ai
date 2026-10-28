import { CommitProvenanceSource } from "@repo/api/src/types/commit";
import type { TransactionClient } from "@repo/database";
import { describe, expect, it, vi } from "vitest";
import {
  COMMIT_CREATE_CHUNK,
  COMMIT_PREFIX_QUERY_CHUNK,
  reconcileCommitOnTx,
  reconcileCommitsOnTx,
} from "./commit-service";

// This suite isolates merge semantics; commit-batch-updates.integration.test.ts
// exercises the real SQL and its statement budget.
vi.mock("./commit-batch-updates", () => ({
  updateCommitBatch: async (
    tx: TransactionClient,
    updates: { id: string; data: Partial<FakeRow> }[]
  ) => {
    for (const update of updates) {
      await tx.commitDetail.update({
        where: { id: update.id },
        data: update.data,
        select: { id: true },
      });
    }
  },
}));

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
 * operations the reconcile path uses: an (org, repo, sha-prefix) findMany, a
 * batched createMany, and an update-by-id. findMany mirrors Postgres
 * `sha: { startsWith }` semantics — including the `OR` form ISS-8145 issues when
 * one call carries several distinct prefixes — so the git-style prefix match is
 * tested faithfully without a live database.
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
          OR?: { sha: { startsWith: string } }[];
        };
      }) => {
        const { where } = args;
        const prefixes =
          where.OR?.map((clause) => clause.sha.startsWith) ??
          (where.sha?.startsWith === undefined
            ? undefined
            : [where.sha.startsWith]);
        return Promise.resolve(
          rows.filter(
            (r) =>
              r.organizationId === where.organizationId &&
              r.repositoryFullName === where.repositoryFullName &&
              (prefixes === undefined ||
                prefixes.some((prefix) => r.sha.startsWith(prefix)))
          )
        );
      }
    ),
    create: vi.fn((args: { data: Omit<FakeRow, "id"> }) => {
      const row: FakeRow = { ...args.data, id: `commit-${++seq}` };
      rows.push(row);
      return Promise.resolve(row);
    }),
    createMany: vi.fn(
      (args: { data: Omit<FakeRow, "id">[]; skipDuplicates?: boolean }) => {
        for (const data of args.data) {
          const duplicate = rows.some(
            (r) =>
              r.organizationId === data.organizationId &&
              r.repositoryFullName === data.repositoryFullName &&
              r.sha === data.sha
          );
          if (duplicate) {
            if (args.skipDuplicates) {
              continue;
            }
            // Mirrors the Postgres unique violation on (org, repo, sha). This is
            // the error `recordWebhookCommits` catches to retry and merge, so a
            // fake that quietly absorbed it would hide exactly that regression.
            return Promise.reject(
              Object.assign(new Error("Unique constraint failed"), {
                code: "P2002",
              })
            );
          }
          rows.push({ ...data, id: `commit-${++seq}` });
        }
        return Promise.resolve({ count: args.data.length });
      }
    ),
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

describe("reconcileCommitsOnTx (ISS-8145)", () => {
  it("reads every ref's identity in ONE statement and inserts them in one more", async () => {
    const { rows, tx } = makeFakeTx();

    await reconcileCommitsOnTx(
      tx,
      Array.from({ length: 25 }, (_, index) =>
        desktopInput({ sha: index.toString(16).padStart(7, "0") })
      )
    );

    // The contract is the ROUND-TRIP COUNT, which is what the 30s per-session
    // transaction actually spends. The serial loop issued 2N (a read and a
    // write per commit); this is 2 regardless of N.
    expect(tx.commitDetail.findMany).toHaveBeenCalledTimes(1);
    expect(tx.commitDetail.createMany).toHaveBeenCalledTimes(1);
    expect(tx.commitDetail.create).not.toHaveBeenCalled();
    expect(tx.commitDetail.update).not.toHaveBeenCalled();
    expect(rows).toHaveLength(25);
  });

  it("writes nothing at all when the same refs are re-synced", async () => {
    const { rows, tx } = makeFakeTx();
    const refs = Array.from({ length: 10 }, (_, index) =>
      desktopInput({ sha: index.toString(16).padStart(7, "0") })
    );
    await reconcileCommitsOnTx(tx, refs);
    vi.clearAllMocks();

    await reconcileCommitsOnTx(tx, refs);

    // The desktop re-sends its full ref set on every tick, so this is the
    // steady state: one identity read and no writes. Before ISS-8145 it was a
    // read AND an update per commit, all of them storing values already held.
    expect(tx.commitDetail.findMany).toHaveBeenCalledTimes(1);
    expect(tx.commitDetail.update).not.toHaveBeenCalled();
    expect(tx.commitDetail.createMany).not.toHaveBeenCalled();
    expect(rows).toHaveLength(10);
  });

  it("folds two spellings of one commit in the same call into one row", async () => {
    const { rows, tx } = makeFakeTx();

    // The serial loop got this right by accident: the second reconcile read
    // back the first's insert. A batch that read once must fold explicitly or
    // it inserts two prefix-compatible rows that never self-heal.
    await reconcileCommitsOnTx(tx, [
      desktopInput({ sha: ABBREV, linesAdded: 5 }),
      webhookInput({ sha: FULL, authorLogin: "octocat" }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].sha).toBe(FULL);
    expect(rows[0].authorLogin).toBe("octocat");
    expect(rows[0].linesAdded).toBe(5);
    expect(rows[0].source).toBe(CommitProvenanceSource.PushWebhook);
  });

  it("still expands an abbreviated row when the webhook's full sha arrives later", async () => {
    const { rows, tx } = makeFakeTx();
    await reconcileCommitsOnTx(tx, [desktopInput({ linesAdded: 5 })]);

    await reconcileCommitsOnTx(tx, [webhookInput({ authorLogin: "octocat" })]);

    expect(rows).toHaveLength(1);
    expect(rows[0].sha).toBe(FULL);
    expect(rows[0].linesAdded).toBe(5);
    expect(tx.commitDetail.update).toHaveBeenCalledTimes(1);
  });
});

describe("reconcileCommitsOnTx — conflict and bound (review findings)", () => {
  it("lets a racing insert raise P2002 instead of skipping it silently", async () => {
    const { rows, tx } = makeFakeTx();
    await reconcileCommitsOnTx(tx, [desktopInput()]);
    // A racing producer inserted the row after this call's identity read, which
    // the stale snapshot models. `skipDuplicates` would swallow the conflict,
    // so `recordWebhookCommits` would never retry and the authoritative merge
    // would be lost — while still counting the commit as written.
    (
      tx.commitDetail.findMany as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce([]);

    await expect(
      reconcileCommitsOnTx(tx, [desktopInput()])
    ).rejects.toMatchObject({ code: "P2002" });
    expect(rows).toHaveLength(1);
  });

  it("does not collapse two longer shas onto one stored abbrev row in ONE call", async () => {
    const { rows, tx } = makeFakeTx();
    await reconcileCommitsOnTx(tx, [desktopInput({ sha: ABBREV })]);
    // Both extend the SAME stored 7-char row but are not prefix-compatible with
    // each other, so they are two distinct commits — the shape git produces when
    // a 7-char abbreviation collides. One batched read resolves both onto that
    // one row, so without claiming it the second update overwrote the first.
    const longA = `${ABBREV}${"a".repeat(33)}`;
    const longB = `${ABBREV}${"b".repeat(33)}`;

    await reconcileCommitsOnTx(tx, [
      webhookInput({ sha: longA }),
      webhookInput({ sha: longB }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.sha).sort()).toEqual([longA, longB].sort());
  });

  it("bounds the identity predicate at COMMIT_PREFIX_QUERY_CHUNK prefixes per read", async () => {
    const { tx } = makeFakeTx();
    // Deliberately ABOVE the chunk: at 25 refs the chunked and unchunked forms
    // both issue one read, so the bound could be raised or deleted unnoticed.
    const total = COMMIT_PREFIX_QUERY_CHUNK + 5;

    await reconcileCommitsOnTx(
      tx,
      Array.from({ length: total }, (_, index) =>
        desktopInput({ sha: index.toString(16).padStart(7, "0") })
      )
    );

    const calls = (tx.commitDetail.findMany as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(calls).toHaveLength(Math.ceil(total / COMMIT_PREFIX_QUERY_CHUNK));
    for (const call of calls) {
      const where = call[0].where as {
        OR?: unknown[];
        sha?: { startsWith: string };
      };
      expect(where.OR ? where.OR.length : 1).toBeLessThanOrEqual(
        COMMIT_PREFIX_QUERY_CHUNK
      );
    }
  });

  it("splits the identity insert at COMMIT_CREATE_CHUNK rows per statement", async () => {
    // ISS-8145 (whitlockk review): `createMany` binds every column of every row, so
    // one statement over the whole ref set crosses Prisma's built-statement bind
    // budget and is REFUSED — taking the enclosing session transaction with it.
    // Deliberately ABOVE the chunk: at any smaller width the chunked and
    // unchunked forms both issue exactly one statement, so the bound could be
    // raised or deleted unnoticed.
    const { tx, rows } = makeFakeTx();
    const total = COMMIT_CREATE_CHUNK + 1;

    await reconcileCommitsOnTx(
      tx,
      Array.from({ length: total }, (_, index) =>
        desktopInput({ sha: index.toString(16).padStart(7, "0") })
      )
    );

    const calls = (tx.commitDetail.createMany as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(calls).toHaveLength(Math.ceil(total / COMMIT_CREATE_CHUNK));
    for (const call of calls) {
      expect(call[0].data.length).toBeLessThanOrEqual(COMMIT_CREATE_CHUNK);
    }
    // The bound is on the STATEMENT, never the payload: every row still lands.
    expect(rows).toHaveLength(total);
  });
});
