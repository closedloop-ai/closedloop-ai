import {
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "my-machines",
  title: "My Machines",
  summary:
    "Member-scoped pack install summary across their own registered machines: one card per machine with an install ratio and by-kind breakdown, expanding to per-component detail (status glyph, kind, harness). Covers all-installed, partial, offline (never hidden), empty, loading and error.",
  author: "Metal Parker",
  status: PrototypeStatus.Draft,
  tags: [PrototypeTag.Feature],
  createdAt: "2026-07-25",
  linearIssue: null,
  closedloopDoc: "FEA-4076",
} satisfies PrototypeMeta;
