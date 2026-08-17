import {
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "branch-trace-unavailable",
  title: "Branch trace — unavailable & incomplete states",
  summary:
    "ISS-5555 bug fix, built on the Branch Details page of the branches prototype (imported, not copied — same precedent as web-master). When the combined-trace read fails, the Sessions & timeline tab today paints an empty timeline and empty trace under a 'PR timeline · N sessions' header with no error, because nothing renders the degraded envelope's completeness.state / reason. The scenario switcher forces the trace read into each outcome on the same branch: Loaded (the flow owner's happy path), Bug (today's lying render), Unavailable (full failure — honest '0 of N sessions rendered' label plus a reason-mapped disclosure with retry only when retry can help), and Incomplete (partial failure — 'M of N sessions rendered', a warning naming the session whose events couldn't load, and the timeline/trace reconciled to the sessions that did). Adds only the failure states; the branches prototype remains the owner of the happy-path flow.",
  author: "Kaiti Carpenter",
  status: PrototypeStatus.ReadyForReview,
  // Presumes no API change. `TraceUnavailableReason` in mock.ts mirrors the wire
  // enum `BranchTraceUnavailableReason` and the completeness envelope in
  // `@repo/api/src/types/branch-trace`; the degraded envelope already exists on
  // `BranchTraceResult.completeness` (see branches-data-source
  // `degradedTraceResult`), and the honest count label is the derivation
  // production already ships (`sessionLabel` in branch-sessions-timeline-tab).
  // The only production change this proposes is teaching the render side to
  // read `completeness.state` / `completeness.reason`, which no renderer does
  // today.
  tags: [PrototypeTag.BugFix],
  createdAt: "2026-08-10",
  linearIssue: null,
  closedloopDoc: null,
} satisfies PrototypeMeta;
