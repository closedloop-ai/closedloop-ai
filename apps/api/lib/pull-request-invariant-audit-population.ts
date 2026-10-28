/**
 * ISS-4752 — the INVARIANT-AUDIT pull-request population.
 *
 * The third owner recognised by the `pull-request-population-declaration`
 * source gate, alongside the two sanctioned populations
 * (`pull-request-population.ts` for org-merged counts,
 * `branch-canonical-pull-request.ts` for one branch). Those two answer "which
 * PRs may a USER-FACING number speak about". This one answers the opposite
 * question: which PR rows are BROKEN.
 *
 * That is why it reads raw. A sanctioned predicate admits session-linked,
 * verified rows — precisely the rows an invariant audit has nothing to say
 * about — so composing one here would filter out every row the audit exists to
 * find, and the cron would report clean forever. The gate scopes this module's
 * declaration to `apps/api/app/cron/` so "reads raw on purpose" stays a
 * reviewed diagnostics lane rather than a bypass any consumer can import.
 *
 * NOTHING HERE MAY REACH A USER-FACING COUNT. These predicates deliberately
 * span every org and every provenance tier; rendering one as a product number
 * is the PRD-683 defect (two screens counting different universes) with extra
 * steps.
 */
import { ArtifactType } from "@repo/api/src/types/artifact";
import { GitHubPRState, type Prisma } from "@repo/database";

/**
 * A PR row whose branch pointer does not resolve to a BRANCH artifact —
 * ISS-4752's "no PR without an associated branch".
 *
 * `branchArtifactId` is NOT NULL with an `onDelete: Cascade` FK, so the
 * pointer can never dangle and the column alone cannot be the check. What the
 * FK does NOT constrain is the TYPE of the artifact it points at: `artifacts`
 * holds DOCUMENT / BRANCH / DEPLOYMENT / SESSION rows behind one id space, so
 * a mis-projected PR can be parented to a non-BRANCH artifact and still
 * satisfy every constraint in the schema.
 *
 * NOT `artifactId IS NULL`, which is what this audit first shipped as. That
 * column is vestigial — it was the table's primary key before
 * `20260515002500_add_branch_artifact_foundation`, and every current writer
 * (`buildPullRequestDetailCreate`, `upsertCurrentPullRequestDetail`) omits it,
 * so NULL is the normal state of a correctly-ingested PR. There is also no
 * `PULL_REQUEST` member of `ArtifactType` for such a row to point at, so the
 * "not yet materialised as its own artifact" reading describes a
 * materialisation that cannot happen. Keying the check there matched every
 * newly ingested PR and would have paged Slack on a healthy database.
 */
export function unbranchedPullRequestWhere(): Prisma.PullRequestDetailWhereInput {
  return {
    branchArtifact: { is: { type: { not: ArtifactType.Branch } } },
  };
}

/**
 * A PR row that reports added lines while reporting zero changed files —
 * ISS-4752's "no lines-added with zero files changed".
 *
 * `changedFiles = 0` only. A NULL `changedFiles` means UNKNOWN, not zero:
 * `pullRequestLocData` is omission-preserving, so a provider payload carrying
 * `additions` without `changedFiles` leaves the column unset rather than
 * defaulting it. Treating that as a contradiction would alert on valid
 * partially-enriched rows; those are already counted, as their own thing, by
 * {@link unenrichedPullRequestWhere}.
 */
export function linesFilesContradictionWhere(): Prisma.PullRequestDetailWhereInput {
  return {
    additions: { gt: 0 },
    changedFiles: 0,
  };
}

/**
 * A PR row no LOC enrichment has reached yet — a pipeline-normal transient
 * state, so this is a steady-state gauge and never a violation. All three
 * columns must be absent together: a row with some of them is partially
 * enriched, which is a different (and expected) shape.
 */
export function unenrichedPullRequestWhere(): Prisma.PullRequestDetailWhereInput {
  return {
    additions: null,
    deletions: null,
    changedFiles: null,
  };
}

/**
 * ISS-12272 — a PR row stored OPEN that no GitHub observation has reached.
 *
 * `pr_state` is NOT NULL with a default of OPEN, and the desktop lane inserts a
 * row with no GitHub facts. On such a row OPEN is the column default, not a
 * measurement: prod held 303 of them for PRs already merged or closed
 * (ISS-12164). The webhook, reconcile and backfill writers set
 * `github_updated_at`; the desktop lane does not. The reconcile sweep reads
 * this shape to repair it.
 */
export function unverifiedOpenPullRequestWhere(): Prisma.PullRequestDetailWhereInput {
  return {
    prState: GitHubPRState.OPEN,
    githubUpdatedAt: null,
  };
}
