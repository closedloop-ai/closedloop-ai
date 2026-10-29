import {
  PrototypeDeliveryMode,
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "data-controls-unset-policy",
  title: "Data controls: distinguish unset policy from explicit no-sync",
  summary:
    "ISS-12523: unset and explicitly saved sync choices through the shared device policy control.",
  author: "Saffi Harrowgate",
  status: PrototypeStatus.InProgress,
  tags: [PrototypeTag.Feature],
  createdAt: "2026-10-19",
  linearIssue: null,
  closedloopDoc: "ISS-12523",
  // currentLevel is the consent-aware projection; selection and mock save are local.
  deliveryMode: PrototypeDeliveryMode.ProductionBound,
} satisfies PrototypeMeta;
