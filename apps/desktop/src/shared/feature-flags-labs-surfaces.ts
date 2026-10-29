/**
 * @file feature-flags-labs-surfaces.ts
 * @description The Labs gates over HOW THE APP SHELL AND ITS LIST/TABLE SURFACES
 * LOAD AND RENDER — startup readiness and the DB-ahead banner, bounded page
 * reads, the shared table primitives, and column layout — split out of
 * `feature-flags.ts` (ISS-7431).
 *
 * Contiguous run, spread back at its original index for review stability.
 * Registry order is no longer a rendered UI contract because ISS-8753 deleted
 * Settings -> Labs.
 */

import { AGENTS_BOUNDED_PAGE_DATA_FLAG_KEY } from "@repo/api/src/types/agents-bounded-page-data-flag";
import { AGENTS_INVOCATIONS_DEDUPE_FLAG_KEY } from "@repo/api/src/types/agents-invocations-dedupe-flag";
import { ARTIFACT_CELL_PRIMITIVES_FLAG_KEY } from "@repo/api/src/types/artifact-cell-primitives-flag";
import { BRANCHES_PINNED_NAME_COLUMN_FLAG_KEY } from "@repo/api/src/types/branches-pinned-name-column-flag";
import { CUSTOM_FIELD_EDITOR_CONTRACTS_FLAG_KEY } from "@repo/api/src/types/custom-field-editor-contracts-flag";
import { ELIGIBLE_BRANCH_NAVIGATION_FLAG_KEY } from "@repo/api/src/types/eligible-branch-navigation-flag";
import { SESSIONS_BRANCHES_TAB_TITLES_FLAG_KEY } from "@repo/api/src/types/sessions-branches-tab-titles-flag";
import { SESSIONS_COMMENT_COUNT_TAG_FLAG_KEY } from "@repo/api/src/types/sessions-comment-count-tag-flag";
import { TAG_CREATE_COLOR_FLAG_KEY } from "@repo/api/src/types/tag-create-color-flag";
import { DESKTOP_STOPPED_LANE_READINESS_FEATURE_FLAG_KEY } from "./stopped-lane-readiness-flag.js";

/**
 * ISS-4792 (ISS-4779 closed-by-default policy for the ISS-4714 UI): desktop-only
 * UI flag (kebab-case, persisted DesktopSettings field) gating the "DB ahead /
 * update required" banner (`AgentMonitorDbAheadBanner`, mounted in `App.tsx`).
 * Default OFF: with it off the banner is never rendered and the app behaves
 * exactly as before this in-flight UI landed. When on, a runtime that reports the
 * local DB is newer than this app build surfaces the pinned update-required
 * banner.
 *
 * `DbAheadBannerGate` reads it through `useFeatureFlagEnabled`, so it resolves
 * from the signed-in account's PostHog assignment like every other UI gate —
 * this entry opts nobody in. Desktop-only means only that there is no web
 * surface to keep in parity, not that a Labs toggle gates it. Registered here
 * so getFlag/setFlag type casts remain sound and the key carries a default-off
 * `DesktopSettings` field.
 */
export const DESKTOP_DB_AHEAD_BANNER_FEATURE_FLAG_KEY = "db-ahead-banner";
/**
 * ISS-6207 (ISS-4779 closed-by-default policy): desktop-only UI flag gating
 * the renderer surfacing the SECOND degraded terminal of the boot import — it settled
 * with source files outstanding after their bounded automatic re-drive budget
 * was spent (`retriesExhausted`).
 *
 * Gates exactly ONE thing: the first-launch splash's new give-up SENTENCE
 * (`isBootImportGiveUpVisible`). Off, the splash says what it says today.
 *
 * It deliberately gates no PREDICATE, and an earlier revision that tried to —
 * dropping `retriesExhausted` at the renderer's ingest projection, on the theory
 * that this reproduced an older main process — is why. It does not reproduce
 * one: the main-process half of this ticket is unconditional (dark-launching a
 * data-integrity fix OFF would ship the defect), so where an older main process
 * sent `complete: true` on a retry-exhausted boot import, the new one sends
 * `complete: false`. Any consumer handed the pre-ticket predicate over the
 * post-ticket value gets a stopped import that reads as still running: the
 * summary-card poll never latches off, the readiness panel sticks on
 * "Processing history", and the Sessions read gate never opens. So the startup
 * panel, the summary cards, the settled predicates and the read gate all fold
 * the degraded terminal unconditionally — that is what preserves today's
 * behaviour, and none of them renders new copy.
 *
 * The distinction that matters, and the one ISS-4779 actually draws: gate the
 * sentence a user reads, never the fact a producer states.
 *
 * Desktop-only surface (`apps/app` has no boot import), so there is no second
 * surface to keep in parity. The gate itself is still a PostHog one:
 * `useBootImportDegradedTerminalEnabled` reads it through the optional adapter
 * hook, which resolves from the signed-in account's assignment and yields
 * `false` wherever no adapter is mounted.
 */
