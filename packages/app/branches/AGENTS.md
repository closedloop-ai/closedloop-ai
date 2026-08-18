# @repo/app/branches — Branch list, detail, timeline

Renders the Branches list, summary, detail, and timeline for **both** shells (`apps/app` web, `apps/desktop` renderer).

Cross-feature rules — loading vs. unavailable vs. real-zero semantics, derived-arithmetic reconciliation, cross-surface parity, co-located story placement, entity-scoped local state, import/dependency/E2E rules — live in `packages/app/AGENTS.md` and apply here. This node covers only what is branch-specific.

## A branch is not a single PR

Branch-level math must not assume one pull request. A branch can carry several PRs across its life, so a count, duration, or status derived from "the PR" silently misstates a multi-PR branch. Derive from the full set, or state the single-PR assumption in the projection and cover a multi-PR branch in tests.

`PullRequestDetail` is nested state on `BranchDetail`, not a peer entity — read it through the branch projection rather than re-fetching it alongside.

## Timeline and status must agree with their evidence

- The timeline's session count must reconcile with the sessions the branch actually lists; a summary that disagrees with its own population is the defect, not a rounding artifact.
- A branch or PR status must not contradict the evidence rendered beside it (merged with an open check, closed with a live deployment). When the two can disagree, resolve the status from one helper and render the conflict rather than picking a side silently.

## Comment threading

When grouping Branch View comments or replies, key on stable unified `threadId`/`commentId` values or thread-local provider identity. Do not require the optional provider `source` to match between a parent and its reply — older or partial contracts omit it, and requiring it silently drops replies.
