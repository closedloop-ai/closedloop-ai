import {
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "desktop-sync-settings",
  title: "Desktop Sync / Privacy Settings",
  summary:
    "Durable Settings control for the desktop sync-observability tier (FEA-3543): a logged-in user views their current tier (Full / Metadata / Local), sees each tier's data-sharing implications inline, and changes it at any time. Covers the unset (null) tier state that silently strands uploads, and shows the upgrade-opens-lanes / downgrade-closes-lanes effect on save.",
  author: "Kaiti",
  status: PrototypeStatus.ReadyForReview,
  tags: [PrototypeTag.Feature],
  createdAt: "2026-07-20",
  linearIssue: null,
  closedloopDoc: "FEA-3543",
} satisfies PrototypeMeta;