export const DESKTOP_BOOT_IMPORT_DEGRADED_TERMINAL_FEATURE_FLAG_KEY =
  "boot-import-degraded-terminal";
/**
 * FEA-4204 (ISS-4779 closed-by-default policy): shared web+desktop UI flag
 * gating the comment-count tag in the Sessions list's lead cell. Default OFF:
 * with it off the lead cell renders the session name and nothing else, exactly
 * as ISS-5666 / ISS-5770 left it. The renderer resolves this shared key from
 * the signed-in account's PostHog assignment — the same key space the web app
 * reads — so one key gates both surfaces. Aliases the shared `@repo/api`
 * constant rather than redeclaring the literal, so a rename touches one
 * definition.
 */
export const DESKTOP_SESSIONS_COMMENT_COUNT_TAG_FEATURE_FLAG_KEY =
  SESSIONS_COMMENT_COUNT_TAG_FLAG_KEY;
/**
 * ISS-6959 (ISS-4779 closed-by-default policy): shared web+desktop UI flag
 * gating the pinned Name column on the Branches list. Default OFF. The renderer
 * resolves this shared key from the signed-in account's PostHog assignment —
 * the same key space the web app reads — so the pin cannot leak on desktop
 * while hidden on web. This entry carries the key's default-off main-process
 * settings metadata only; it neither gates the column nor offers a renderer
 * opt-in. Aliases the shared `@repo/api` constant rather than redeclaring the
 * literal, so a rename touches one definition.
 */
export const DESKTOP_BRANCHES_PINNED_NAME_COLUMN_FEATURE_FLAG_KEY =
  BRANCHES_PINNED_NAME_COLUMN_FLAG_KEY;
/**
 * ISS-5534 (ISS-4779 closed-by-default policy): shared web+desktop UI flag
 * gating the Agents list Invocations summary card's plugin de-duplication — a
 * plugin's invocations ARE its skill/command/subagent/mcp children's, so on the
 * "All" type tab, where both are rows, the card's flat sum double-counts them.
 * Default OFF: with it off the card renders exactly the prior total. The
 * renderer resolves this shared key from the signed-in account's PostHog
 * assignment — the same key space the web app reads — so one key gates both
 * surfaces. Aliases the shared `@repo/api` constant rather than redeclaring the
 * literal, so a rename touches one definition.
 */
export const DESKTOP_AGENTS_INVOCATIONS_DEDUPE_FEATURE_FLAG_KEY =
  AGENTS_INVOCATIONS_DEDUPE_FLAG_KEY;
/**
 * ISS-6822 (ISS-4779 closed-by-default policy): shared web+desktop UI flag
 * gating the Agents list's BOUNDED page-data read. Default OFF: with it off the
 * list reads the whole local inventory over IPC and reduces it in the renderer,
 * exactly as today. The renderer resolves this shared key from the signed-in
 * account's PostHog assignment — the same key space the web app reads — so one
 * key gates both surfaces. Aliases the shared `@repo/api` constant rather
 * than redeclaring the literal, so a rename touches one definition.
 */
export const DESKTOP_AGENTS_BOUNDED_PAGE_DATA_FEATURE_FLAG_KEY =
  AGENTS_BOUNDED_PAGE_DATA_FLAG_KEY;
/**
 * ISS-6384 (ISS-4779 closed-by-default policy): shared web+desktop UI flag
 * gating ADOPTION of the shared artifact cell primitives (`CountCell`,
 * `MonoIdCell`, `InlineScalarCell`) by the four production surfaces that were
 * each hand-rolling the same data types.
 *
 * The Agents catalog, the Branches table, the agent-detail Sessions tab, and
 * the documents grid all mount in this renderer, which resolves this shared key
 * from the signed-in account's PostHog assignment — the same key space the web
 * app reads — so the convergence cannot land on one surface while the other
 * keeps its hand-rolls. Aliases the shared
 * `@repo/api` constant rather than redeclaring the literal, so a rename touches
 * one definition.
 */
