import {
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "desktop-data-sync-level",
  title: "Desktop Data Sync Level",
  summary:
    "Graduated 'data sync level' selector for desktop Settings (FEA-3907): one radio-group — Off, Metadata only (DEFAULT), Full transcripts (elevated) — that supersedes four scattered Labs toggles (Cloud Connection, Transcript Sync, Cloud Commands Paused, Data Collection). Each level shows its data-sharing implications inline; the recommended level carries a DEFAULT chip and the most-permissive level an elevated-risk badge + Learn more. (Redacted sessions is omitted until the redaction lane ships, matching production which hides it.)",
  author: "Mike Angstadt",
  status: PrototypeStatus.ReadyForReview,
  tags: [PrototypeTag.Feature],
  createdAt: "2026-07-23",
  linearIssue: null,
  closedloopDoc: "FEA-3907",
} satisfies PrototypeMeta;
