/**
 * Frontend-only PostHog feature-flag keys for apps/app.
 *
 * These gate client UI rollout and are never read by apps/api, so they live
 * here rather than in `@repo/api` (which is reserved for contract types shared
 * by both apps). Flag keys are kebab-case to match the existing PostHog
 * convention (e.g. `branch-pr`, `compute-target-signing`).
 */

/**
 * Gates the stack-rank project page experience (PRD-421 / PLN-755). When
 * enabled, the project page defaults to stack-rank ordering, exposes the
 * "Reset to stack rank" action in the view menu, and shows the drag handle,
 * keyboard reorder, and Move-to-top / Move-to-bottom row menu items.
 */
export const STACK_RANK_PROJECT_PAGE_FEATURE_FLAG_KEY =
  "stack-rank-project-page" as const;

/**
 * PostHog feature-flag keys for the Artifacts section. Each artifact is gated
 * individually — these flags control both the sidebar nav item and the page
 * route — so the nav and the page stay in sync for each artifact.
 *
 * `BranchDetail` gates the branch-detail **route** (`/branches/:id`) and the
 * list-row→detail navigation affordance. It carries the `-page` suffix (not
 * `-nav`) so the detail surface gates **independently** of the `branches-nav`
 * list flag: the Branches list already exists, while the detail page is a new
 * surface that can roll out on its own schedule. Keep the route guard and the
 * list-row affordance in sync the way nav+route stay in sync for the other
 * artifact flags.
 *
 * Resolution on desktop is key-agnostic: `DesktopFeatureFlagProvider`
 * (`apps/desktop/src/renderer/feature-flags/desktop-feature-flag-provider.tsx`)
 * adapts `useFeatureFlagEnabled` to `() => flagsEnabled`, deriving every flag
 * from the build type — so `BranchDetail` is enabled in dev/unpackaged builds
 * and disabled in packaged builds with no adapter change, exactly like
 * `Branches`. That provider is the future site for explicit PostHog
 * registration of these keys; no web PostHog wiring changes here.
 */
export const ArtifactFlag = {
  Documents: "documents-nav",
  Issues: "issues-nav",
  Branches: "branches-nav",
  BranchDetail: "branch-detail-page",
} as const;
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
 */
export const SESSIONS_FEATURE_FLAG_KEY = "desktop-agent-session-sync" as const;
export const AGENTS_FEATURE_FLAG_KEY = "agents" as const;
export const JUDGES_FEATURE_FLAG_KEY = "the-one-flag" as const;
