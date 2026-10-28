import {
  PrototypeDeliveryMode,
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "sessions-cost-breakdown",
  title: "Sessions Cost Breakdown",
  summary:
    "Sessions Cost card headlined by Total Estimated Cost and broken into reconciling lanes: API-billed, Subscription-covered, and Billing unknown. Lanes inline on a wide card, behind a disclosure at strip width. Covers the skewed production shape, an unsplittable producer, an unpriced cohort, and loading.",
  author: "Cosimo Corrigan",
  status: PrototypeStatus.HandedOff,
  tags: [PrototypeTag.Feature],
  createdAt: "2026-08-24",
  linearIssue: null,
  closedloopDoc: "ISS-4748",
  deliveryMode: PrototypeDeliveryMode.DisposableSketch,
} satisfies PrototypeMeta;
