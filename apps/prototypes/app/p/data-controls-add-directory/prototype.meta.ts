import {
  PrototypeDeliveryMode,
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "data-controls-add-directory",
  title: "Data controls: add a directory",
  summary:
    "ISS-12521: an add control on the shared directory scope list that takes a folder from the native picker (simulated here by the path switcher) and resolves it to added, duplicate, unreadable or protected. Its own copy is approved; the shared list's copy (ISS-12520) still shows a glyph pending that ticket's wording.",
  author: "Cosimo Corrigan",
  status: PrototypeStatus.ReadyForReview,
  tags: [PrototypeTag.Feature],
  createdAt: "2026-10-16",
  linearIssue: null,
  closedloopDoc: "ISS-12521",
  // PRODUCER RECORD (`apps/prototypes/AGENTS.md`). `entries`, `includedIds`
  // and `autoExcluded` are ISS-12520's `DirectoryScopeList` props, unchanged.
  // Each pick presumes one new desktop IPC result (ISS-12521 AC-004): the
  // picked path plus two filesystem verdicts the main process computes,
  // `unreadable` from `checkPathReadable` (file-access-probe.ts) and
  // `tccProtected` from `isTccProtectedDirectory` (sandbox-policy.ts).
  deliveryMode: PrototypeDeliveryMode.ProductionBound,
} satisfies PrototypeMeta;
