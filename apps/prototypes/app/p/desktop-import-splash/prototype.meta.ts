import {
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "desktop-import-splash",
  title: "Desktop Import Splash",
  summary:
    "First-launch splash that surfaces the current activity while the desktop app imports and analyzes your local agent history: a phase stepper (Scan, Import, Compute, Ready), live per-harness session counts, and calm on-device reassurance. Replaces the thin importing-history banner.",
  author: "Kaiti",
  status: PrototypeStatus.ReadyForReview,
  tags: [PrototypeTag.Feature],
  createdAt: "2026-07-22",
  linearIssue: null,
  closedloopDoc: "FEA-3645",
} satisfies PrototypeMeta;
