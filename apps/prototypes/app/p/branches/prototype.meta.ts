import {
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "branches",
  title: "Branches",
  summary:
    "A branch portfolio and detail view showing ownership, pull-request status, cost, lead time, changed files, and a combined session trace, with tabs that scope both the main content and comments rail.",
  author: "Parker",
  status: PrototypeStatus.HandedOff,
  // Production handoff requires additive producer/API evidence that the
  // current Branch row/detail contract does not expose: authoritative
  // BranchArtifact projectId + repositoryId, Repository.defaultBranch, and
  // qualifying SessionDetail sessionId + branchId + projectId + repositoryId
  // links. Eligibility must join those fields and compare the selected Branch
  // with the canonical repository default. It must not infer eligibility from
  // an `agent/` name. This prototype does not add that API/provider scope.
  tags: [PrototypeTag.Feature, PrototypeTag.BugFix],
  createdAt: "2026-07-23",
  linearIssue: null,
  closedloopDoc: "ISS-5559",
} satisfies PrototypeMeta;