export const DESKTOP_ARTIFACT_CELL_PRIMITIVES_FEATURE_FLAG_KEY =
  ARTIFACT_CELL_PRIMITIVES_FLAG_KEY;
/**
 * ISS-6385 (ISS-4779 closed-by-default) — the desktop half of the shared
 * web+desktop key gating the create-a-tag-then-pick-its-colour step in
 * `TagPicker`.
 *
 * `TagPicker` reaches this renderer transitively, not by a direct import:
 * `BranchesView` renders `BranchesListSurfaceV2`, which routes an approved cohort to
 * `ApprovedBranchesTable`, which renders `TagPicker` with `showCreate` for a
 * user holding tag-apply permission — the exact create flow this gates. A grep
 * for `tag-picker` under `apps/desktop/src` finds nothing, which is why the
 * first cut of this flag wrongly called the step web-only; the render path is
 * what decides parity, not the import list. This renderer resolves the shared
 * key from the signed-in account's PostHog assignment — the same key space the
 * web app reads — so the step cannot light up here while hidden on web.
 * Aliases the shared `@repo/api` constant so a rename touches one definition.
 */
export const DESKTOP_TAG_CREATE_COLOR_FEATURE_FLAG_KEY =
  TAG_CREATE_COLOR_FLAG_KEY;
/**
 * ISS-8215 / ISS-8214 (ISS-4779 closed-by-default) — the desktop half of the
 * shared web+desktop key over the two custom-field editor contract corrections:
 * an enum option created from the Sessions add-field dialog persists the
 * canonical colour id rather than the dialog's Tailwind class, and a reference
 * picker stops offering the row that owns the value.
 *
 * `CustomFieldTableCell` and `SessionsAddFieldDialog` live in `@repo/app` and
 * reach this renderer through a RENDER path — the Sessions surface's custom-
 * field columns — rather than a direct import, so grepping `apps/desktop/src`
 * for their file names is the wrong question. This renderer resolves the shared
 * key from the signed-in account's PostHog assignment — the same key space the
 * web app reads — so neither correction can light up here while hidden on web. Aliases the shared `@repo/api` constant so a rename touches one
 * definition.
 */
export const DESKTOP_CUSTOM_FIELD_EDITOR_CONTRACTS_FEATURE_FLAG_KEY =
  CUSTOM_FIELD_EDITOR_CONTRACTS_FLAG_KEY;
/** Shared key reserved for the audited Branch navigation cutover. */
export const DESKTOP_ELIGIBLE_BRANCH_NAVIGATION_FEATURE_FLAG_KEY =
  ELIGIBLE_BRANCH_NAVIGATION_FLAG_KEY;
/**
 * ISS-5574 (ISS-4779 closed-by-default policy): shared web+desktop UI flag
 * gating per-page browser tab titles on the Sessions and Branches surfaces.
 * Every one of those pages reported the application-wide title, so several open
 * tabs were indistinguishable and history carried no record identity. Default
 * OFF: with it off the renderer leaves the window title exactly as the entry HTML
 * set it. The renderer resolves this shared key from the signed-in account's
 * PostHog assignment — the same key space the web app reads — so one key gates
 * both surfaces. Aliases the shared `@repo/api` constant rather than
 * redeclaring the literal, so a rename touches one definition.
 */
export const DESKTOP_SESSIONS_BRANCHES_TAB_TITLES_FEATURE_FLAG_KEY =
  SESSIONS_BRANCHES_TAB_TITLES_FLAG_KEY;
