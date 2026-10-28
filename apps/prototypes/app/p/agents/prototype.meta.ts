import {
  PrototypeDeliveryMode,
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "agents",
  title: "Agentic Components Page",
  summary:
    "App-shell Agentic Components inventory: a grouped table of agents, commands, and skills with Filter/View menus, plus a component detail page with a properties panel and Sessions/Branches tables.",
  author: "Pascoe",
  status: PrototypeStatus.ReadyForReview,
  tags: [PrototypeTag.Feature],
  createdAt: "2026-07-06",
  linearIssue: null,
  closedloopDoc: null,
  deliveryMode: PrototypeDeliveryMode.DisposableSketch,
} satisfies PrototypeMeta;
