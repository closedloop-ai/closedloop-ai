import {
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "packs-page",
  title: "Packs",
  summary:
    "The Packs page, one page whose job flexes by viewer: admin gets a manage-first view (a Packs-you-distribute table with mode, adoption, and usage, marketplace second), member gets a by-source view (Required / Installed with an honest per-row install source, Available second). Source is a labelled icon+text signal, never color alone.",
  author: "Metal Parker",
  status: PrototypeStatus.Draft,
  tags: [PrototypeTag.Feature],
  createdAt: "2026-07-25",
  linearIssue: null,
  closedloopDoc: "FEA-4091",
} satisfies PrototypeMeta;
