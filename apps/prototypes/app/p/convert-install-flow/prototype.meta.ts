import {
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "convert-install-flow",
  title: "Convert & Install",
  summary:
    "Discover a component in one harness format, convert it to another, preview what carries over vs. what's dropped or unsupported (FEA-4078 capability map), then confirm and install. Covers clean, partial, blocked, converting, error, and installed states.",
  author: "Metal Parker",
  status: PrototypeStatus.Draft,
  tags: [PrototypeTag.Feature],
  createdAt: "2026-07-24",
  linearIssue: null,
  closedloopDoc: "FEA-4075",
} satisfies PrototypeMeta;