/** Registry entries for the shell and list/table gates, in registry order. */
export const LABS_SURFACE_FEATURE_FLAGS = [
  {
    // ISS-6206 (ISS-4779 closed-by-default): gates the honest whole-app
    // cloud-readiness verdict — a lane that never ran no longer counts toward
    // "Up to date", and an outstanding backlog is reported per lane instead of
    // as one cross-lane total whose units do not add up. Off by default, so an
    // installed build keeps today's behavior until someone opts in.
    // Desktop-only surface, so there is no web sibling to keep in parity; the
    // renderer still resolves the gate from the signed-in PostHog assignment.
    key: DESKTOP_STOPPED_LANE_READINESS_FEATURE_FLAG_KEY,
    default: false,
    label: "Honest cloud sync status",
    description:
      "Only say your history is up to date once every sync lane has actually run and delivered. A lane that is switched off or has not started yet reads as 'Checking…' instead of counting as synced, and a backlog is reported per kind — sessions, transcripts, comments — rather than as one combined number.",
    category: "Labs" as const,
  },
  {
    // ISS-4792 (ISS-4779 closed-by-default): gates the "DB ahead / update
    // required" banner (ISS-4714). Off by default — with it off the banner is
    // never rendered, matching the app's behavior before the in-flight UI
    // landed. When on, a runtime reporting the local DB is newer than this app
    // build surfaces the pinned update-required banner. Desktop-only, so there
    // is no web sibling; `DbAheadBannerGate` still reads the signed-in PostHog
    // assignment, and this entry gates nothing.
    key: DESKTOP_DB_AHEAD_BANNER_FEATURE_FLAG_KEY,
    default: false,
    label: "DB-ahead update banner",
    description:
      "Shows a prominent 'update required' banner when the local database was created by a newer version of Closedloop than the one you're running, so session parsing and cloud sync can't start until you update. Observable-only.",
    category: "Labs" as const,
  },
  {
    // ISS-6207 (ISS-4779 closed-by-default): gates the ONE new sentence this
    // ticket puts on screen — the first-launch splash's give-up copy. Off by
    // default, so the splash reads exactly as it does today. The predicates
    // behind it are ungated on purpose; the key's docstring above says why.
    // Desktop-only: there is no `apps/app` boot import to leak past a web flag.
    key: DESKTOP_BOOT_IMPORT_DEGRADED_TERMINAL_FEATURE_FLAG_KEY,
    default: false,
    label: "Honest partial-import state",
    description:
      "When the first-launch import stops with files it could not read, the import splash says so instead of reporting it finished. Those files are still retried automatically, and on the next launch.",
    category: "Labs" as const,
  },
  {
    // ISS-6384 (ISS-4779 closed-by-default): shared web+desktop UI flag gating
    // adoption of the shared artifact cell primitives by the four tables that
    // each hand-rolled the same data types. ONE PostHog key gates both
    // surfaces; this entry carries the key's default-off main-process settings
    // metadata and gates nothing in the renderer.
    key: DESKTOP_ARTIFACT_CELL_PRIMITIVES_FEATURE_FLAG_KEY,
    default: false,
    label: "Shared artifact cells",
    description:
      "Uses one shared cell for each kind of value across every table, so counts, versions and dates look and behave the same everywhere. A count of exactly zero on the Agents catalog shows a dash meaning none, matching Branches, instead of a 0; versions read in a monospaced font; and the due-date cell in artifact tables uses the standard date picker.",
    category: "Labs" as const,
  },
  {
    // ISS-6385 (ISS-4779 closed-by-default): shared web+desktop UI flag gating
    // the create-a-tag-then-pick-its-colour step. `TagPicker` reaches this
    // renderer through BranchesView -> BranchesListSurfaceV2 -> ApprovedBranchesTable,
    // so the surface exists on both platforms and owes a gate on both.
    key: DESKTOP_TAG_CREATE_COLOR_FEATURE_FLAG_KEY,
    default: false,
    label: "Pick a tag colour on create",
    description:
      "After you create a tag from the tag picker, the picker stays open and offers the colour palette for it instead of closing on the colour the server picked. The tag is created and applied either way, and its colour is still editable from tag settings.",
    category: "Labs" as const,
  },
  {
    // ISS-8215 / ISS-8214 (ISS-4779 closed-by-default): shared web+desktop UI
    // flag over the two custom-field editor contract corrections deferred from
    // PR #6074. ONE PostHog key gates both surfaces; this entry carries the
    // key's default-off main-process settings metadata and gates nothing in
    // the renderer.
    key: DESKTOP_CUSTOM_FIELD_EDITOR_CONTRACTS_FEATURE_FLAG_KEY,
    default: false,
    label: "Custom field colours and references",
    description:
      "A colour you choose for a custom-field option when you add the field is kept everywhere the field is shown, instead of turning grey outside the table you created it from; options saved earlier get their colour back too. A custom field that points at another record also stops offering the record you are editing, which could never be saved.",
    category: "Labs" as const,
  },
  {
    key: DESKTOP_ELIGIBLE_BRANCH_NAVIGATION_FEATURE_FLAG_KEY,
    default: false,
    label: "Eligible Branch navigation",
    description:
      "Routes verified Product Branch relationships to the canonical Branch Details screen.",
    category: "Labs" as const,
  },
  {
    key: DESKTOP_SESSIONS_BRANCHES_TAB_TITLES_FEATURE_FLAG_KEY,
    default: false,
    label: "Sessions and Branches tab titles",
    // The window title, named plainly: on macOS the title bar is hidden, so this
    // shows up in the Window menu, Mission Control, and the Dock's window list
    // rather than on the window itself; Windows and Linux keep the native frame.
    description:
      "Names the window title after the Sessions or Branches page, or the session or branch, you have open, instead of the app name on every page.",
    category: "Labs" as const,
  },
  {
    // ISS-5534 (ISS-4779 closed-by-default): shared web+desktop UI flag gating
    // the Agents list Invocations summary card's plugin de-duplication. Off by
    // default — with it off the card sums invocations across every row exactly
    // as it does today. ONE PostHog key gates both surfaces; this entry carries
    // the key's default-off main-process settings metadata and gates nothing in
    // the renderer.
    key: DESKTOP_AGENTS_INVOCATIONS_DEDUPE_FEATURE_FLAG_KEY,
    default: false,
    label: "Agents invocations de-duplication",
    description:
      "Stops the Agents list's Invocations card counting a plugin's activity twice. A plugin is never run directly \u2014 its invocation count is the total of the skills and commands inside it \u2014 so on the All tab, where the plugin and those skills are both listed, today's total adds them up twice.",
    category: "Labs" as const,
  },
  {
    // ISS-6822 (ISS-4779 closed-by-default): shared web+desktop UI flag gating
    // the Agents list's bounded page-data read. Off by default — with it off the
    // list loads the whole inventory and does the sorting, filtering, paging,
    // facet counting, and summary maths in the renderer exactly as today. ONE
    // PostHog key gates both surfaces; this entry carries the key's default-off
    // main-process settings metadata and gates nothing in the renderer.
    key: DESKTOP_AGENTS_BOUNDED_PAGE_DATA_FEATURE_FLAG_KEY,
    default: false,
    label: "Agents list bounded page load",
    description:
      "Loads only the page of components you are looking at, plus the filter counts and summary totals, instead of loading every component in the workspace and working it out in the app. The list shows the same rows and the same numbers either way.",
    category: "Labs" as const,
  },
  {
    // FEA-4204 (ISS-4779 closed-by-default): shared web+desktop UI flag gating
    // the comment-count tag in the Sessions list's lead cell. Off by default —
    // with it off the lead cell is the session name and nothing else. ONE
    // PostHog key gates both surfaces; this entry carries the key's default-off
    // main-process settings metadata and gates nothing in the renderer.
    key: DESKTOP_SESSIONS_COMMENT_COUNT_TAG_FEATURE_FLAG_KEY,
    default: false,
    label: "Sessions comment counts",
    description:
      "Marks a session in the list with how many comments it has, next to its name, so you can spot the runs people have discussed. Counts come from ClosedLoop, so they show while you are signed in and online; working offline or signed out, a session shows no count rather than a zero. Sessions with no comments look exactly as they do today.",
    category: "Labs" as const,
  },
  {
    // ISS-6959 (ISS-4779 closed-by-default): shared web+desktop UI flag gating
    // the pinned Name column on the Branches list. Off by default — with it off
    // the Name column scrolls away with every other column exactly as it does
    // today. ONE PostHog key gates both surfaces; this entry carries the key's
    // default-off main-process settings metadata and gates nothing in the
    // renderer.
    key: DESKTOP_BRANCHES_PINNED_NAME_COLUMN_FEATURE_FLAG_KEY,
    default: false,
    label: "Branches pinned name column",
    description:
      "Holds the branch name in place when you scroll the Branches table sideways, so a row still says which branch it is once the later columns are on screen. The table is wider than the window, so today scrolling right to read Status or Last active leaves rows with no name against them. Nothing is hidden or narrowed — every column keeps its width and its place.",
    category: "Labs" as const,
  },
] as const;
