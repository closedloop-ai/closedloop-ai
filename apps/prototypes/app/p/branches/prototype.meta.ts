import {
  PrototypeDeliveryMode,
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "branches",
  title: "Branches",
  summary:
    "A branch portfolio and detail view showing ownership, pull-request status, cost, lead time, changed files, and a combined session trace, with tabs that scope both the main content and comments rail. The list now consumes the production Branches v2 surface through its mock-only preview adapter; the static column model remains the approved parity oracle read by the branches-prototype-column-parity source gate. The prototype retains fixture data, portfolio metric evidence, and the branch-specific detail and session-trace presentation.",
  author: "Pascoe",
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
  closedloopDoc: "ISS-8358",
  // Still the retired mode, as RETIRED_MODE_MIGRATION_LEDGER records: the
  // list consumes the production surface (ISS-12674), but the route still
  // renders its own app shell (`components/app-shell.tsx`), so it is not
  // production-bound until ISS-10268 migrates that shell.
  deliveryMode: PrototypeDeliveryMode.DisposableSketch,
} satisfies PrototypeMeta;
