import {
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "install-matrix",
  title: "Install Matrix",
  summary:
    "Per-target (registered machine) × per-harness (Claude / Codex / OpenCode) install matrix for a pack component: one status per cell, per-cell install affordance, unsupported and offline-target treatments, plus loading, error and empty states.",
  author: "Metal Parker",
  status: PrototypeStatus.Draft,
  tags: [PrototypeTag.Feature],
  createdAt: "2026-07-25",
  linearIssue: null,
  closedloopDoc: "FEA-4074",
} satisfies PrototypeMeta;
