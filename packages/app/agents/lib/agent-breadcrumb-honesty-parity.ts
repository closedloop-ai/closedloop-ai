import { AGENTS_DETAIL_HONESTY_FLAG_KEY } from "@repo/api/src/types/agents-detail-honesty-flag";

/**
 * TEST-SUPPORT ONLY — imported by the two suites named below, never by
 * production code.
 *
 * ISS-6643: the trailing-crumb identity each surface produces for one component
 * under one pinned state of the shared `agents-detail-honesty` flag.
 *
 * The two rows are captured at different seams, because that is where each
 * surface decides:
 *  - `web` is the label of the last entry in the `breadcrumbs` array
 *    `apps/app/.../agents/[slug]/agent-detail-header.tsx` hands its `Header`.
 *    It gates the resolved name behind the flag and passes `undefined` when off,
 *    so the crumb falls to the neutral `CONTENT_HASH_CRUMB_FALLBACK` ("Agent").
 *  - `desktop` is the trailing segment of the Topbar trail `App.tsx` builds for
 *    the agent route: the title
 *    `apps/desktop/src/renderer/components/agents/agent-detail-view.tsx`
 *    publishes via `usePublishDetailTitle` — with NO flag read at all — run
 *    through the shell's own `activeDetailTitleKey` → `resolveDetailTitle` →
 *    `buildBreadcrumbs` model. That last hop is part of the row on purpose
 *    (whitlockk review on PR #5927): the shell adopts a published title only when
 *    its key matches the route key, so a row read off the raw published title
 *    would stay green while the real Topbar sat on its fallback.
 *
 * Benign while the flag lives — desktop is ahead, not broken — and a defect the
 * moment it is retired on ONE side. WHICH WAY THE TWO SHOULD CONVERGE IS AN
 * OPEN PRODUCT QUESTION (gating desktop takes away a name desktop users see
 * today; ungating web ships a closed-by-default behaviour to everyone), so this
 * records the divergence rather than resolving it.
 *
 * Every crumb value is an INDEPENDENT LITERAL, deliberately duplicating what
 * production computes. Do not "DRY" it by calling `agentBreadcrumbLabel` or by
 * reading `detail.name`: an expectation derived from the code it polices moves
 * with that code and stops catching a surface changing under it.
 *
 * Each surface asserts its own rows against its own REAL render
 * (`agent-detail-header.test.tsx`,
 * `agent-detail-breadcrumb-honesty-parity.test.tsx`), so changing one gate
 * reddens that surface's suite and lands the author here, where the other
 * surface's row is the adjacent line.
 */
export const AGENT_BREADCRUMB_HONESTY_PARITY = {
  /**
   * Held by value so retiring the constant outright fails to compile here, and
   * with it both suites — a silent retirement is what this file exists for.
   */
  flagKey: AGENTS_DETAIL_HONESTY_FLAG_KEY,
  componentName: "RTK Optimizer",
  /**
   * A content-hash route — the default shape for any component with a captured
   * definition — whose `::`-suffix is a digest, so the web crumb has nothing to
   * fall back to but the neutral label.
   */
  hashSlug:
    "skill::c22ccd465ae7be300736a0ed014fbbc9a9721872ab6cf5cab5c1e5f72d5e26dd",
  flagOn: {
    web: "RTK Optimizer",
    desktop: "RTK Optimizer",
  },
  flagOff: {
    web: "Agent",
    desktop: "RTK Optimizer",
  },
} as const;
