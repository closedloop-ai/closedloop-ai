import {
  PrototypeDeliveryMode,
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "web-404",
  title: "Marketing 404",
  summary:
    "The not-found screen for www.closedloop.ai. A visitor who followed a stale link gets the status, the reason, and a recovery path built only from marketing pages that actually exist. Presumes no new routes and no site search. Every link points at a production apps/web path, so none of them resolves inside the sandbox: what the prototype fixes is WHICH destinations the screen offers, not where they land at :3030. The header, the first-visit SiteBanner and the mobile nav are stand-ins for apps/web's (site) layout, reproduced so the screen is judged in the chrome it ships inside. Production is light-only (apps/web forces the light theme); the sandbox follows the viewer's system theme, so read it in light.",
  author: "Perrin",
  status: PrototypeStatus.ReadyForReview,
  tags: [PrototypeTag.Feature],
  createdAt: "2026-09-02",
  linearIssue: null,
  closedloopDoc: "ISS-8949",
  deliveryMode: PrototypeDeliveryMode.DisposableSketch,
} satisfies PrototypeMeta;
