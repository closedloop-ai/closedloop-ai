import {
  ArtifactRefRelation,
  ArtifactRefTargetKind,
} from "@repo/api/src/types/session-artifact-link";
import { z } from "zod";
import { openSnapshot } from "../../perf-import-desktop-snapshot-reads";
import {
  type CorpusShift,
  type CorpusShiftTally,
  shiftCorpusIso,
} from "../core/corpus-shift";

/**
 * ISS-12017: every branch, pull request, and commit link the golden sessions
 * carry in the Desktop store (`session_artifact_links` joined to `artifacts`),
 * with corpus time already shifted. Most golden branch artifacts were stored
 * without a remote, so a link's repository falls back to the pull request that
 * names the same branch, then to the session's working directory.
 */

/** A repository the vibe org holds authority for, and how a working directory names it. */
export type SeededRepository = {
  readonly fullName: string;
  readonly cwdPattern: RegExp;
};

export type StoreLink = {
  /** The store's link row id, the lifecycle events' evidence id. */
  readonly linkId: string;
  readonly sessionId: string;
  readonly relation: ArtifactRefRelation | null;
  readonly method: string;
  /** Shifted ISO instant. */
  readonly observedAt: string | undefined;
  readonly kind: LinkKind;
  readonly repositoryFullName: string;
  readonly branchName: string | null;
  readonly prNumber: number | null;
  readonly sha: string | null;
  readonly title: string | null;
  /** Shifted ISO instant. */
  readonly committedAt: string | undefined;
  readonly cwd: string | null;
};

const LINK_SELECT = `
  SELECT
    l.id AS "linkId",
    l.session_id AS "sessionId",
    l.relation AS "relation",
    l.method AS "method",
    COALESCE(l.observed_at, a.observed_at, a.created_at) AS "observedAt",
    a.kind AS "kind",
    a.repo_full_name AS "repoFullName",
    a.branch_name AS "branchName",
    a.pr_number AS "prNumber",
    a.sha AS "sha",
    a.title AS "title",
    a.committed_at AS "committedAt",
    s.cwd AS "cwd"
  FROM session_artifact_links l
  JOIN artifacts a ON a.id = l.artifact_id
  JOIN sessions s ON s.id = l.session_id
  WHERE a.kind IN ('branch', 'pull_request', 'commit')
  ORDER BY l.session_id ASC, l.observed_at ASC, l.id ASC
`;

const nullableText = z.string().trim().min(1).nullable().catch(null);

const linkRowSchema = z.object({
  linkId: z.string().min(1),
  sessionId: z.string().min(1),
  relation: nullableText,
  method: z.string().min(1),
  observedAt: nullableText,
  kind: z.enum([
    ArtifactRefTargetKind.Branch,
    ArtifactRefTargetKind.PullRequest,
    ArtifactRefTargetKind.Commit,
  ]),
  repoFullName: nullableText,
  branchName: nullableText,
  prNumber: z.number().int().positive().nullable().catch(null),
  sha: nullableText,
  title: nullableText,
  committedAt: nullableText,
  cwd: nullableText,
});

type LinkRow = z.infer<typeof linkRowSchema>;

const relationSchema = z
  .enum(Object.values(ArtifactRefRelation))
  .nullable()
  .catch(null);

type LinkKind = LinkRow["kind"];

/** Links whose repository resolves, in session then observation order. */
export function readStoreLinks(
  storePath: string,
  repositories: readonly SeededRepository[],
  shift: CorpusShift
): StoreLink[] {
  const db = openSnapshot(storePath);
  let rows: LinkRow[];
  try {
    rows = db
      .prepare(LINK_SELECT)
      .all()
      .flatMap((raw) => {
        const parsed = linkRowSchema.safeParse(raw);
        return parsed.success ? [parsed.data] : [];
      });
  } finally {
    db.close();
  }
  const repositoryByBranch = pullRequestRepositoryByBranch(rows);
  const tally: CorpusShiftTally = { clampedToNow: 0 };
  const shiftIso = (value: string | null) => shiftedIso(value, shift, tally);
  return rows.flatMap((row) => {
    const repositoryFullName =
      row.repoFullName ??
      (row.branchName === null
        ? null
        : repositoryByBranch.get(row.branchName)) ??
      repositoryFromCwd(row.cwd, repositories);
    if (repositoryFullName === null) {
      return [];
    }
    return [
      {
        ...row,
        relation: relationSchema.parse(row.relation),
        observedAt: shiftIso(row.observedAt),
        committedAt: shiftIso(row.committedAt),
        repositoryFullName,
        branchName: row.branchName,
      },
    ];
  });
}

/** Every branch a stored pull request names, mapped to that pull request's repository. */
function pullRequestRepositoryByBranch(
  rows: readonly LinkRow[]
): ReadonlyMap<string, string> {
  const byBranch = new Map<string, string>();
  for (const row of rows) {
    if (
      row.kind === ArtifactRefTargetKind.PullRequest &&
      row.branchName !== null &&
      row.repoFullName !== null &&
      !byBranch.has(row.branchName)
    ) {
      byBranch.set(row.branchName, row.repoFullName);
    }
  }
  return byBranch;
}

function repositoryFromCwd(
  cwd: string | null,
  repositories: readonly SeededRepository[]
): string | null {
  if (cwd === null) {
    return null;
  }
  return (
    repositories.find((repository) => repository.cwdPattern.test(cwd))
      ?.fullName ?? null
  );
}

function shiftedIso(
  value: string | null,
  shift: CorpusShift,
  tally: CorpusShiftTally
): string | undefined {
  const shifted = shiftCorpusIso(value, shift, tally);
  return typeof shifted === "string" ? shifted : undefined;
}
