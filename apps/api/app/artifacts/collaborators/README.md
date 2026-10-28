# Collaborator evidence boundaries

The authenticated batch route and shared wire contract are owned by ISS-10992.
The resolver is read-only: provider producers establish external identities;
reads reconcile immutable provider IDs against current verified account links
without creating users or rewriting historical receipts.

## Public read bounds

Requests accept at most 100 IDs of one artifact type. The public service admits
at most 50,000 candidate rows within one repeatable-read snapshot and rejects
serialized responses larger than 3 MiB with `collaborator_batch_too_large` (413).
Oversized requests return no partial results. The shared HTTP adapter retries
smaller ID groups and validates each subgroup's returned identities before
combining them. A single oversized artifact remains an explicit read failure.

Current verified links reconcile both numeric GitHub IDs and the stored
`node:<node_id>` alias. Ambiguous aliases do not select an arbitrary account;
historical external-author records are preserved. No login or display-name
comparison establishes identity.

Historical push scans interleave never-attempted Branches and due retries. One
operation owns its physical REST/GraphQL fetch ceiling and cancellation deadline;
phase allowances preserve room for exact-transition verification after discovery.
Every partial scan remains incomplete, including successful scans with no receipts.

## Canonical PR-comment acquisition proof

The canonical reconcile (`comments/service/github/github-comment-reconcile.ts`)
records one `pull_request_comment_acquisitions` row per PR and lane (issue
comments, review comments, reviews) in the transaction that releases its lease.
Each row holds the latest attempt's outcome: `COMPLETE`, `CEILING`, `SHIFTED` or
`FAILED`. The latest attempt wins and there is no clock expiry, so a later
non-complete attempt makes the lane incomplete until the next complete one.
`REQUIRED_PULL_REQUEST_COMMENT_LANES` (`github-comment-acquisition-proof.ts`) is
the lane set a PR must hold `COMPLETE`.

- `branches/branch-read-service/pull-request-comment-proof-sql.ts`:
  `pullRequestCommentProofIncompleteSql` is the only definition of PR-comment
  proof incomplete. It is true when the Branch has an associated PR, in the same
  organization, with fewer `COMPLETE` required-lane rows in that organization
  than required lanes. A lane never fetched has no row and counts as incomplete.
  A Branch with no PRs is complete. A proof row for another organization's PR or
  for a PR on another Branch never counts.
- `branches/branch-read-service/page-comment-evidence.ts`: the batch, detail and
  list-identity JS reads set `BranchCommentEvidence.pullRequestAvailability` from
  `readPullRequestCommentProof`, one statement over the shared predicate for the
  page's Branches with PRs, on the caller's client.
- `branches/branch-list-sql/branch-list-identity-sql.ts`:
  `pullRequestCommentIncompleteSql` binds the same predicate to the list
  LATERAL's Branch, and `collaboratorIncompleteSql` reports PR comments over the
  per-Branch evidence cap as incomplete, matching the JS `githubCapped`.
- `branches/branch-read-service/collaborator-projection.ts`: combines the reader's
  proof with caps and unresolved identities. Complete proof cannot make a
  truncated or unknown-author source complete, and known people are listed in
  every incomplete case. The shared identity union stays independent of how
  comments were acquired.
- `branches/branch-read-service/comment-evidence-windows.ts`: saturated stored
  comment lanes retain the same per-Branch population as detail and list SQL.

The proof covers only the PRs the reconcile visits. A Branch whose PRs lack
complete proof on every required lane stays incomplete; reads never fetch
comments to complete it.

Review-summary comments enter through the same stored GitHub comment projection
and external-author mapping as other PR comments. The readers do not filter by
GitHub thread kind, so a stored summary's author joins the PR-comment source.
Bodyless approvals do not become comment rows, and the reviews lane is still
complete without them. Do not add a second comment writer, infer acquisition
completeness from row presence, or use per-thread outbound CommentSyncState as
per-PR proof.

`packages/api/src/types/artifact-collaborators.ts` and the shared web/Desktop
HTTP adapters keep their contract. New proof belongs behind these API-owned
evidence boundaries; it does not require new client DTOs, flags or host controls.
Desktop Local remains unavailable for cloud evidence. Independent historical
pusher coverage is never promoted by successful comment acquisition.

## Regression anchors

The Branch contributor parity PostgreSQL suite covers late verified account
links and saturated platform, linked-Session and GitHub comment lanes. The
existing identity SQL suite pins actor/org isolation and comment behavior. The
PR-comment proof suite compares batch, detail and list SQL on the same fixtures
for missing, failed, ceiling and shifted lanes, multiple PRs, the evidence cap,
unresolved authors, review summaries, retraction, cross-Branch and cross-org
proof rows, and push coverage. The acquisition proof suite pins the writer's
per-lane outcomes, retry streaks, stale leases and the seed migration.

## Direct artifact participation

Every artifact type now shares creator, direct activity actor, retained document
version author, and direct native/Liveblocks comment author evidence. Assignment
alone does not qualify someone. Agent activity stores the platform user owning
the API key; it does not identify an independent human account for that agent.
User profiles must belong to the same organization. Unresolved actors leave the
source incomplete, while known people remain visible. Interaction coverage needs a
creation-time proof: a Document's creation receipt, or a Session's
`metadata_activity_coverage_started_at`. Without it, historical interaction
coverage stays incomplete and no backfill is implied. No Branch or Deployment
create path writes such a proof, so those types are not gated on one.

The optional `commentCount` is the number of native and Liveblocks threads owned
by this artifact ID that still hold a non-deleted comment. Replies do not
increment it (operator ruling, ISS-9404 review on #8671), and resolved threads
count. Only `.md`-bodied artifacts have Liveblocks threads. Linked artifact comments and GitHub projections do not
enter this direct count. Sessions use this same count loader; Branch-specific
push, PR, and linked-Session collaboration remains additional evidence.
