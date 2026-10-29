import {
  PrototypeDeliveryMode,
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "data-controls-device-policy-web",
  title: "Data controls: show the device data policy on web",
  summary:
    "ISS-12531: each desktop device's reported sync level and directory scope, read-only on web, with the not-reported state. No edit is offered.",
  author: "Nerys Applethwaite",
  status: PrototypeStatus.InProgress,
  tags: [PrototypeTag.Feature],
  createdAt: "2026-10-20",
  linearIssue: null,
  closedloopDoc: "ISS-12531",
  // PRODUCER RECORD (`apps/prototypes/AGENTS.md`). No API reports another
  // device's policy to web: `ComputeTarget` has no sync-policy column and the
  // only `dataSyncLevel` is per session (ISS-8366 ruling). The prototype
  // presumes a per-device report carrying the level, a directory count and
  // the ISS-12520 `DirectoryScopeList` entries / includedIds / autoExcluded,
  // null for a device that has reported none. Machine names come from
  // `ComputeTarget.machineName`.
  deliveryMode: PrototypeDeliveryMode.ProductionBound,
} satisfies PrototypeMeta;
