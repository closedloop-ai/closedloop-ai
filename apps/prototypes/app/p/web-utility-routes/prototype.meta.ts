import {
  PrototypeDeliveryMode,
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "web-utility-routes",
  title: "Web Diagnostics & Help utility routes",
  summary:
    "ISS-10006 reference mount. Web has no Diagnostics or Help route today; both shared surfaces already exist and desktop mounts them. This is the Web mock host for both: the real DiagnosticsSurfaceV2 over a host with no probe, and the real HelpSurfaceV2 over the corpus apps/web already publishes. The per-capability treatment ruling of 2026-09-22 is recorded in this meta, including the one treatment (Gateway Logs' explanation) this sandbox cannot express.",
  author: "Nerys",
  status: PrototypeStatus.ReadyForReview,
  tags: [PrototypeTag.Feature],
  createdAt: "2026-09-17",
  linearIssue: null,
  closedloopDoc: "ISS-10006",
  // PRODUCER RECORD (`apps/prototypes/AGENTS.md`). What each capability reads
  // today, and what a browser host can do about it. Verified against
  // `complete-surface-registry.ts` and the two surfaces' published prop
  // contracts.
  //
  // DIAGNOSTICS — every section is fed by ONE local read,
  // `window.desktopApi.db.getDiagnostics`, over this machine's own gateway
  // store. It runs no system check (`SystemCheckBootstrap` still owns that;
  // FEA-976 owns unifying them) and carries no repair commands. So no section
  // is browser-executable, and the treatment question is per capability:
  //   Repos / Backfill / Links -> `optional: false`. Web cannot omit them, and
  //     a null payload renders an EMPTY body, which asserts "there are no
  //     repos" when the truth is "this host cannot serve this". The
  //     2026-09-22 ruling calls that the confident-zero defect class ISS-9931
  //     and ISS-10541/10543 already fixed, and requires a route-level
  //     unavailable notice instead. This sandbox renders that notice.
  //   Withheld / Coverage -> optional. Dropping them from
  //     `source.availableSections` removes the tab with no statement; the
  //     ruling requires explicit absence, so `WEB_AVAILABLE_SECTIONS` keeps
  //     both tabs.
  //   Gateway Logs -> `logs: ReactNode | null`. Ruled DISABLED WITH AN
  //     EXPLANATION, not omitted and not a Desktop hand-off (the browser
  //     cannot observe whether `closedloop://` was handled, and a
  //     section-targeted link owes ISS-6109's allowlist, which does not exist).
  //     NOT EXPRESSIBLE IN THIS SANDBOX: the explanation is a host-supplied
  //     node, and a production-bound route may render no markup of its own, so
  //     `logs` is null here and the tab is absent. The production mount adds
  //     the per-section unavailable state the ruling authorised, in
  //     `packages/app/diagnostics`, and expresses it there.
  //   Refresh -> the ruling forbids a live Refresh on Web. Expressible since
  //     the production mount (PR #7757) added `source.unservableReason`: set,
  //     it names the reason in every section body and the surface drops
  //     Refresh on its own, which this preview now passes. `source.autoRefresh`
  //     is nullable and null already removes Pause/Resume.
  //
  // HELP — no device-only capability at all. All four are docs reads, and
  // `apps/web/content/docs` already publishes the same corpus with the same
  // `meta.json` group/pages shape, so Web mounts Help whole. The one capability
  // that is not a plain fetch is search into a heading anchor, which spans this
  // host's index, the surface's `pendingHeadingSlug` and `HelpReader`'s id
  // match. The slug algorithm must match the one the corpus was stamped with,
  // because nothing downstream reports a miss.
  //
  // ONE LAYOUT FINDING, and it is the shared surface's rather than Web's:
  // `HelpSurfaceV2`'s nav pane is a fixed 18rem that never shrinks, so below
  // roughly 30rem of viewport the reader pane has no measure left. A Web route
  // owes a narrow-viewport treatment in `HelpSurfaceV2` itself.
  //
  // Production-bound: this route is a mock host of two surfaces production
  // mounts, and authors none of its own markup.
  deliveryMode: PrototypeDeliveryMode.ProductionBound,
} satisfies PrototypeMeta;
