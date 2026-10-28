import {
  PrototypeDeliveryMode,
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "data-controls-onboarding-directories",
  title: "Data controls: onboarding directory step",
  summary:
    "ISS-12524: a guided-onboarding step, before the sync-level step, where a first-time user reviews discovered directories, adds or removes them, and confirms what is in scope. Continue stays available with nothing selected. The add control's copy is approved (ISS-12521); every other slot shows a placeholder.",
  author: "Nerys Applethwaite",
  status: PrototypeStatus.ReadyForReview,
  tags: [PrototypeTag.Feature],
  createdAt: "2026-10-19",
  linearIssue: null,
  closedloopDoc: "ISS-12524",
  // PRODUCER RECORD (`apps/prototypes/AGENTS.md`). `entries`, `includedIds`
  // and `autoExcluded` are ISS-12520's `DirectoryScopeList` props and the
  // picker is ISS-12521's adapter, both unchanged. Wiring presumes one new
  // onboarding result: the confirmed `includedIds`, persisted by the host
  // before the sync-level step; nothing produces it yet.
  deliveryMode: PrototypeDeliveryMode.ProductionBound,
} satisfies PrototypeMeta;
