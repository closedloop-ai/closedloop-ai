/**
 * Frontend-only PostHog feature-flag keys for apps/app.
 *
 * These gate client UI rollout and are never read by apps/api, so they live
 * here rather than in `@repo/api` (which is reserved for contract types shared
 * by both apps). Flag keys are kebab-case to match the existing PostHog
 * convention (e.g. `branch-pr`, `compute-target-signing`).
 */

import {
  AGENTS_FEATURE_FLAG_KEY as AGENTS_FEATURE_FLAG_KEY_CANONICAL,
  DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY,
} from "@repo/api/src/types/agent-session";
import { ArtifactFlag as ArtifactFlagValue } from "./artifact-flags";

/**
 * Gates the stack-rank project page experience (PRD-421 / PLN-755). When
 * enabled, the project page defaults to stack-rank ordering, exposes the
 * "Reset to stack rank" action in the view menu, and shows the drag handle,
 * keyboard reorder, and Move-to-top / Move-to-bottom row menu items.
 */
export const STACK_RANK_PROJECT_PAGE_FEATURE_FLAG_KEY =
  "stack-rank-project-page" as const;

/**
 * Artifact flags are defined in `artifact-flags.ts` so browser E2E fixtures can
 * import the route-gating keys without pulling this module's unrelated
 * transitive workspace imports into Playwright.
 *
 * `BranchDetail` is the legacy desktop-era key for an independently gated
 * branch-detail surface. The web Branches surface now uses the provisioned
 * `branches-nav` flag for both the list and detail route because PostHog does
 * not currently define `branch-detail-page`.
 *
 * Resolution on desktop is key-agnostic: `DesktopFeatureFlagProvider`
 * (`apps/desktop/src/renderer/feature-flags/desktop-feature-flag-provider.tsx`)
 * adapts `useFeatureFlagEnabled` to `() => flagsEnabled`, deriving every flag
 * from the build type. Keep this legacy key available for compatibility unless
 * a follow-up explicitly removes the older desktop split-gate contract.
 */
export const ArtifactFlag = ArtifactFlagValue;
export type ArtifactFlag = (typeof ArtifactFlag)[keyof typeof ArtifactFlag];

/**
 * PostHog flag keys for nav destinations that reuse a flag owned elsewhere
 * (Sessions and Agent Monitoring borrow the desktop session-sync flag; Agents
 * and Judges borrow their respective feature flags) rather than carrying a
 * dedicated artifact-route flag like {@link ArtifactFlag}.
 *
 * Shared by the sidebar (`sidebar.tsx`) and the command palette
 * (`command-palette.tsx`) so a destination the sidebar gates is gated
 * identically in the palette — the "gated identically" promise is enforced by
 * importing the same constant rather than by parallel string literals.
 *
 * Sessions and Agent Monitoring borrow the desktop session-sync flag, whose
 * canonical key lives in `@repo/api`
 * ({@link DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY}). Re-export that constant
 * here rather than redeclaring the literal so the two cannot silently drift —
 * they refer to one PostHog flag and most pages already treat the `@repo/api`
 * constant as canonical.
 *
 * The Agents flag is likewise gated by both this client UI and the server loop
 * context-pack (`apps/api`), so its canonical key also lives in `@repo/api`
 * ({@link AGENTS_FEATURE_FLAG_KEY_CANONICAL}). Re-export it here for the same
 * anti-drift reason.
 */
export const SESSIONS_FEATURE_FLAG_KEY =
  DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY;
export const AGENTS_FEATURE_FLAG_KEY = AGENTS_FEATURE_FLAG_KEY_CANONICAL;
export const JUDGES_FEATURE_FLAG_KEY = "the-one-flag" as const;

/**
 * Web authorize/consent page for the desktop loopback OAuth flow (FEA-2460).
 * The desktop only opens the authorize URL when its own first-party-auth flag
 * is on; this PostHog flag additionally gates the web surface so it can be
 * dark-launched and enabled for functional testing independently.
 *
 * Coordination requirement (FEA-2686): this flag must reach 100% for the target
 * users BEFORE the desktop `desktopFirstPartyAuthEnabled` flag ships enabled —
 * otherwise the desktop opens a browser page that dead-ends on "Not available",
 * stranding the user mid-sign-in. Keep the two flags in lockstep.
 */
