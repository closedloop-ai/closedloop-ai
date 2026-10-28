import {
  PrototypeDeliveryMode,
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "data-controls",
  title: "Data controls: the four PRD-796 flows",
  summary:
    "ISS-12519: one resettable prototype of choosing scope, changing the active policy, sharing one session and recovering from an accidental upload, for first-time setup and returning users. Scenario presets sit on the shared condition panel; every slot without approved copy shows a placeholder.",
  author: "Nerys Applethwaite",
  status: PrototypeStatus.InProgress,
  tags: [PrototypeTag.Feature],
  createdAt: "2026-10-22",
  linearIssue: null,
  closedloopDoc: "ISS-12519",
  // PRODUCER RECORD (`apps/prototypes/AGENTS.md`). Every part is a shipped
  // PRD-796 component fed the props its own ticket records: the directory
  // scope list and add control (ISS-12520/12521), sync choice and summary
  // (ISS-12523/12525), scope editor and status (ISS-12527/12526), pause and
  // upload queue (ISS-12528/12529), session upload badge and share exceptions
  // (ISS-12532/12535), deletion entry point and tracker (ISS-12539/12538).
  // No producer exists yet for the directory scope, per-session share state
  // or deletion requests; each is presumed by its own ticket. The share
  // review sheet (ISS-12533) is not on main, so no share action is drawn.
  deliveryMode: PrototypeDeliveryMode.ProductionBound,
} satisfies PrototypeMeta;
