import {
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "tokenops-waste",
  title: "TokenOps: waste vs leverage",
  summary:
    "The judgment half of ISS-4463. Starts from the measured spend-by-session-outcome split (Ended clean / Ended with error / Outcome unknown, keyed on endsWithError), then estimates recoverable waste as a visible RANGE with its basis, assumption, and exclusions on screen, then grades model right-sizing with an explicit ungraded state for models with too few sessions. Shares one session population with the Lost work prototype, so the two cannot disagree about which sessions failed.",
  author: "Parker",
  status: PrototypeStatus.ReadyForReview,
  tags: [PrototypeTag.Feature],
  createdAt: "2026-08-03",
  linearIssue: null,
  closedloopDoc: "ISS-4977",
} satisfies PrototypeMeta;
