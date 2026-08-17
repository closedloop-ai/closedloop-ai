import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ArtifactRefRelation } from "@repo/api/src/types/session-artifact-link";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

// ---------------------------------------------------------------------------
// FEA-2531 acceptance criteria — the two-level display/attribution predicate.
//
// Every seed below uses `relation: "workspace"` on EVERY link (the pre-reparse
// shape) unless a test overrides it, proving AC9: the read predicates are
// method-based and behave identically on pre- and post-reparse rows (no
// relation-based branch in any read). Method values drive the gate:
//   - write methods (git_push / gh_pr_create / git_commit) → raw Wrote rows;
//   - push methods (git_push / gh_pr_create) OR `first_pushed_at` → local
//     publication evidence, composed with Wrote by the Product read coordinator.
//
// Extracted from `branch-reads-contract.test.ts` (FEA-4280) so the focused
// `branch-reads-token-overflow-degrade.test.ts` sibling can reuse the exact
// same real-libSQL seed wiring without duplicating it — and so the contract
// file stays under the file-size ceiling. Pure fixtures/helpers; no test state.
// ---------------------------------------------------------------------------

export const AC_T0 = "2026-06-01T00:00:00.000Z";
export const AC_T1 = "2026-06-01T01:00:00.000Z";

export type AcDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

/** Per-db factory of terse, unique-id seed helpers for the FEA-2531 AC tests. */
export function seeder(db: AcDb) {
  let n = 0;
  const uid = (prefix: string) => `${prefix}-${++n}`;
  return {
    async session(id: string): Promise<void> {
      await db.run(
        "INSERT INTO sessions (id, status, started_at, ended_at, billing_mode) VALUES ($1, 'completed', $2, $3, 'metered_api')",
        id,
        AC_T0,
        AC_T1
      );
    },
    /** A `kind='branch'` artifact; `firstPushedAt` seeds the push marker arm. */
    async branch(opts: {
      branch: string;
      repo?: string | null;
      firstPushedAt?: string | null;
    }): Promise<string> {
      const id = uid("art");
      const pushedAt = opts.firstPushedAt ?? null;
      await db.run(
        `INSERT INTO artifacts
           (id, identity_key, kind, repo_full_name, branch_name,
            first_pushed_at, push_source, created_at, last_seen_at)
         VALUES ($1, $2, 'branch', $3, $4, $5, $6, $7, $7)`,
        id,
        `ik-${id}`,
        opts.repo ?? "acme/web",
        opts.branch,
        pushedAt,
        pushedAt ? "session" : null,
        AC_T0
      );
      return id;
    },
    /** One session→branch link; `relation` defaults to the pre-reparse value. */
    async link(opts: {
      session: string;
      artifactId: string;
      method: string;
      relation?: string;
      isPrimary?: number;
      observedAt?: string;
    }): Promise<void> {
      const id = uid("lnk");
      const observedAt = opts.observedAt ?? AC_T0;
      await db.run(
        `INSERT INTO session_artifact_links
           (id, session_id, artifact_id, relation, method, evidence,
            is_primary, extractor_version, observed_at, created_at)
         VALUES ($1, $2, $3, $4, $5, 'e', $6, 7, $7, $7)`,
        id,
        opts.session,
        opts.artifactId,
        opts.relation ?? "workspace",
        opts.method,
        opts.isPrimary ?? 0,
        observedAt
      );
    },
    async tokens(session: string, input: number): Promise<void> {
      await db.run(
        `INSERT INTO token_usage
           (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
         VALUES ($1, 'm1', $2, 0, 0, 0)`,
        session,
        input
      );
    },
    /** Set the push marker on an existing branch artifact (AC5 marker arm). */
    async markPushed(artifactId: string, at: string): Promise<void> {
      await db.run(
        "UPDATE artifacts SET first_pushed_at = $2, push_source = 'session' WHERE id = $1",
        artifactId,
        at
      );
    },
    async countLinks(session: string): Promise<number> {
      const rows = await db.prisma.client.$queryRawUnsafe<
        { c: number | bigint }[]
      >(
        "SELECT COUNT(*) AS c FROM session_artifact_links WHERE session_id = ?",
        session
      );
      return Number(rows[0]?.c ?? 0);
    },
  };
}

export async function withAcDb(
  run: (db: AcDb) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "branch-reads-ac-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    emit: () => undefined,
    now: () => "2026-06-22T00:00:00.000Z",
  });
  try {
    await run(db);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

export function branchNames(rows: { branchName: string }[]): string[] {
  return rows.map((r) => r.branchName).sort();
}

export async function insertPullRequestArtifact(
  db: AcDb,
  opts: { id: string; branch?: string | null; prNumber?: number }
): Promise<void> {
  await db.run(
    `INSERT INTO artifacts
       (id, identity_key, kind, repo_full_name, pr_number, branch_name,
        created_at, last_seen_at)
     VALUES ($1, $2, 'pull_request', 'acme/web', $3, $4, $5, $5)`,
    opts.id,
    `ik-${opts.id}`,
    opts.prNumber ?? 42,
    opts.branch ?? null,
    AC_T0
  );
}

export async function insertPullRequestRow(
  db: AcDb,
  opts: { id: string; branch: string; prNumber?: number }
): Promise<void> {
  await db.run(
    `INSERT INTO pull_requests
       (id, pr_url, pr_number, repo_full_name, branch_name, state,
        observed_at, created_at)
     VALUES ($1, $2, $3, 'acme/web', $4, 'open', $5, $5)`,
    opts.id,
    `https://github.com/acme/web/pull/${opts.prNumber ?? 42}`,
    opts.prNumber ?? 42,
    opts.branch,
    AC_T0
  );
}

export async function linkPullRequestArtifact(
  db: AcDb,
  opts: {
    id: string;
    session: string;
    artifactId: string;
    relation: ArtifactRefRelation;
    method: string;
    observedAt: string;
  }
): Promise<void> {
  await db.run(
    `INSERT INTO session_artifact_links
       (id, session_id, artifact_id, relation, method, evidence,
        is_primary, extractor_version, observed_at, created_at)
     VALUES ($1, $2, $3, $4, $5, 'e', 0, 7, $6, $6)`,
    opts.id,
    opts.session,
    opts.artifactId,
    opts.relation,
    opts.method,
    opts.observedAt
  );
}

export async function insertCommitArtifact(
  db: AcDb,
  opts: {
    id: string;
    session: string;
    branch: string;
    committedAt: string;
    linkId?: string;
    observedAt?: string;
    sha?: string;
  }
): Promise<void> {
  await db.run(
    `INSERT INTO artifacts
       (id, identity_key, kind, repo_full_name, sha, branch_name, committed_at,
        title, created_at, last_seen_at)
     VALUES ($1, $2, 'commit', 'acme/web', $3, $4, $5, 'post PR fix', $6, $6)`,
    opts.id,
    `ik-${opts.id}`,
    opts.sha ?? "abc1234",
    opts.branch,
    opts.committedAt,
    opts.observedAt ?? AC_T0
  );
  await db.run(
    `INSERT INTO session_artifact_links
       (id, session_id, artifact_id, relation, method, evidence,
        is_primary, extractor_version, observed_at, created_at)
     VALUES ($1, $2, $3, $4, 'git_command', 'e', 0, 7, $5, $5)`,
    opts.linkId ?? `lnk-${opts.id}`,
    opts.session,
    opts.id,
    ArtifactRefRelation.Created,
    opts.observedAt ?? AC_T0
  );
}
