import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import packageJson from "../package.json";
import { PRD725_RELEASE } from "./start-here-version-history-prd725-release";
import { V2_RELEASES } from "./start-here-version-history-v2-releases";

// Newest first. To cut a release, bump `apps/storybook/package.json` and add the
// same version first; the play below prevents the page and package from drifting.
//
// `contents` is a snapshot taken on the release date (from
// `storybook index`), not a live count: it records what the release held,
// which is the point of a history.
//
// Every story file carries one lifecycle tag in its meta (`tags: ["stable"]`;
// ISS-12610, TAXONOMY.md "Lifecycle"), so the sidebar's tag filter can show
// one stage at a time. `.storybook/manager.ts` draws the tag beside each
// sidebar item. Releases before 3.0.0 live in
// `start-here-version-history-v2-releases.ts`.
const RELEASES = [
  {
    version: "11.2.0",
    date: "2026-10-23",
    summary:
      "Data Sync Policy Choice moves from Preview to Stable: it is mounted in the live Connected Devices settings panel, and Preview is reserved for Labs (ISS-13050).",
    contents: [
      { level: "Primitives", entries: 7, stories: 41 },
      { level: "Composites", entries: 91, stories: 670 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 59, stories: 329 },
    ],
    changes: [
      "Composites/Shared/Data Sync/Data Sync Policy Choice: Preview → Stable.",
      "Counts are unchanged from 11.1.0; no entry or story was added or removed.",
    ],
  },
  {
    version: "11.1.0",
    date: "2026-10-23",
    summary:
      "The shared list toolbar gains Search, Without Range and List and Board stories, and its Views and Add field controls move to their own slots.",
    contents: [
      { level: "Primitives", entries: 7, stories: 41 },
      { level: "Composites", entries: 91, stories: 670 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 59, stories: 329 },
    ],
    changes: [
      "Composites/Shared/Artifact List/Filtering and Sorting Model: new stories Search, Without Range and List And Board.",
      "Counts are from 11.0.0 plus the three new stories.",
    ],
  },
  {
    version: "11.0.0",
    date: "2026-10-22",
    summary:
      "The Local Compute Targets settings panel is removed with the compute-target feature (ISS-12784), so its Surfaces entry is removed. Its story URLs no longer resolve; the panel id now opens Connected Devices.",
    contents: [
      { level: "Primitives", entries: 7, stories: 41 },
      { level: "Composites", entries: 91, stories: 667 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 59, stories: 329 },
    ],
    changes: [
      "Removed from Surfaces/Workspace Menu/Settings: Local Compute Targets (Default, Empty: 2 stories).",
      "Counts are from 10.0.0 minus the removed entry.",
    ],
  },
  {
    version: "10.0.0",
    date: "2026-10-22",
    summary:
      "Document and Issue Detail share one canvas toolbar, Branch, Document and Issue show the live Sessions tab with a full example, every tab but Artifact sits on the page with no card, and the avatar follows Figma: one letter, one colour pair, seven sizes and an online dot. A major release because Person Avatar is retitled Avatar, so its story URLs change.",
    contents: [
      { level: "Primitives", entries: 7, stories: 41 },
      { level: "Composites", entries: 91, stories: 667 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 60, stories: 331 },
    ],
    changes: [
      "Primitives/Data Display/Person Avatar is now Primitives/Data Display/Avatar: every size side by side, size and online controls, light and dark. Its links move from primitives-data-display-person-avatar--* to primitives-data-display-avatar--*. Primitives v1.0/Data Display/Avatar stays as the baseline.",
      "Every person avatar draws one initial on one colour pair (Zinc/200 on Zinc/950 light, Zinc/700 on Zinc/50 dark), the letter centred on its cap height; the online dot is Green/600 (light) or Green/800 (dark).",
      "Surfaces/Labs/Documents/Document Detail and Issues/Issue Detail: one canvas toolbar. Documents carry the live editor's text controls and version; issues their slug (with the issue icon) and key fields, and an edit bar under the toolbar once the text is clicked (new Issue Detail story: Editing). Add comment moves to the page header beside the comments toggle; the toolbar's right end is kept for Publish.",
      "Branch, Document and Issue Detail Sessions tabs show the live Sessions & timeline panel over a four-session example with every trace element. Session Detail's trace gains its Session Trace heading and actor avatars.",
      "Every tab but Artifact drops the canvas card: left-aligned, at most 1200px, one padding, and Activity opens with an Activity timeline title.",
      "New Composites: Labs/Documents/Document Detail/Toolbar and Labs/Issues/Issue Detail/Toolbar. Patterns/Labs Document and Issue Detail follow their surfaces.",
      "Counts are measured from the story index.",
    ],
  },
  {
    version: "9.0.0",
    date: "2026-10-22",
    summary:
      "This retitle changes the story id, which is exactly the broken-link case that history exists to record.",
    contents: [
      { level: "Primitives", entries: 7, stories: 38 },
      { level: "Composites", entries: 89, stories: 654 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 60, stories: 330 },
    ],
    changes: [
      "Composites v1.0/App Shell/Prototype Scenario Panel moves to Composites/Shared/Prototype Tools/Prototype Scenario Panel. Its links move from composites-v1-0-app-shell-prototype-scenario-panel--* to composites-shared-prototype-tools-prototype-scenario-panel--*.",
      "Prototype Scenario Panel: Deprecated → Experimental.",
      "Counts are from 8.0.0 plus the moved entry and its four stories.",
    ],
  },
  {
    version: "8.0.0",
    date: "2026-10-22",
    summary:
      "The web security-upgrade page is removed with the compute-target feature (ISS-12784), so its Surfaces entry is removed. Its story URLs no longer resolve.",
    contents: [
      { level: "Primitives", entries: 7, stories: 38 },
      { level: "Composites", entries: 88, stories: 650 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 60, stories: 330 },
    ],
    changes: [
      "Removed from Surfaces/Workspace Menu/Settings: Security Upgrade (Default, Loading, Already Protected, Target Not Found, Command Failed: 5 stories).",
      "Counts are from 7.0.2 minus the removed entry.",
    ],
  },
  {
    version: "7.0.2",
    date: "2026-10-22",
    summary:
      "Four entries follow the Storybook rules again (ISS-12911): no V2 in a title, Title Case story names, Inline Name Cell with the other shared list parts, and Activity Brief under the one page that uses it.",
    contents: [
      { level: "Primitives", entries: 7, stories: 38 },
      { level: "Composites", entries: 88, stories: 650 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 61, stories: 335 },
    ],
    changes: [
      "Composites/Shared/Activity/Future (V2 — not for build) is now Future (Not For Build). Its links move from composites-shared-activity-future-v2-not-for-build--* to composites-shared-activity-future-not-for-build--*.",
      "Composites/Artifacts/Sessions/Inline Name Cell moves to Composites/Shared/Artifact List/Inline Name Cell, since every artifact list row uses it. Its links move from composites-artifacts-sessions-inline-name-cell--* to composites-shared-artifact-list-inline-name-cell--*.",
      "Composites/Shared/Activity/Activity Brief moves to Composites/Labs/Issues/Issue Detail/Activity Brief and stays Preview: only the Issue Detail design preview mounts it, so it does not match the live app yet. Its links move from composites-shared-activity-activity-brief--* to composites-labs-issues-issue-detail-activity-brief--*.",
      "Composites/Shared/Artifact Detail/Artifact Tab: seven story names in Title Case, taken from their exports: Canvas Document, Canvas Document Dark, Canvas Document Narrow, Canvas Timeline, Canvas Timeline Dark, Canvas Timeline Narrow and Header Actions. Their ids do not change; Storybook builds an id from the export, not the name.",
      "Counts are measured from the Storybook index before and after this change, and this change does not alter them. Composites reads higher than 7.0.1 recorded because 7.0.1's count had fallen behind main.",
    ],
  },
  {
    version: "7.0.1",
    date: "2026-10-22",
    summary:
      "The Issue page follows Ottilie and Nerys's 21 Oct review (ISS-12576): a toolbar at the top of the issue canvas, the issue's text, Sub-issues, Branch and Activity summary under their own headings, a minimal Branch card, and the two kinds of issue comment.",
    contents: [
      { level: "Primitives", entries: 7, stories: 38 },
      { level: "Composites", entries: 86, stories: 637 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 61, stories: 335 },
    ],
    changes: [
      "Surfaces/Labs/Issues/Issue Detail: the issue's slug, key fields and Add comment move from the page header and the row under the tabs into a toolbar (the document editor's toolbar row) that stays at the top of the Artifact tab's canvas. It is not on Sessions, Details or Activity. The canvas then shows the issue's text, Sub-issues, Branch and Activity summary, each under its own heading; Sessions, Documents and External links leave the canvas.",
      "Issue comments come in two kinds: on a passage of the body, which the body highlights, and on the issue as a whole. New page stories Text Comment, Issue Comment and Both Comment Types, and a Future Other Links story with prototype and Storybook addresses as plain text. `PrDescriptionMarkdown` gains an opt-in `highlights`.",
      "Composites/Labs/Issues/Issue Detail/Linked Work Card shows only merge status, pull request, test checks and lines changed; the description and Storybook preview say Data pending (ISS-12580). New Data Sources story labels every field with its source. Issue Card drops its sub-issues (No Sub Issues becomes With Text Comment).",
      "`LinkedArtifactGroupsTable` gains an opt-in `hideHeading` on a group, for a group inside a section that already titles it.",
      "Counts are measured from the Storybook index, which 7.0.0's had fallen behind; this release adds Data Sources and the four new Issue Detail stories.",
    ],
  },
  {
    version: "7.0.0",
    date: "2026-10-21",
    summary:
      "Artifact Board uses toast-only Undo; its unreachable banner Undo story is removed (ISS-12907).",
    contents: [
      { level: "Primitives", entries: 7, stories: 38 },
      { level: "Composites", entries: 84, stories: 634 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 61, stories: 328 },
    ],
    changes: [
      "Composites/Shared/Artifact List/Artifact Board loses Undo Available, which no production surface can emit; the placement toast retains Undo.",
      "Counts are from 6.0.0 minus the retired Artifact Board story.",
    ],
  },
  {
    version: "6.0.0",
    date: "2026-10-21",
    summary:
      "Responsive Gridview uses the canonical one-column narrow list instead of stacked cards (PRD-727 / ISS-12683), preserving shared grouping, hierarchy, focus and selection behavior.",
    contents: [
      { level: "Primitives", entries: 7, stories: 38 },
      { level: "Composites", entries: 84, stories: 635 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 61, stories: 328 },
    ],
    changes: [
      "Composites/Shared/Artifact List/Grid Table Grouped Sections gains Narrow Default, Grouped, Nested Groups And Empty Group, Nested Rows, Selected, Nested Control, Grouped Selectable, Selectable Tree and Dark (9 stories), while the current-release card-list entry is retired.",
      "Composites/Shared/Artifact List/Grid Table List Surface keeps its title and story ids; its measured compact, expanded, focus-handoff and compact selection-rail stories now exercise the narrow grid without horizontal scrolling.",
      "The frozen Composites v1.0 card examples retain their story ids through story-local compatibility fixtures; no retired card-list product API remains.",
      "The current card-list title is retired into the existing Grid Table Grouped Sections entry; Sessions List and Branches List each add a Narrow story.",
      "Documents List, Projects List and Project Detail each add a Narrow story for the production flag-on state.",
      "Counts are from the merged-tree Storybook index after 5.0.0.",
    ],
  },
  {
    version: "5.0.0",
    date: "2026-10-21",
    summary:
      "Puts back the Storybook rules the PRD-706 program releases broke (ISS-12914). A major release: the 11 states ISS-12642 added to two frozen v1.0 entries move to new current entries, so their v1.0 story URLs stop working.",
    contents: [
      { level: "Primitives", entries: 7, stories: 38 },
      { level: "Composites", entries: 85, stories: 635 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 61, stories: 323 },
    ],
    changes: [
      "New in Composites, tagged Stable: Shared/Artifact List/Inline Scalar Cell (13 stories) and Inline Select Cell (7 stories), copies of the v1.0 entries that carry ISS-12642's states.",
      "Composites v1.0/Data Display/Inline Scalar Cell loses Empty, Write Rejects, Retained Save Failure, Date Write Rejects, Retained Date Save Failure, Read Only, Narrow and Dark, and Inline Select Cell loses Empty, Read Only and Dark: both are back to how they were before ISS-12642.",
      "Composites/Shared/Artifact List/Documents View: Narrow is back, and Editing's priority pick now lands on the row, which its play function checks.",
      "Primitives/Data Display/Grid Interaction Contract renders its rows through Grid Table V2 with the canonical table cells and Inline Name Cell: Editing renames the row and Dragging starts a real drag. Preview → Stable, and Grid Row Drag Handle: Preview → Stable.",
      "Recorded here because ISS-12642 shipped no release: Primitives/Feedback & Status/Inline Edit Feedback (Default, Described Field, Truncated, Aligned End, Dark: 5 stories, Stable, already in 4.0.0's counts); Composites/Artifacts/Sessions/Inline Name Cell gained Dark, Editor Open, Escape Cancels, Keyboard Focus, Long Name In A Narrow Column and Refused Rename Retains Draft; Session Inline Rename's Refused Rename Rolls Back became Refused Rename Retains Draft.",
      "Corrections: ISS-12673's release was recorded as a second 4.0.1 and is now 4.1.0, and 4.0.2's Composites count is 586, not 585.",
      "Counts are from `storybook index` on this branch, on main at 4.1.0: Composites adds two entries and 21 stories. The other levels are unchanged.",
    ],
  },
  {
    version: "4.1.0",
    date: "2026-10-21",
    summary:
      "The shared pointer, cursor and hover contract reaches flagged grid consumers, including Project Detail's ungrouped Documents view (PRD-723).",
    contents: [
      { level: "Primitives", entries: 7, stories: 38 },
      { level: "Composites", entries: 83, stories: 614 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 61, stories: 323 },
    ],
    changes: [
      "New in Primitives/Data Display, tagged Preview: Grid Interaction Contract (Default, Loading, Error, Hover, Focus Visible, Selected, Editing, Dragging, Drag Over, Disabled, Dark and Narrow: 12 stories) and Grid Row Drag Handle (Default and Disabled: 2 stories).",
      "Composites/Shared/Artifact List/Grid Table List Surface adds Composed Grid, Canonical Artifact List Contract and Native Drag, each tagged Preview. Existing stories retain main's Add Tag and Remove Tag actions.",
      "Composites/Shared/Artifact List/Documents View adds Stack Rank GridView Adoption, tagged Preview while the shared gridview-adoption flag defaults off; existing stories remain Stable.",
      "Shipped as a second 4.0.1 with no version bump; renumbered in 5.0.0. A minor release, for its two new Primitives entries.",
      "Counts are from `storybook index` on main at this release, after 4.0.3: Primitives adds two entries and 14 stories; Composites adds four stories to existing entries. Patterns and Surfaces are unchanged.",
    ],
  },
  {
    version: "4.0.3",
    date: "2026-10-21",
    summary:
      "Artifact Board and Board Card (PRD-724): the shared Artifact Board and the Project Detail board gain their compositions, interaction states, responsive coverage and production adapter. Frozen v1.0 entries are unchanged.",
    contents: [
      { level: "Primitives", entries: 6, stories: 37 },
      { level: "Composites", entries: 83, stories: 612 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 61, stories: 323 },
    ],
    changes: [
      "New in Composites, tagged Stable: Shared/Artifact List/Artifact Board (Default, Empty Lane, Hover Disclosure, Focus Visible, Editing Title, Grouped Fields Omitted, Multiple Roots Selected, Multiple Roots Dragging, Drag Over Card Edge, Hidden Descendants, Partial Lane, Move Disabled, Move Pending, Move Error, Undo Available, Light, Dark, Narrow, Wide Overflow, Large Virtualized, Lane Policy Denied: 21 stories).",
      "New in Composites, tagged Stable: Your Teams/Project Detail/Project Artifact Board (Default, Read Only Status: 2 stories).",
      "New in Surfaces/Your Teams/Project Detail: Board View (1 story), using the live route and production adapter.",
      "The frozen Generic Artifact Surface, Project List and Kanban Board v1.0 entries are unchanged.",
      "Counts are taken from storybook index on this branch merged with main at 4.0.2.",
    ],
  },
  {
    version: "4.0.2",
    date: "2026-10-21",
    summary:
      "Project Detail and Documents placement share a compact drag preview chip with a grip and title (PRD-726, F-19).",
    contents: [
      { level: "Primitives", entries: 5, stories: 24 },
      { level: "Composites", entries: 81, stories: 586 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 61, stories: 322 },
    ],
    changes: [
      "Primitives/Data Display/Drag Preview Chip shows the generic grip-and-title preview reused by Documents and Project Detail.",
      "Composites/Shared/Artifact List/Documents View adds Four Level Hierarchy and loses Narrow (restored in 5.0.0); Composites/Your Teams/Project Detail/Project Artifact List adds Manual Ordering.",
      "Counts are 4.0.1 plus this release's stories. They were recorded with Composites at 585 and corrected to 586 in 5.0.0.",
    ],
  },
  PRD725_RELEASE,
  {
    version: "4.0.0",
    date: "2026-10-21",
    summary:
      "The compute-target popover and target sharing are removed from the product (ISS-12617), so their v1.0 stories go too. A major release because a story is removed (TAXONOMY.md, Semver); the current roots are unchanged.",
    contents: [
      { level: "Primitives", entries: 4, stories: 23 },
      { level: "Composites", entries: 81, stories: 564 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 61, stories: 321 },
    ],
    changes: [
      "Composites v1.0/App Shell/Shell Sidebar loses With Footer, whose only content was the static Compute: Local row.",
      "Composites v1.0/Compute/Compute Target Card and Compute Target Row no longer show the Share with team switch; Compute Target Row's Shared By Another Owner story stays until ISS-12450.",
      "Counts are taken against main at 3.4.7; no current-root entry or story changed.",
    ],
  },
  {
    version: "3.4.7",
    date: "2026-10-21",
    summary:
      'The Issue page tells an issue\'s own history (Triage to Done, no document versions), so its Activity brief and Activity tab no longer show "created this issue · Draft" or "edited the document". Its Sub-issues table drops the empty Relationship column (ISS-12576).',
    contents: [
      { level: "Primitives", entries: 4, stories: 23 },
      { level: "Composites", entries: 81, stories: 564 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 61, stories: 321 },
    ],
    changes: [
      "New example history `ISSUE_EXAMPLE_ROWS` in the Activity catalog, beside the Document, Session and Branch examples. Surfaces/Labs/Issues/Issue Detail and its Activity tab story read it in place of the Document example.",
      "`LinkedArtifactGroupsTable` gains an opt-in `hideRelationship` on a group, which draws it without the Relationship column. Only the issue card's Sub-issues sets it; every other group keeps the column, even one whose rows all state none, so groups keep lining up.",
      "Story counts are unchanged from 3.4.6.",
    ],
  },
  {
    version: "3.4.6",
    date: "2026-10-21",
    summary:
      "The Issue page's Activity brief is a bordered group, like the linked work card above it, and shows the first two and last two events with everything between folded into one row that opens the Activity tab (Nerys, ISS-12576). Comments fold with the events: they live in the comments rail.",
    contents: [
      { level: "Primitives", entries: 4, stories: 23 },
      { level: "Composites", entries: 81, stories: 564 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 61, stories: 321 },
    ],
    changes: [
      "Composites/Shared/Activity/Activity Brief: one fold between the two ends instead of one per run of events between comments. Default and Session now show a single fold. No Comments is removed: it showed nothing Default does not.",
      "Counts are from `storybook index` on this branch merged with main at 3.4.5: Composites is one story fewer than 3.4.5. The other levels are unchanged.",
    ],
  },
  {
    version: "3.4.5",
    date: "2026-10-21",
    summary:
      "The Branches List adds a preview-adapter and interaction state matrix for PRD-729.",
    contents: [
      { level: "Primitives", entries: 4, stories: 23 },
      { level: "Composites", entries: 81, stories: 565 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 61, stories: 321 },
    ],
    changes: [
      "Surfaces/Artifacts/Branches/Branches List adds 11 stories for keyboard focus, dark mode, tag permissions, preview-adapter metric states, narrow and overflow layouts, and disabled PR actions.",
      "Counts are taken against main at 3.4.4.",
    ],
  },
  {
    version: "3.4.4",
    date: "2026-10-21",
    summary:
      'The full Issue Detail page design (ISS-12576, DI-07): the issue card replaces the last stand-in, so the Artifact tab is the issue ("Sub-issue of …" above the title, its body, its sub-issues below), then its linked work and its Activity brief, under the status strip. Add comment, beside the comments toggle, comments on the selected body text in the rail. Design-only, in Labs.',
    contents: [
      { level: "Primitives", entries: 4, stories: 23 },
      { level: "Composites", entries: 81, stories: 565 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 61, stories: 310 },
    ],
    changes: [
      "New in Composites, tagged Preview: Labs/Issues/Issue Detail/Issue Card (Default, No Sub Issues, Sub Issue, Imported From GitHub, Imported From Linear, Dark: 6 stories). It reuses the pull request description renderer for the body, the comments rail's sync indicator for imported issues and the linked artifacts table for sub-issues.",
      "Surfaces/Labs/Issues/Issue Detail gains a story per DI-07 state: New, In Progress No Branch, One Branch, Several Branches, Closed Not Merged, Sub Issue, Imported From GitHub, Imported From Linear (8 stories). The dashed stand-in frames are gone.",
      "No edited marker and no version dropdown on an issue: its history, body edits included, is on the Activity tab (ISS-12570 Q2, Q7). Breadcrumbs stay in the app header (Q8).",
      "Composites/Labs/Issues/Issue Detail/Status Strip now leads with the issue's slug and drops project › milestone and the tags, which are on the Details tab (Nerys, 2026-10-21). `DocumentMetadataBar` gains an opt-in `leading` slot and `showTags`; the document pages keep their bar as it was.",
      "Counts are from `storybook index` on this branch at 3.4.3: Composites is one entry and 6 stories more, Surfaces 8 stories more. The other levels are unchanged.",
    ],
  },
  {
    version: "3.4.3",
    date: "2026-10-21",
    summary:
      "The policy view can list the sessions shared as one-off exceptions, each with its audience and upload state, and mark one that lives in an excluded directory (ISS-12535). It is design-only and Experimental; Settings does not show it yet.",
    contents: [
      { level: "Primitives", entries: 4, stories: 23 },
      { level: "Composites", entries: 80, stories: 559 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 61, stories: 302 },
    ],
    changes: [
      "New in Composites, tagged Experimental: Shared/Data Sync/Session Share Exception List (Default, Empty, Default Dark, Exclusion Wins, Exclusion Wins Dark, All Upload States, Retrying, Long Names, In Policy View, In Policy View Dark: 10 stories). Its labels are placeholders until the copy is supplied.",
      "Whether an exception or a directory exclusion wins is open on PRD-796. `precedence` is a required prop with no default, so every host must choose; the stories pass the prototype's decision on ISS-12535, exception wins, and Exclusion Wins shows the other answer with one prop flipped.",
      "Counts are from `storybook index` on this branch merged with main at 3.4.2: Composites is one entry and 10 stories more than 3.4.2. The other levels are unchanged.",
    ],
  },
  {
    version: "3.4.2",
    date: "2026-10-21",
    summary:
      "A desktop device's data policy as web shows it, read-only: its level, directory count, machine and scope, or that it has reported none (ISS-12531). Design-only and Experimental: no API reports another device's policy yet.",
    contents: [
      { level: "Primitives", entries: 4, stories: 23 },
      { level: "Composites", entries: 79, stories: 549 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 61, stories: 302 },
    ],
    changes: [
      "New in Composites, tagged Experimental: Shared/Data Sync/Device Data Policy (Reported, Reported Dark, Level Only, Unreported, Unreported Dark, All Levels, Several Devices: 7 stories). It composes the policy status indicator, the policy summary and the directory scope list, and offers no edit. Its new labels are placeholders until the copy is supplied.",
      "Directory Scope List can be read-only: every row locked, each top-level row saying why (Read Only, Read Only Dark: 2 stories).",
      "Counts are from `storybook index` on this branch merged with main at 3.4.1: Composites is one entry and 9 stories more than 3.4.1. The other levels are unchanged.",
    ],
  },
  {
    version: "3.4.1",
    date: "2026-10-20",
    summary:
      "Selected Sessions and Branches can remove a tag through the shared bulk picker (ISS-10686), including no-op success when the tag was not present. v1.0 is unchanged.",
    contents: [
      { level: "Primitives", entries: 4, stories: 23 },
      { level: "Composites", entries: 78, stories: 540 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 61, stories: 302 },
    ],
    changes: [
      "Composites/Shared/Artifact List/Bulk Tag Picker gains Remove Tag; its existing nine stories and placement are unchanged. The shared Selection Rail and Compact Selection Rail stories now show Add Tag and Remove Tag together. Surfaces/Artifacts/Sessions/Sessions List and Surfaces/Artifacts/Branches/Branches List each gain Remove Tag, Remove Tag Not Present and Remove Tag Partial Failure; Rows Selected now shows both tag actions.",
      "Counts are taken against main at 3.4.0.",
    ],
  },
  {
    version: "3.4.0",
    date: "2026-10-20",
    summary:
      "The filtering and sorting model gets a current Stable entry under Composites/Shared/Artifact List while the deprecated v1.0 toolbar story keeps its prior behavior (PRD-721).",
    contents: [
      { level: "Primitives", entries: 4, stories: 23 },
      { level: "Composites", entries: 78, stories: 539 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 61, stories: 296 },
    ],
    changes: [
      "New in Composites, tagged Stable: Shared/Artifact List/Filtering and Sorting Model (Default, Active Filters, Sorting, Composed Toolbar, Range Escape Recovery, Dark, Narrow: 7 stories).",
      "The current entry composes the production shared toolbar and canonical table cells from its own fixture modules; the deprecated Grid Table Toolbar entry keeps its prior fixtures, values, sorting, saved views, metrics, and rendered output.",
      "Counts are taken against 3.3.0, from storybook index.",
    ],
  },
  {
    version: "3.3.0",
    date: "2026-10-20",
    summary:
      "Grid selection reconciliation now covers the consumed Sessions List and Artifact List shell, drops rows hidden by a collapsed group band or a collapsed parent row, and prevents stale pending actions from restoring an earlier page's selection (PRD-718).",
    contents: [
      { level: "Primitives", entries: 4, stories: 23 },
      { level: "Composites", entries: 77, stories: 532 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 61, stories: 296 },
    ],
    changes: [
      "New in Composites, tagged Stable: Shared/Artifact List/Artifact List Shell (Default and Selection Reconciliation, with autodocs).",
      "Surfaces/Artifacts/Sessions/Sessions List gains Group Collapse Reconciles Selection and Pending Favorite After Page Change.",
      "Shared/Artifact List/Grid Table Card List updates Grouped Selectable Cards so closing a group prunes its hidden selection; Selectable Tree Cards now drops a selected child when its parent collapses, and reopening the parent does not restore it.",
      "Shared/Artifact List/Grid Table Grouped Sections gains Collapse Reconciles Selection.",
      "Counts are read from the story index after merging main at 3.2.9.",
    ],
  },
  {
    version: "3.2.9",
    date: "2026-10-20",
    summary:
      "The timeline header's peak-column fact, shared by the Session Timeline and the Branch PR timeline (ISS-12665).",
    contents: [
      { level: "Primitives", entries: 3, stories: 18 },
      { level: "Composites", entries: 76, stories: 523 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 61, stories: 294 },
    ],
    changes: [
      "New in Composites, tagged Stable: Artifacts/Timeline Peak Bucket Fact (Default, Unavailable, Without Explanation: 3 stories).",
      "Counts are taken against 3.2.8.",
    ],
  },
  {
    version: "3.2.8",
    date: "2026-10-20",
    summary:
      "The data-sync policy summary can also show how many directories are in scope and the machine or organization it applies to (ISS-12525). The new rows are design-only and Experimental; Settings still shows the level alone.",
    contents: [
      { level: "Primitives", entries: 3, stories: 18 },
      { level: "Composites", entries: 75, stories: 520 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 61, stories: 294 },
    ],
    changes: [
      "New in Composites, tagged Experimental: Shared/Data Sync/Data Sync Policy Summary (Default, Default Dark, Unset, Unset Dark, Level Only, Redacted, Metadata Only, Off, No Directories, One Directory, Many Directories, Machine Only, Organization Only: 13 stories). Its new labels are placeholders until the copy is supplied.",
      "While no level is saved the summary shows the unset message alone, without the new rows, as ISS-12523 does; whether they show before a choice is saved is an open owner question on ISS-12525.",
      "Counts are from `storybook index` on this branch merged with 3.2.7. Composites is six entries and 62 stories more than 3.2.7 lists: this entry's one entry and 13 stories, plus five entries and 49 stories that ISS-12644 (#8980) added without a version entry (Labs/Agents/Agent Detail/Agent Invocations Grid, and Your Teams' Project Artifact List, Project Artifact Summary, Sidebar Teams and Team Modal). The other levels are unchanged.",
    ],
  },
  {
    version: "3.2.7",
    date: "2026-10-20",
    summary:
      "The download step gains an email capture for a platform with no published installer, Windows today, with a Composites entry under Onboarding (ISS-12364). It is Experimental: design-only, with no waitlist endpoint behind it yet.",
    contents: [
      { level: "Primitives", entries: 3, stories: 18 },
      { level: "Composites", entries: 69, stories: 458 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 61, stories: 294 },
    ],
    changes: [
      "New in Composites, tagged Experimental: Onboarding/Desktop Availability Notify Form (Initial, Prefilled, Invalid Email, Submitting, Success, Submission Error, In Download Step: 7 stories). The call to action is the ticket's suggested message; every other slot is a placeholder.",
      "In Download Step shows it in the Web download step for a Windows reader, between the existing installer-gap alert and Continue without installing.",
      "Counts are from `storybook index` on this branch merged with 3.2.6: Composites is one entry and seven stories more than 3.2.6 held. The other levels are unchanged.",
    ],
  },
  {
    version: "3.2.6",
    date: "2026-10-20",
    summary:
      "The Agents list's metric strip takes the same one-rank band as Sessions and Branches, so at phone width its cards scroll sideways instead of stacking above the rows (ISS-9282).",
    contents: [
      { level: "Primitives", entries: 3, stories: 18 },
      { level: "Composites", entries: 68, stories: 451 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 61, stories: 294 },
    ],
    changes: [
      "Surfaces/Labs/Agents/Agents List: new Metrics Pinned Narrow story, the Metrics Pinned state at 390px. The strip is one rank in every story; below 768px it no longer pairs the cards two-up.",
      "Counts are from `storybook index` on this branch merged with 3.2.5. Surfaces is one story more than 3.2.5 held. Composites is 68 entries and 451 stories, not the 67 and 446 the 3.2.5 entry lists.",
    ],
  },
  {
    version: "3.2.5",
    date: "2026-10-20",
    summary:
      "The Dashboard says when its date range hides sessions that exist, with the Sessions list's date-range empty and Show all time (ISS-11927).",
    contents: [
      { level: "Primitives", entries: 3, stories: 18 },
      { level: "Composites", entries: 67, stories: 446 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 61, stories: 293 },
    ],
    changes: [
      "Surfaces/Dashboard: new No Matches story, after Empty. Every session predates the selected range, so the body is the Sessions list's date-range empty; its play function presses Show all time and checks the rows come back.",
      "Counts are taken against 3.2.4, from storybook index. The index held 61 Surfaces entries and 292 stories at 3.2.4, not the 63 and 298 that the 3.2.3 and 3.2.4 entries list.",
    ],
  },
  {
    version: "3.2.4",
    date: "2026-10-20",
    summary:
      "The issue page's status strip: status, owner, priority, tags, project › milestone and due date directly below the tabs, on every tab (ISS-12578). It is Preview, like the rest of the Documents and Issues work.",
    contents: [
      { level: "Primitives", entries: 3, stories: 18 },
      { level: "Composites", entries: 67, stories: 446 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 63, stories: 298 },
    ],
    changes: [
      "New in Composites, tagged Preview: Labs/Issues/Issue Detail/Status Strip (Default, Empty, In Progress, Dark: 4 stories). It is the shipped document metadata bar without the type badge, plus project › milestone and due date.",
      "Surfaces/Labs/Issues/Issue Detail: the strip sits under the tab bar on every tab and stays in view while the panel scrolls; the Metadata header stand-in is gone from the Artifact tab. The page stories turn the artifact tags flag on.",
      "Counts are taken against 3.2.3.",
    ],
  },
  {
    version: "3.2.3",
    date: "2026-10-20",
    summary:
      "The Details tab gives a Document and an Issue a read-only Repositories row with their artifact fields, as PRD-799 lists it (ISS-12572).",
    contents: [
      { level: "Primitives", entries: 3, stories: 18 },
      { level: "Composites", entries: 66, stories: 442 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 63, stories: 298 },
    ],
    changes: [
      "Composites/Shared/Artifact Detail/Details Tab: the Document and Issue stories show Repositories, read-only, at the end of Artifact details. The Document story's play function checks for it.",
      "Surfaces/Labs/Documents/Document Detail and Surfaces/Labs/Issues/Issue Detail show the same row on their Details tab.",
      "No entries or stories added or removed. Counts are taken against 3.2.2.",
    ],
  },
  {
    version: "3.2.2",
    date: "2026-10-20",
    summary:
      "The issue page's linked work card: each branch's state read from its pull request, its checks, changes and latest update, then every other related link (ISS-12580). It is Preview, like the rest of the Documents and Issues work.",
    contents: [
      { level: "Primitives", entries: 3, stories: 18 },
      { level: "Composites", entries: 66, stories: 442 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 63, stories: 298 },
    ],
    changes: [
      "New in Composites, tagged Preview: Labs/Issues/Issue Detail/Linked Work Card (Default, In Progress, Merged, Closed Without Merge, Unconfirmed, Multiple Branches, No Branch Yet, Dark: 8 stories).",
      "Surfaces/Labs/Issues/Issue Detail: the Artifact tab's Branch preview stand-in is now the Linked work card, above the Activity brief.",
      "Counts are taken against 3.2.1.",
    ],
  },
  {
    version: "3.2.1",
    date: "2026-10-20",
    summary:
      "The issue page's Activity brief: the first events, folds that open the Activity tab, comments kept out of every fold, and the last events, with a Composites entry under Shared/Activity (ISS-12579). It is Preview, like the rest of the Documents and Issues work.",
    contents: [
      { level: "Primitives", entries: 3, stories: 18 },
      { level: "Composites", entries: 65, stories: 434 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 63, stories: 298 },
    ],
    changes: [
      'New in Composites, tagged Preview: Shared/Activity/Activity Brief (Default, No Comments, Session, Few Events, Dark: 5 stories, with autodocs). Each run of middle events folds into one row, "Show N events: changed …", that opens the Activity tab; a comment in the middle splits the fold.',
      "Surfaces/Labs/Issues/Issue Detail: the Artifact tab's Activity brief region now uses it and sits below the Branch preview card, the order ruled on ISS-12570.",
      "Counts are taken against main at 3.2.0.",
    ],
  },
  {
    version: "3.2.0",
    date: "2026-10-19",
    summary:
      "Adding a tag to several selected Sessions or Branches (ISS-12305): the list band layout, card list and Add Tag picker the lists share get entries under Shared/Artifact List, the Sessions list's Tags cell gets its own entry, and the Sessions and Branches List pages gain their selection and Add Tag stories. v1.0 is unchanged.",
    contents: [
      { level: "Primitives", entries: 3, stories: 18 },
      { level: "Composites", entries: 63, stories: 425 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 63, stories: 298 },
    ],
    changes: [
      "New in Composites, tagged Stable: Shared/Artifact List/Grid Table List Surface, a copy of Primitives v1.0/Data Display/Tables/Grid Table List Surface with Selection Rail and Compact Selection Rail added (11 stories).",
      "New in Composites, tagged Stable: Shared/Artifact List/Grid Table Card List, a copy of Composites v1.0/Data Display/Tables/Grid Table V2 Card List with Selectable Cards, Selected Cards, Nested Control Cards, Grouped Selectable Cards and Selectable Tree Cards added (9 stories).",
      "New in Composites, tagged Stable: Shared/Artifact List/Bulk Tag Picker (Default, Loading, Empty, Pending, Partial Failure, Catalog Error, Overflowing Catalog, Rail, Open: 9 stories).",
      "New in Composites, tagged Stable: Artifacts/Sessions/Sessions List/Session Tags Cell (Default, Empty, Unavailable, Read Only: 4 stories).",
      "Surfaces/Artifacts/Sessions/Sessions List and Surfaces/Artifacts/Branches/Branches List each gain Add Tag Partial Failure, Rows Selected and Add Tag.",
      "Patterns/Artifacts/Branches/Branches List gains a Selection rail region.",
      "Counts are taken against main at 3.1.1.",
    ],
  },
  {
    version: "3.1.1",
    date: "2026-10-19",
    summary:
      "Onboarding gains a directory step, built on the Data Sync directory scope list and its add control, with a Composites entry under Onboarding (ISS-12524). It is Experimental: design-only, not yet a phase of the guided-onboarding dialog.",
    contents: [
      { level: "Primitives", entries: 3, stories: 18 },
      { level: "Composites", entries: 59, stories: 392 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 63, stories: 292 },
    ],
    changes: [
      "New in Composites, tagged Experimental: Onboarding/Guided Onboarding Directory Step (Default, Newly Added, Zero Selected, Nothing Discovered, Web, Default Dark: 6 stories). The add control shows ISS-12521's approved copy; every other slot is a placeholder.",
      "Composites/Shared/Data Sync/Directory Scope List and Directory Scope List With Add are unchanged: the step composes them.",
      "Counts are taken against main at 3.1.0.",
    ],
  },
  {
    version: "3.1.0",
    date: "2026-10-16",
    summary:
      "The grouped list sections work adds Documents View and Grid Table Grouped Sections under Composites/Shared/Artifact List and Sortable Subtree under Primitives/Data Display, all Stable (ISS-12462).",
    contents: [
      { level: "Primitives", entries: 3, stories: 18 },
      { level: "Composites", entries: 59, stories: 386 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 63, stories: 292 },
    ],
    changes: [
      "New in Composites, tagged Stable: Shared/Artifact List/Documents View (Default, Loading, Empty, Closed Band, Windowed Population, Unknown Population, Flat Category, Ungrouped Tree, Closed Tree, Flat, Stack Rank: 11 stories, with autodocs). Its Windowed Population and Unknown Population stories page one fixture population with the production section-aware plan.",
      "New in Composites, tagged Stable: Shared/Artifact List/Grid Table Grouped Sections (Default, Closed Band, Root Only Descendants, Windowed Population, Unknown Population, Grouped Narrow: 6 stories).",
      "New in Primitives, tagged Stable: Data Display/Sortable Subtree (Default, Root Only, Hover, Focus, Dragging, Keyboard Cancel, Keyboard Reorder, Realistic Use: 8 stories, with autodocs).",
      "Counts are taken against main at 3.0.13.",
    ],
  },
  {
    version: "3.0.13",
    date: "2026-10-16",
    summary:
      "The directory scope list gains an add-a-directory control for desktop, with a Composites entry under Shared/Data Sync (ISS-12521). It is Experimental: design-only, with no live counterpart yet.",
    contents: [
      { level: "Primitives", entries: 2, stories: 10 },
      { level: "Composites", entries: 56, stories: 369 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 63, stories: 292 },
    ],
    changes: [
      "New in Composites, tagged Experimental: Shared/Data Sync/Directory Scope List With Add (Default, Empty, Picking, Added, Duplicate, Unreadable, Protected, Cancelled, Web, and four Dark: 13 stories). The fixtures carry the approved ISS-12521 copy; only the ISS-12520 list slots are still glyphs.",
      "Composites/Shared/Data Sync/Directory Scope List is unchanged: the add control composes it.",
      "Counts are taken against main at 3.0.12.",
    ],
  },
  {
    version: "3.0.12",
    date: "2026-10-16",
    summary:
      "The upload queue view gets a Composites entry under Shared/Data Controls: queued, in flight and failed with their counts, and an empty state (ISS-12529). It reuses the shared upload state tones and sits beside the uploads pause control. Experimental: design-only, with no live counterpart yet.",
    contents: [
      { level: "Primitives", entries: 2, stories: 10 },
      { level: "Composites", entries: 55, stories: 356 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 63, stories: 292 },
    ],
    changes: [
      "New in Composites, tagged Experimental: Shared/Data Controls/Upload Queue View (Default, Empty, Empty Dark, Failed Only, Unmeasured, Large Backlog, In Data Settings, Default Dark, Failed Only Dark: 9 stories). Its story fixtures use placeholder copy; the wording needs an owner source on the ticket.",
      "Counts are taken against main at 3.0.9; 3.0.10 belongs to another open change.",
    ],
  },
  {
    version: "3.0.11",
    date: "2026-10-16",
    summary:
      "The deletion entry point gets a Composites entry under Shared/Data Controls (ISS-12539). It opens the shared delete dialog with its deletion scope review, and Session Detail gains a title-row slot to place it. Experimental: design-only, with no live counterpart yet.",
    contents: [
      { level: "Primitives", entries: 2, stories: 10 },
      { level: "Composites", entries: 54, stories: 347 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 63, stories: 292 },
    ],
    changes: [
      "New in Composites, tagged Experimental: Shared/Data Controls/Deletion Entry Point (Default, Opens Scope Review, In Session Detail, In Settings, In Session Detail Dark, In Settings Dark, In Settings Narrow: 7 stories). Its story fixtures use placeholder copy and fictional sessions and directories.",
    ],
  },
  {
    version: "3.0.10",
    date: "2026-10-16",
    summary:
      "The Settings scope editor gets a Composites entry under Shared/Data Controls (ISS-12527). It composes the directory scope list, the sync-level picker and the policy status indicator, and adds an explicit draft that is saved or discarded. Experimental: design-only, with no live counterpart yet.",
    contents: [
      { level: "Primitives", entries: 2, stories: 10 },
      { level: "Composites", entries: 53, stories: 340 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 63, stories: 292 },
    ],
    changes: [
      "New in Composites, tagged Experimental: Shared/Data Controls/Data Controls Scope Editor (Default, Unavailable, Unsaved Changes, Saving, Save Pending, Save Failed, Leave With Unsaved Changes, In Settings, Default Dark, Unsaved Changes Dark, Save Failed Dark: 11 stories). Its story fixtures use placeholder copy; the proposed wording lives on the ticket for owner review.",
      "Policy Status Indicator now exports its props type so the editor can pass a host's status straight through; the indicator itself is unchanged.",
    ],
  },
  {
    version: "3.0.9",
    date: "2026-10-16",
    summary:
      "Pause and resume uploads gets a Composites entry under Shared/Data Controls, with its own paused badge (ISS-12528). Paused is kept apart from the policy status indicator's states, so the indicator is unchanged. Experimental: design-only, with no live counterpart yet.",
    contents: [
      { level: "Primitives", entries: 2, stories: 10 },
      { level: "Composites", entries: 52, stories: 329 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 63, stories: 292 },
    ],
    changes: [
      "New in Composites, tagged Experimental: Shared/Data Controls/Uploads Pause Control (Default, Paused, Paused Finishing Upload, In Data Settings, Default Dark, Paused Dark, Paused Finishing Upload Dark: 7 stories). Its story fixtures use placeholder copy; the proposed wording lives on the ticket for owner review.",
    ],
  },
  {
    version: "3.0.8",
    date: "2026-10-16",
    summary:
      "The deletion request tracker gets a Composites entry under Shared/Data Controls, on the shared status badge (ISS-12538). It is Experimental: design-only, with no live counterpart yet.",
    contents: [
      { level: "Primitives", entries: 2, stories: 10 },
      { level: "Composites", entries: 51, stories: 322 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 63, stories: 292 },
    ],
    changes: [
      "New in Composites, tagged Experimental: Shared/Data Controls/Deletion Request Tracker (Pending, Unavailable, Unavailable Dark, Completed Verified, Failed, Failed Retrying, Unverified Completion Stays Pending, Pending Dark, Completed Verified Dark, Failed Dark: 10 stories). Completed renders only from a verified backend signal. Its story fixtures use placeholder copy; the proposed wording lives on the ticket for owner review.",
    ],
  },
  {
    version: "3.0.7",
    date: "2026-10-16",
    summary:
      "The per-session upload state (local only, uploading, shared, failed with retry) gets a Composites entry under Artifacts/Sessions, on the existing session sync status badge (ISS-12532). It is Experimental: design-only, with no live counterpart yet.",
    contents: [
      { level: "Primitives", entries: 2, stories: 10 },
      { level: "Composites", entries: 50, stories: 312 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 63, stories: 292 },
    ],
    changes: [
      "New in Composites, tagged Experimental: Artifacts/Sessions/Session Upload State Badge (Default, Uploading, Shared, Failed, Failed Retrying, All States, Default Dark, Uploading Dark, Failed Dark: 9 stories). Its stories reuse only the approved Retry label; the four state labels are placeholders awaiting an owner source on the ticket, since the shipped sync labels promise something else.",
    ],
  },
  {
    version: "3.0.6",
    date: "2026-10-16",
    summary:
      "The shared delete confirmation dialog gains a deletion scope review, with a Composites entry under the new Shared/Data Controls group (ISS-12537). It is Experimental: design-only, with no live counterpart yet.",
    contents: [
      { level: "Primitives", entries: 2, stories: 10 },
      { level: "Composites", entries: 49, stories: 303 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 63, stories: 292 },
    ],
    changes: [
      "New in Composites, tagged Experimental: Shared/Data Controls/Deletion Scope Review (Default, Empty, Narrowed, Deleting, Long List, Dark, Narrow: 7 stories). Its story fixtures use placeholder copy for the list, effect statements and dialog text; the proposed wording lives on the ticket for owner review.",
      "Primitives v1.0/Overlays/Delete Confirmation Dialog is unchanged: the scope review is opt-in.",
    ],
  },
  {
    version: "3.0.5",
    date: "2026-10-16",
    summary:
      "The data-sync policy status indicator gets a Composites entry under the new Shared/Data Controls group, on the shared status badge (ISS-12526). It is Experimental: design-only, with no live counterpart yet.",
    contents: [
      { level: "Primitives", entries: 2, stories: 10 },
      { level: "Composites", entries: 48, stories: 296 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 63, stories: 292 },
    ],
    changes: [
      "New in Composites, tagged Experimental: Shared/Data Controls/Policy Status Indicator (Default, Unavailable, Unavailable Dark, Pending, Failed, With Detail, In Settings Row, Default Dark, Pending Dark, Failed Dark: 10 stories). Its story fixtures use placeholder copy; the proposed wording lives on the ticket for owner review.",
    ],
  },
  {
    version: "3.0.4",
    date: "2026-10-16",
    summary:
      "The directory scope list is new in Composites under Shared/Data Sync (ISS-12520), tagged Experimental: the shared list of directories in scope for session collection, built on Checkbox Tree.",
    contents: [
      { level: "Primitives", entries: 2, stories: 10 },
      { level: "Composites", entries: 47, stories: 286 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 63, stories: 292 },
    ],
    changes: [
      "New in Composites, tagged Experimental: Shared/Data Sync/Directory Scope List (Default, Empty, Unavailable, All Included, No Selection, Newly Discovered, Inherited From Parent, Override Inherited Child, Auto Excluded and Long Labels, plus five dark variants: 15 stories). It enters component-catalog.ts (catalog:sync).",
      "Its stories render placeholder strings only; the component takes every string as a prop, and the proposed wording is on the ISS-12520 ticket thread.",
      "Unavailable rows are a visual state, not a lock: they carry a badge and a reason and stay toggleable, so an offline directory can be excluded.",
    ],
  },
  {
    version: "3.0.3",
    date: "2026-10-16",
    summary:
      "The data-sync level card gets a Composites entry under Shared/Data Sync, tagged Experimental, with its new visual of what stays on this device and what is uploaded (ISS-12522).",
    contents: [
      { level: "Primitives", entries: 2, stories: 10 },
      { level: "Composites", entries: 46, stories: 271 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 63, stories: 292 },
    ],
    changes: [
      "New in Composites, tagged Experimental: Shared/Data Sync/Data Sync Level Card (Default, then Off, Metadata Only and Full Transcripts, each selected and unselected, in light and dark: 12 stories).",
    ],
  },
  {
    version: "3.0.2",
    date: "2026-10-16",
    summary:
      "The Web setup gate's steps get a Composites entry under Onboarding (ISS-12363), tagged Experimental: download Desktop, then choose a sync policy, as the first user's modal and the Getting started card show them.",
    contents: [
      { level: "Primitives", entries: 2, stories: 10 },
      { level: "Composites", entries: 45, stories: 259 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 63, stories: 292 },
    ],
    changes: [
      "New in Composites, tagged Experimental: Onboarding/Setup Gate Steps (Default, Not Downloaded, Off Chosen, Modal Notice, In Getting Started Card).",
    ],
  },
  {
    version: "3.0.1",
    date: "2026-10-16",
    summary:
      "Checkbox Tree is new in Primitives/Inputs (ISS-12517), tagged Experimental: a domain-free tree with expand/collapse, tri-state inherited selection, disabled and read-only rows, and the WAI-ARIA tree keys.",
    contents: [
      { level: "Primitives", entries: 2, stories: 10 },
      { level: "Composites", entries: 44, stories: 254 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 63, stories: 292 },
    ],
    changes: [
      "New in Primitives/Inputs/Checkbox Tree, tagged Experimental: Default (flat), Nested, Mixed Selection, Read Only and Long Labels. It enters component-catalog.ts (catalog:sync).",
      "The shared Checkbox now fills its indeterminate (mixed) state in dark mode, as its checked state already did; before, a mixed box drew as an empty outline on the dark input background.",
      "No Composites, Patterns or Surfaces story was added, removed or renamed.",
    ],
  },
  {
    version: "3.0.0",
    date: "2026-10-16",
    summary:
      "The Storybook adopts Storybook's feature lifecycle (ISS-12610): every story is Stable, Preview, Experimental or Deprecated, shown as its sidebar badge in place of the version. The v2.0 roots lose their version and become the plain level roots; the old plain roots become the Deprecated v1.0 roots. Every story URL changes.",
    contents: [
      { level: "Composites", entries: 44, stories: 254 },
      { level: "Patterns", entries: 13, stories: 71 },
      { level: "Surfaces", entries: 63, stories: 292 },
    ],
    changes: [
      "Renamed roots. Foundations v2.0, Primitives v2.0, Composites v2.0, Patterns v2.0 and Surfaces v2.0 are now Foundations, Primitives, Composites, Patterns and Surfaces. The old Foundations, Primitives, Composites and Surfaces are now Foundations v1.0, Primitives v1.0, Composites v1.0 and Surfaces v1.0. Nothing moved inside a root.",
      "Every story URL changed with its root. Old to new id prefix: foundations-v2-0- to foundations-, primitives-v2-0- to primitives-, composites-v2-0- to composites-, patterns-v2-0- to patterns-, surfaces-v2-0- to surfaces-; and foundations- to foundations-v1-0-, primitives- to primitives-v1-0-, composites- to composites-v1-0-, surfaces- to surfaces-v1-0-. Replace the prefix in a saved link to find the story.",
      "Lifecycle tags replace the v1.0 and v2.0 tags. Stable (487 stories): the current roots, except as below, and Start Here. Preview (122): everything under Labs. Experimental (22): everything under Not In The Live App; the design stories of Surfaces/Artifacts/Branches/Branch Detail and Session Detail (Default, the tab stories and Dark), which are design previews, not the shipped page; and Composites/Shared/Activity/Future (V2 — not for build). Deprecated (2,113): every story in the v1.0 roots, including 31 that had no version tag.",
      "Issues moves into Labs, beside Documents: Surfaces, Patterns and Composites Not In The Live App/Issues/Issues List and Issue Detail are now Labs/Issues/Issues List and Issue Detail, tagged Preview (Nerys, 2026-10-16). Their story URLs changed with the move.",
      "The sidebar badge shows the lifecycle stage. Start Here/Introduction has a new Lifecycle section, and TAXONOMY.md replaces Versions with Lifecycle: what each stage means, how an entry is promoted, and the release numbering from here (semver: patch for a fix, minor for new entries or promotions, major for removals or URL changes).",
    ],
  },
  ...V2_RELEASES,
] as const;