export const DESKTOP_LOOPBACK_AUTH_FEATURE_FLAG_KEY =
  "desktop-loopback-auth" as const;

/**
 * Gates the Loops "Usage Dashboard" (`/[orgSlug]/loops/usage`). Shared by the
 * Loops page (`loops/page.tsx`), which hides the Usage button, and the usage
 * route itself (`loops/usage/page.tsx`), which route-gates the dashboard so a
 * user with the flag off cannot deep-link past the hidden link. Importing the
 * same constant in both places keeps the link and the route gated identically
 * rather than by parallel string literals.
 */
export const LOOPS_USAGE_PAGE_FEATURE_FLAG_KEY = "loops-usage-page" as const;

/**
 * Gates the collapsible session-details comments rail (FEA-2479). When enabled,
 * the right-side trace comments rail gains a collapse control plus a persisted
 * re-open handle so readers can reclaim horizontal space; when off, the rail
 * stays permanently open exactly as before. Shared by web and desktop via the
 * `AgentSessionDetailView`.
 */
export const SESSION_COMMENTS_RAIL_COLLAPSE_FEATURE_FLAG_KEY =
  "session-comments-rail-collapse" as const;

/**
 * Gates the Sessions "Changes" and "Pull request" filter facets (FEA-2505).
 * When enabled, the Sessions filter menu exposes the "Has changes / No changes"
 * and "Has PR / No PR" facet groups; the server always honors the query params,
 * so the flag only controls the UI rollout.
 */
export const SESSIONS_CHANGE_PR_FILTERS_FEATURE_FLAG_KEY =
  "sessions-change-pr-filters" as const;

/**
 * Gates the FEA-3120 read-source indicator (PRD-525 Priority 2, DoD #6) on the
 * Sessions and Branches toolbars — the small `Local`/`Cloud`/`Fallback` badge
 * that tells QA which store a surface rendered from. UI-only rollout: the
 * `readSource` discriminator is always populated on the data contract; this flag
 * only controls whether the badge is shown. Shared by web and desktop.
 */
export const READ_SOURCE_INDICATOR_FEATURE_FLAG_KEY =
  "read-source-indicator" as const;

/**
 * Gates surfacing Tools, MCPs, and Hooks as first-class kinds in the Agents
 * listing (FEA-3152). Off by default → tool/mcp/hook stay scoped-out
 * (reachable only via the "All" tab, no dedicated top-level type tab), exactly
 * as today. On → each gets its own top-level type tab alongside
 * Agents/Commands/Skills/Plugins. These kinds stay OBSERVABLE-ONLY: the flag
 * only affects listing visibility and never adds them to the
 * promote/catalog/distribution flow.
 *
 * Desktop Labs concept: the packaged desktop renderer has no PostHog wiring, so
 * this unknown shared flag resolves to false in release builds — users opt in
 * from Settings → Labs, where it is registered in the desktop feature-flag
 * registry. On web, PostHog does not define this key, so it resolves false and
 * the web Agents page is unchanged. The shared `AgentsGroupedList` resolves it
 * via `useFeatureFlagEnabled`. Must stay byte-for-byte equal to the desktop
 * registry entry key in `apps/desktop/src/shared/feature-flags.ts`.
 */
export const AGENTS_SHOW_TOOLS_MCPS_HOOKS_FEATURE_FLAG_KEY =
  "agents-show-tools-mcps-hooks" as const;

/**
 * Gates the extended pack-content kinds in the unified Plugin Catalog / Packs
 * UX. The discovery experience surfaces five content kinds by default — agents,
 * skills, commands, hooks, and MCP tools. Off by default → the extended kinds
 * (`plugin`, `tool`) that a marketplace/bundle pack can also contain stay hidden
 * from the Contents tab and card summaries. On → they render alongside the
 * default five.
 *
 * Shared by web and desktop; the packs surfaces resolve it via
 * `useFeatureFlagEnabled` and pass the result into `createPacksContext` as the
 * `showExtendedContentKinds` capability. Must stay byte-for-byte equal to the
 * desktop registry entry key in `apps/desktop/src/shared/feature-flags.ts`.
 */
export const PACK_EXTENDED_CONTENT_KINDS_FEATURE_FLAG_KEY =
  "pack-extended-content-kinds" as const;
