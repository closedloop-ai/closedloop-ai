import {
  PrototypeDeliveryMode,
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "desktop-data-sync-level",
  title: "Desktop Data Sync Level",
  summary:
    "Graduated 'data sync level' selector for desktop Settings (FEA-3907): one radio-group — Full transcripts, Metadata only, Off — that supersedes four scattered Labs toggles (Cloud Connection, Transcript Sync, Cloud Commands Paused, Data Collection). (Redacted sessions is omitted until the redaction lane ships, matching production which hides it.) Since ISS-12522 each level renders the canonical shared card, with its visual of what stays on this device and what is uploaded, so the card's chips and copy are production's: Full transcripts carries the Recommended chip, and the earlier Default and Elevated chips are gone.",
  author: "Marisol Ashgrove",
  status: PrototypeStatus.HandedOff,
  tags: [PrototypeTag.Feature],
  createdAt: "2026-07-23",
  linearIssue: null,
  closedloopDoc: "FEA-3907",
  deliveryMode: PrototypeDeliveryMode.DisposableSketch,
} satisfies PrototypeMeta;