const VersionHistoryPage = () => (
  <div className="mx-auto flex max-w-3xl flex-col gap-8 p-6">
    <header className="space-y-2">
      <p className="font-medium text-muted-foreground text-sm uppercase tracking-[0.2em]">
        Start Here
      </p>
      <h1 className="font-semibold text-3xl tracking-tight">Version history</h1>
      <p className="max-w-2xl text-muted-foreground text-sm">
        Current version: <code>v{packageJson.version}</code>. Each release lists
        what changed since the one before it, newest first.
      </p>
    </header>

    {RELEASES.map((release) => (
      <section
        aria-labelledby={`release-${"releaseId" in release ? release.releaseId : release.version}`}
        className="space-y-4 rounded-lg border bg-card p-4 shadow-sm"
        key={"releaseId" in release ? release.releaseId : release.version}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2
            className="font-semibold text-xl tracking-tight"
            id={`release-${"releaseId" in release ? release.releaseId : release.version}`}
          >
            v{release.version}
          </h2>
          <time
            className="text-muted-foreground text-sm"
            dateTime={release.date}
          >
            {release.date}
          </time>
        </div>
        <p className="text-muted-foreground text-sm">{release.summary}</p>

        <table className="w-full text-sm">
          <caption className="sr-only">
            What v{release.version} contains, per level
          </caption>
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="py-1 font-medium" scope="col">
                Level
              </th>
              <th className="py-1 text-right font-medium" scope="col">
                Entries
              </th>
              <th className="py-1 text-right font-medium" scope="col">
                Stories
              </th>
            </tr>
          </thead>
          <tbody>
            {release.contents.map((row) => (
              <tr className="border-b last:border-0" key={row.level}>
                <th className="py-1 text-left font-normal" scope="row">
                  {row.level}
                </th>
                <td className="py-1 text-right tabular-nums">{row.entries}</td>
                <td className="py-1 text-right tabular-nums">{row.stories}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <ul className="list-disc space-y-1 pl-5 text-sm">
          {release.changes.map((change) => (
            <li key={change}>{change}</li>
          ))}
        </ul>
      </section>
    ))}
  </div>
);

// No controls: the page renders the fixed release history and takes no props.
const meta = {
  title: "Start Here/Version History",
  tags: ["stable"],
  component: VersionHistoryPage,
  // No autodocs, for the same reason as Start Here/Introduction: this page is
  // already the documentation.
  parameters: {
    controls: {
      disable: true,
    },
  },
} satisfies Meta<typeof VersionHistoryPage>;

export default meta;

type Story = StoryObj<typeof meta>;

export const VersionHistory: Story = {
  name: "Version History",
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The newest release must be the version the package declares.
    const headings = canvas.getAllByRole("heading", { level: 2 });
    await expect(headings[0]).toHaveTextContent(`v${packageJson.version}`);
    // Two releases may not share a number, and newest first means every
    // entry is lower than the one above it (4.0.1 was cut twice, ISS-12914).
    const versions = headings.map((heading) =>
      parseReleaseVersion(heading.textContent ?? "")
    );
    for (const [index, version] of versions.slice(1).entries()) {
      await expect(compareReleaseVersions(versions[index], version)).toBe(1);
    }
  },
};

function parseReleaseVersion(text: string): readonly number[] {
  const match = RELEASE_HEADING_PATTERN.exec(text.trim());
  if (!match) {
    throw new Error(`Version History heading is not a release: ${text}`);
  }
  return match.slice(1).map(Number);
}

/** 1 when `newer` is the higher version, -1 when lower, 0 when equal. */
function compareReleaseVersions(
  newer: readonly number[] | undefined,
  older: readonly number[]
): number {
  for (const [index, part] of older.entries()) {
    const difference = (newer?.[index] ?? 0) - part;
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }
  return 0;
}

const RELEASE_HEADING_PATTERN = /^v(\d+)\.(\d+)\.(\d+)$/;
