// The 2.0.x releases and the 1.0.0 baseline, newest first, appended after the
// 3.x entries in `start-here-version-history.stories.tsx`. These entries name
// the roots as they were then: their "v2.0" roots are today's plain ones, and
// their plain roots are today's "v1.0" ones.
export const V2_RELEASES = [
  {
    version: "2.0.31",
    date: "2026-10-15",
    summary:
      "Document Detail and Issue Detail get the PRD-751 page shell Branch and Session Detail have (ISS-12586, DI-16): a design preview with Composites v2.0 sections, shown first in Surfaces v2.0, with the live page after it as the Live stories. The Issue Artifact tab is four labelled stand-ins for DI-07 to DI-10. Documents List and Issues List get design shells the same way.",
    contents: [
      { level: "Composites v2.0", entries: 44, stories: 254 },
      { level: "Patterns v2.0", entries: 13, stories: 71 },
      { level: "Surfaces v2.0", entries: 63, stories: 292 },
    ],
    changes: [
      "New in Composites v2.0, under Labs/Documents/Document Detail and Not In The Live App/Issues/Issue Detail: Page Header (Default, Without Comments Toggle) and Artifact Tab, Sessions Tab, Details Tab and Activity Tab (Default, Dark).",
      "Surfaces v2.0/Labs/Documents/Document Detail and Surfaces v2.0/Not In The Live App/Issues/Issue Detail: new design stories first (Default, Sessions Tab, Details Tab, Activity Tab, Dark). The live page's stories follow, renamed with a Live prefix: Document Detail's Default, Fresh Blank Document and Historical Version are now Live, Live Fresh Blank Document and Live Historical Version; Issue Detail's Default, Loading, No Plan Yet and Historical Version are now Live, Live Loading, Live No Plan Yet and Live Historical Version. The Default story URL now shows the design; the renamed stories' URLs changed.",
      "Composites v2.0/Shared/Artifact Detail/Details Tab: new Issue story (the new Issue details group). The Document story's Document details now hold Current version only: Document type and Approver are removed (PRD-799).",
      "Surfaces v2.0/Labs/Documents/Documents List and Surfaces v2.0/Not In The Live App/Issues/Issues List: new design stories first (Default, Dark), a list shell on the Branches list composition (toolbar, one count card, the table with the shipped artifact list cells, the pagination footer) with fixture rows and no Type column. Documents List has PRD-798's columns; Issues List has Status, Priority, Assignee, Owner, Comments, Updated and Tags. The live page's stories follow, renamed with a Live prefix: Documents List's Default, Loading, Empty, Error, Legacy and Narrow are now Live, Live Loading, Live Empty, Live Error, Live Legacy and Live Narrow; Issues List's Live is unchanged. Issues List's Default now shows the design instead of its Patterns v2.0 layout, which stays at its own entry. The Default story URLs now show the design; the renamed stories' URLs changed.",
    ],
  },
  {
    version: "2.0.30",
    date: "2026-10-14",
    summary:
      "Loops is removed (ISS-12435, PRD-795): the Loop pages and the Loop, run-in-flight, compute-preference and run-availability stories are removed. Their story URLs no longer resolve.",
    contents: [
      { level: "Composites v2.0", entries: 34, stories: 233 },
      { level: "Patterns v2.0", entries: 13, stories: 71 },
      { level: "Surfaces v2.0", entries: 63, stories: 279 },
    ],
    changes: [
      "Removed from Surfaces v2.0/Other Pages/Loops: Loop Detail (5 stories) and Usage (4).",
      "Removed from Composites v2.0/Shared/Activity/Activity Card: the `P3Loop` and `RailLookAgentRun` stories.",
      "Removed from v1.0: Primitives/Overlays/Backend Mismatch Modal (2 stories), Primitives/Feedback & Status/Friendly Error Alert (1), Primitives/Feedback & Status/Loop Status Badge (10), Composites/Compute/Compute Preference Card (3), Composites/Documents/Artifact Run In Flight (6), Composites/Documents/Run Action Availability (3), and from Composites/Documents/Branches Section the `RunInFlightExplained` and `RunInFlightUnexplained` stories.",
      "Friendly Error Alert also leaves component-catalog.ts (catalog:sync). No story was added or renamed.",
    ],
  },
  {
    version: "2.0.29",
    date: "2026-10-14",
    summary:
      "Documents, PRDs, Implementation Plans and Issues get their Patterns v2.0 layouts, and the pages the artifact template still lacks are in Surfaces v2.0 as their pattern view until a new version is built (ISS-12171).",
    contents: [
      { level: "Composites v2.0", entries: 34, stories: 235 },
      { level: "Patterns v2.0", entries: 13, stories: 71 },
      { level: "Surfaces v2.0", entries: 65, stories: 288 },
    ],
    changes: [
      "New in Patterns v2.0, one list layout: Labs/Documents/Documents List, Not In The Live App/Issues/Issues List, Other Pages/PRDs/PRDs List and Other Pages/Implementation Plans/Plans List (Default, Narrow, Dark). Branches List now renders the same shared layout; its stories are unchanged.",
      "New in Patterns v2.0, one document detail layout: Labs/Documents/Document Detail, Other Pages/PRDs/PRD Detail, Other Pages/Implementation Plans/Plan Detail and Not In The Live App/Issues/Issue Detail (Default, Sessions Tab, Details Tab, Activity Tab, Dark).",
      "New in Surfaces v2.0: Other Pages/PRDs/PRDs List and Other Pages/Implementation Plans/Plans List. The live app has no such page, so each shows its pattern in the app frame until one is built.",
      "Surfaces v2.0/Not In The Live App/Issues/Issues List: Default now shows the list pattern, because the route has no list yet; the coming-soon page the route renders today moved to the new Live story. The Default story URL is unchanged.",
      "Surfaces v2.0 also counts two Branches List stories ISS-12453 added after 2.0.28 without a release.",
    ],
  },
  {
    version: "2.0.28",
    date: "2026-10-13",
    summary:
      "Branch Project Value sits at Primitives/Data Display, the title taxonomy-classification.mjs computes for it, and enters the component catalog (ISS-12442). Its story URLs changed.",
    contents: [
      { level: "Composites v2.0", entries: 34, stories: 235 },
      { level: "Patterns v2.0", entries: 5, stories: 39 },
      { level: "Surfaces v2.0", entries: 63, stories: 283 },
    ],
    changes: [
      "Composites/Branches/Branch Project Value is now Primitives/Data Display/Branch Project Value, beside Branch Priority Cell. Its story URLs changed, so a deep link or snapshot baseline keyed on the old title no longer resolves.",
      "The entry is new in component-catalog.ts: ISS-10995 added the story with a hand-written title and no catalog:sync, and validate:catalog was failing on main for it.",
      "No v2.0 story was added, removed or renamed, so the three v2.0 levels are unchanged. The fixture, helper and test changes in this release are Storybook-internal and add no story.",
    ],
  },
  {
    version: "2.0.27",
    date: "2026-10-12",
    summary:
      "The Team Spend test screen and the Session Cost Duration Card are removed with their prototypes (ISS-12359). They were process-test output with no production use.",
    contents: [
      { level: "Composites v2.0", entries: 34, stories: 235 },
      { level: "Patterns v2.0", entries: 5, stories: 39 },
      { level: "Surfaces v2.0", entries: 63, stories: 283 },
    ],
    changes: [
      "Removed from Composites/Agents/General: Spend Leaderboard (3 stories), Team Member Spend Table (2), Team Spend Overview (1) and Team Spend Summary Stats (2).",
      "Removed from Composites/Sessions: Session Cost Duration Card (4 stories).",
      "No v2.0 story was added, removed or renamed. The Session Detail and Branch Detail design previews stay; only their prototype hosts are removed.",
    ],
  },
  {
    version: "2.0.26",
    date: "2026-10-12",
    summary:
      "Every entry in Surfaces v2.0, Patterns v2.0 and Composites v2.0 lists its stories in one order: Default, then the shared states, then the page's own states, then variants (ISS-12332). validate:catalog checks it.",
    contents: [
      { level: "Composites v2.0", entries: 34, stories: 235 },
      { level: "Patterns v2.0", entries: 5, stories: 39 },
      { level: "Surfaces v2.0", entries: 63, stories: 283 },
    ],
    changes: [
      "The shared states, in order: Loading, Syncing, Empty, No Matches, Error, Not Found, No Permission, Unavailable, Stale. A story named after one plus more words (Loading Dark, Error With Retry) sits with it, and four older names count as their state: Permission (No Permission), No Sessions (Empty), Failed Retrieval and Load Failed (Error). States only that page has come next, then variants: tabs, views, flag arms, Dark, Narrow, desktop.",
      "Surfaces v2.0 reordered: Sessions List, Branches List, My Tasks, Packs List, Pack Detail, Custom Fields, Loop Detail, Help, Plans, Approvals, Requests and GitHub Link. No story was added, removed or renamed, so every link still works.",
      "Patterns v2.0/Shared/Artifact Detail: Error Notice and Stale Notice now come right after Default, then Partial Notice and Activity Unsupported, then the variants.",
      "Composites v2.0 reordered: Shared/Artifact Detail/Artifact Tab and Details Tab, Session Detail/Session Trace Chart, and Branch Detail/Branch Sessions Timeline Panel (Default, Loading, No Sessions, Failed Retrieval, Permission, then Partial Retrieval and the variants).",
      "Shared/Activity/Activity Timeline and Activity Comment Card follow the order too (2.0.25 reordered them), so the check has no exempt entries.",
      "Comments Pane: Failed Load With Retry moves up to the Error slot (Failed Load is now an older name for Error). Sign In and Sign Up: Clerk Load Failed, the page's own error state, now comes before the Narrow variant.",
      "The check keeps an entry's first story first when none is named Default, even when that story is a shared state, and fails an exemption whose entry is already in order.",
    ],
  },
  {
    version: "2.0.25",
    date: "2026-10-12",
    summary:
      "The Activity tab's timeline reads who, what, when: the actor's avatar on the line, the name, the action, then the time (ISS-12330).",
    contents: [
      { level: "Composites v2.0", entries: 34, stories: 235 },
      { level: "Surfaces v2.0", entries: 63, stories: 283 },
    ],
    changes: [
      "Each timeline row is the actor's 24px avatar on the zinc-100 line (the dots are gone; the line runs from the first avatar to the last), the name, the action, then the exact time, unchanged in format. A person's avatar is their photo, or their initials without one; System is a cog and an agent is a robot, still named as its key owner with the API badge. Below sm the name and the time share the first line and the action sits under them.",
      'The agent-run row reads "started an agent run · Execute · [Completed]" (the command in the Runs table\'s words; it links to the run only where the host supplies a run link, which the stories do and no production host does yet) on the timeline and on the Document comments rail, replacing "ran a code loop". The comments rail card\'s layout is unchanged.',
      "Composites v2.0/Shared/Activity/Activity Timeline: new Photos, Photos Session, Photos And Initials, Photos And Initials Branch and System And Agents; Document, Session, Branch, Single Actor Repeating, the load states, Dark and Narrow show the new row. Photos are copies of the repo's seed portraits (DiceBear Lorelei illustrations, CC0) in the Storybook's public/seed-avatars.",
      "Activity Card (timeline look), Activity Comment Card and Future (V2 — not for build) show the new row. P3 Loop reads the new agent-run wording; new Rail Look Agent Run shows it in the comments rail card.",
      "The Session Detail and Branch Detail Activity Tab stories (Composites v2.0 and Surfaces v2.0) show the new row.",
    ],
  },
  {
    version: "2.0.24",
    date: "2026-10-12",
    summary:
      "One Details tab for Session, Branch and Document: the same four sections on every type, on a canvas card, Associated artifacts grouped by type and every field Kerensa reconciled (ISS-12252, ISS-12403). The Artifact, Details and Activity tabs share one canvas card. Replaces the old Details tab; 2.1.0 was a temporary side-by-side review and is folded in here.",
    contents: [
      { level: "Composites v2.0", entries: 34, stories: 229 },
      { level: "Surfaces v2.0", entries: 63, stories: 283 },
    ],
    changes: [
      'The Details tab has the same four sections on every type, mirroring the database (Ottilie, Oct 9 sync: no made-up groupings): Artifact details, then "<Type> details" (Session details, Branch details, Document details), then Custom fields, named for their project, then Associated artifacts. Sections are always open. No version history and no activity on the tab.',
      "Session details holds the session's own fields with no sub-headers: launch attribution, Sync, Repository and Other repositories, the usage rows (tokens, Cache write TTL, cost, LOC / $, turns, subagents, tool uses, steers, errors) and, for a Codex session, the Codex runtime rows. There is no Code section: Lines changed is the branch's and stays on the canvas, and branches and pull requests are only in Associated artifacts.",
      "Branch details holds the branch's git rows (repository, base branch, head SHA, origin, changes, files changed, commits), the composite Pull request row (number, title, lifecycle chip) with review decision, reviewers, checks, opened / merged at and merge commit, then cost, LOC / $, summed tokens, lead and idle time. The sessions that worked it are in Associated artifacts. The always-empty Checks count is gone.",
      "The fields are ISS-12197's list plus Kerensa's reconciliation (its See also). A row is left out when the artifact has no value for it. Editability is shown the Asana way: a hover background and a pointer cursor, no pencil, lock or badge; a viewer who cannot edit gets the reason once at the top.",
      "The Details tab sits on the Artifact tab's canvas card (a muted surround, one bordered card); inside it the sections are separated by a horizontal rule, with no border of their own.",
      "Associated artifacts is one section per type (Documents, Sessions, Issues, Branches & pull requests, then any other type), drawn by production's grouped linked-artifacts table, with a Parent, Child, Blocked by, Blocking or Related relationship and no Type column. A Session's pull requests are listed with its branch.",
      "Session Detail and Branch Detail: the Artifact tab (Session's Session tab), the Details tab and the Activity tab sit on the same framed canvas card, a border and padding around the content on a muted surround (one component, ArtifactCanvasPanel). The Properties sections are gone from the Artifact tab: a session's or branch's properties are its Details tab (Branch matches production since ISS-12267).",
      "Session Detail and Branch Detail: every tab body is one width, left-aligned: it fills the page up to a 1920px browser and stops there, max 1648px (was centered at 1000px on the canvas and Activity tabs and 1152px on Details), from one constant, ARTIFACT_DETAIL_CONTENT_WIDTH_CLASS.",
      "Composites v2.0/Shared/Artifact Detail: Details Tab (Session, Session (Codex), Branch, Document, No Permission, Narrow, Dark) and Details Sections (Common Fields, Editability, Session Fields, Branch Fields, Custom Fields, Associated Artifacts, Associated Multiple Parents) are the new tab and its parts. Details Design Preview Host, the old Details harness, is removed.",
      "Surfaces v2.0: Session Detail and Branch Detail's Details Tab is the new tab, and Details Tab Dark is added. The Composites v2.0 Details Tab stories under each page show it too.",
      "No v2.1 tag: 2.1.0 (2026-10-08) showed the new Details tab as v2.1 stories beside the old one for review; with the old one replaced, those stories are folded into the v2.0 tree above and the Storybook stays on 2.0.x.",
    ],
  },
  {
    version: "2.0.23",
    date: "2026-10-08",
    summary:
      "The Activity tab gets its timeline, read as when, who, what, and a story for every activity item the product captures (ISS-12117).",
    contents: [
      { level: "Composites v2.0", entries: 26, stories: 201 },
      { level: "Surfaces v2.0", entries: 63, stories: 281 },
    ],
    changes: [
      "Composites v2.0/Shared/Activity is a new group. Activity Card has one story per ISS-10994 catalog row (C01–C31, P1–P4), the Human, Agent (API) and System variants of C02, Long Value Truncation and Missing User; Activity Comment Card has Short, Long and Unavailable; Activity Timeline has the Document, Session and Branch example timelines, Single Actor Repeating and every load state.",
      "Composites v2.0/Shared/Artifact Detail/Activity Timeline moved to Composites v2.0/Shared/Activity/Activity Timeline. Its story URLs changed.",
      "Future (V2 — not for build) holds the collapsed run, the hidden-items break and the expanded detail card, labelled as explorations only.",
      "The Session Detail and Branch Detail Activity Tab stories (Composites v2.0 and Surfaces v2.0) show the new Session and Branch example timelines. The Document rail's Activity Card View (v1.0) uses the same wording as the tab.",
      "Each timeline row is the exact time (\"Oct 8, 10:32\", 24-hour, the date semibold and the time regular; the year only when it is not this year), a 10px dot on a zinc-100 line, who (a person, an agent as its owner with the API badge, or System), then what: no avatars or icons. Comment cards are the comments rail's card width (319px). The Activity tab body uses the artifact detail pages' shared content width, left-aligned.",
      "The Document, Session and Branch example timelines are rebuilt from the ISS-10994 capture report: every row is a catalogued capture (C01–C29) or Document projection, each feed has an agent edit, and the Session timeline drops C30/C31, which the Session feed excludes. The fixture people are Emily Carter, Jake Morrison and Ryan Brooks.",
    ],
  },
  {
    version: "2.0.22",
    date: "2026-10-06",
    summary:
      "Session Detail and Branch Detail get the prototype's page header row and collaborators, at every level.",
    contents: [
      { level: "Surfaces v2.0", entries: 63, stories: 281 },
      { level: "Composites v2.0", entries: 23, stories: 157 },
    ],
    changes: [
      "Surfaces v2.0: Session Detail and Branch Detail open with the route header (sidebar toggle and breadcrumbs, the session's overflow and status after them) and the comments toggle at its end, which shows on the tabs the comments rail sits beside. The tab row ends with the collaborators' avatars.",
      "Patterns v2.0: both pages' layouts add the page header row (Breadcrumbs and Comments toggle regions) and name the tab row's end region Collaborators.",
      "Composites v2.0: new Page Header, Artifact Tab, Details Tab and Activity Tab under Session Detail; Page Header, Artifact Tab, Details Tab, Sessions Tab and Activity Tab under Branch Detail; and Shared/Artifact Detail/Collaborators.",
    ],
  },
  {
    version: "2.0.21",
    date: "2026-10-06",
    summary:
      "Session Detail and Branch Detail show the PRD-751 page, with the tab set Patterns v2.0 lays out.",
    contents: [{ level: "Surfaces v2.0", entries: 63, stories: 281 }],
    changes: [
      "Session Detail: Default, Details Tab, Activity Tab and Dark render the PRD-751 Session page (Artifact / Details / Activity) in the Global Nav frame. They were the New Design stories.",
      "Branch Detail: Default, Details Tab, Sessions Tab, Activity Tab and Dark render the PRD-751 Branch page (Artifact / Details / Sessions / Activity) in the Global Nav frame. Sessions Tab is new.",
      "The page the live app ships today stays on both, renamed with a Live prefix (Live, Live Loading, Live Error, ...).",
    ],
  },
  {
    version: "2.0.20",
    date: "2026-10-06",
    summary:
      "Every Surfaces v2.0 page is now the live app's page: the last placeholders (system states, sign-in, onboarding and the desktop-only pages) render.",
    contents: [{ level: "Surfaces v2.0", entries: 63, stories: 280 }],
    changes: [
      "System States: Page Not Found, Route Error, Workspace Access Failed and API Unreachable render the live components; Page Unavailable renders the desktop Labs gate in the desktop frame.",
      "Sign In, Sign Up, SSO Callback, GitHub Connect and GitHub Link render in the live sign-in layout, with each state the live page reaches. Clerk's own sign-in form shows as a labelled region.",
      "Onboarding renders the live wizard; the guided dialog stories render the live guided host over the live Dashboard.",
      "Plans, Approvals, Requests and Audit Bot render the desktop views in the desktop app's frame.",
      "No planned placeholders remain in Surfaces v2.0. The Surfaces v2.0 Overview and TAXONOMY.md describe a Surface as the live page.",
    ],
  },
  {
    version: "2.0.19",
    date: "2026-10-06",
    summary:
      "Settings and the Document, PRD, Plan and Issue pages are the live app's pages.",
    contents: [{ level: "Surfaces v2.0", entries: 63, stories: 248 }],
    changes: [
      "Every Settings panel renders the live settings dialog (nav rail, close, panel) over the app, at /settings?panel=<id>. Profile, Local Compute Targets, Desktop App and Other Labs Settings were placeholders and now render. Members and the Profile sign-in methods are Clerk's hosted UI, which Storybook shows as a labelled region.",
      "Desktop Authorize, Desktop Connect and Security Upgrade render their live full pages with their states.",
      "Document, PRD, Plan and Issue Detail render their live route containers: header and actions, properties bar, editor and the sections below. Storybook takes the editor's room-less path (.storybook/collaboration-room-utils-mock.ts), so presence, anchored comments and the feed rail are not shown.",
      "Removed: the five Members states from the old tabbed Settings mock, the desktop-only Connected Devices state, Document Detail Loading (the live page has none), and Plan Detail's two story-built modal states.",
    ],
  },
  {
    version: "2.0.18",
    date: "2026-10-06",
    summary:
      "Seventeen more Surfaces v2.0 pages are the live app's pages: the Labs pages, Search, Help, Diagnostics, User Profile, Usage, Loop Detail, Issues, Routines, Judges and Judge Detail.",
    contents: [{ level: "Surfaces v2.0", entries: 63, stories: 239 }],
    changes: [
      "Inbox, My Tasks, Agents, Agent Detail, Packs, Pack Detail, Search, Help and Diagnostics render their live route components with every element, in the Global Nav frame.",
      "Insights, Lost work, TokenOps waste, User Profile, Usage, Loop Detail, Issues, Routines, Judges and Judge Detail were placeholders and now render the live pages.",
      "Feature flags are set to what the live app shows; where a flag's rollout is off, the flag-on view is its own story.",
      "Desktop-only states (desktop pack views, the desktop search palette, desktop diagnostics sources) and hand-built states the live page cannot reach were removed from Surfaces v2.0.",
    ],
  },
  {
    version: "2.0.17",
    date: "2026-10-06",
    summary:
      "Eight more Surfaces v2.0 pages are the live app's pages: Sessions, Session Detail, Branches, Branch Detail, Documents, Projects, Project Detail and Archived Projects.",
    contents: [{ level: "Surfaces v2.0", entries: 63, stories: 233 }],
    changes: [
      "Each renders its live route component in the Global Nav frame, with its header, toolbar, filters, tabs and actions, fed by fixture API responses. Stories are the live page's states; URL-driven states (filters, tabs) set the route through parameters.liveRoute.",
      "Session Detail and Branch Detail: Default is the live page. The unshipped redesign stays as New Design, New Design Details Tab, New Design Activity Tab and New Design Dark.",
      "Archived Projects, Branch Detail Not Found and Sessions Tab were placeholders and now render. Stories for states the live page cannot reach, and component edge cases, were removed from Surfaces v2.0; the edge cases remain in their component stories.",
    ],
  },
  {
    version: "2.0.16",
    date: "2026-10-06",
    summary:
      "Surfaces v2.0 starts showing the live app's own pages, beginning with the Dashboard, in the Composites v2.0 Global Nav frame.",
    contents: [{ level: "Surfaces v2.0", entries: 63, stories: 268 }],
    changes: [
      "Surfaces v2.0/Dashboard renders the live route (apps/app .../dashboard/page.tsx) with every element the live page has: header, range and scope controls, KPI cards, AI Impact, Event Activity, Recent Synced Sessions, model and PR charts. Its stories are the live page's states: Default, Empty, Unavailable, Recent Sessions Unavailable and Guided Tour. Metrics Only and Guided Tour Mid Run were hand-built states and are gone.",
      "Surfaces v2.0 pages render in the Global Nav of Composites v2.0/Shared/Navigation/Sidebar, now a shared component (v2-global-nav.tsx).",
      "Storybook answers Clerk with a signed-in stand-in (.storybook/clerk-nextjs-mock.tsx), so live route components that read the user and organization can render.",
    ],
  },
  {
    version: "2.0.15",
    date: "2026-10-06",
    summary:
      "Composites v2.0's Shared/App Shell group is renamed Navigation (Nerys, 2026-10-06).",
    contents: [{ level: "Composites v2.0", entries: 13, stories: 136 }],
    changes: [
      "Composites v2.0/Shared/App Shell/Sidebar is now Composites v2.0/Shared/Navigation/Sidebar. Its story URLs changed.",
    ],
  },
  {
    version: "2.0.14",
    date: "2026-10-06",
    summary:
      "The Sidebar is copied into Composites v2.0 under Shared/App Shell, the first v1.0 composite carried into v2.0.",
    contents: [{ level: "Composites v2.0", entries: 13, stories: 136 }],
    changes: [
      "New Composites v2.0/Shared/App Shell/Sidebar: a copy of Composites/Navigation/Sidebar (Global Nav, Menu Button Sizes And Variants). The v1.0 Sidebar is unchanged.",
      "Shared gains an App Shell group, for sections of every page.",
      "validate:catalog checks v2.0 copies in stories/composites-v2/ against the v2.0 page tree.",
    ],
  },
  {
    version: "2.0.13",
    date: "2026-10-06",
    summary:
      "Composites v2.0 and Surfaces v2.0 open with an Overview page, like Patterns v2.0, so each of the three says what it holds and how they work together.",
    contents: [
      { level: "Composites v2.0", entries: 12, stories: 134 },
      { level: "Patterns v2.0", entries: 4, stories: 36 },
      { level: "Surfaces v2.0", entries: 63, stories: 269 },
    ],
    changes: [
      "New Composites v2.0/Overview and Surfaces v2.0/Overview, first in their roots.",
      "All three Overview pages share one layout: what goes here, what does not, how the three work together, Branch Detail in each root, and the rules from TAXONOMY.md.",
      "Patterns v2.0/Overview is rewritten on the same layout.",
    ],
  },
  {
    version: "2.0.12",
    date: "2026-10-06",
    summary:
      "v2.0 is organised by page: Composites v2.0 and Patterns v2.0 follow the Surfaces v2.0 tree, and TAXONOMY.md sets the rules for what each level is and how they link.",
    contents: [
      { level: "Composites v2.0", entries: 11, stories: 133 },
      { level: "Patterns v2.0", entries: 4, stories: 36 },
      { level: "Surfaces v2.0", entries: 62, stories: 268 },
    ],
    changes: [
      "Composites v2.0 holds sections of pages, grouped under the page that uses them: Shared/Artifact Detail (Activity Timeline, Artifact Tab, Comments Pane, Details Design Preview Host), Dashboard, Artifacts/Sessions (Inline Name Cell, Sessions List, Session Detail with the trace chart, inspector and toolbar) and Artifacts/Branches/Branch Detail.",
      "Patterns v2.0 holds page shells and layouts with no content, every slot an empty, named region: Shared/Artifact Detail (the ISS-10790 shell) and the Session and Branch Detail layouts, at the same paths as their pages.",
      "The composed Branch and Session detail pages move from Composites v2.0 to Surfaces v2.0, where they are now the Default story of Branch Detail and Session Detail.",
      "catalog:sync places every v2.0 Composite and Pattern from V2_PLACEMENT_BY_ID, and validate:catalog fails a placement that is not a page of the tree. Story URLs under Composites v2.0 and Patterns v2.0 changed.",
    ],
  },
  {
    version: "2.0.11",
    date: "2026-10-06",
    summary:
      "Activity wording for Branches and Sessions (Nerys, 2026-10-06), and the Surfaces v2.0 Details tabs are the composed pages.",
    contents: [
      { level: "Composites v2.0/Artifact Detail", entries: 6, stories: 124 },
      { level: "Surfaces v2.0", entries: 62, stories: 266 },
    ],
    changes: [
      'An empty Branch or Session feed says "Changes to this branch will appear here." or "Changes to this session will appear here.", since those feeds carry no comments. Activity Timeline gains Session Empty and Branch Empty.',
      'Tag rows say "added a tag" or "removed a tag" instead of "updated the tag", and a Session owner change says "updated the owner".',
      "Surfaces v2.0 Branch Detail and Session Detail: the Details Tab placeholders are now the composed pages opened on Details, from new Details Tab stories on both Design Previews.",
    ],
  },
  {
    version: "2.0.10",
    date: "2026-10-06",
    summary:
      "The Activity tab is kept (Nerys, 2026-10-06): the composed Branch and Session pages show it, Surfaces v2.0 shows them on it, and the timeline has examples for every captured activity type.",
    contents: [
      { level: "Composites v2.0/Artifact Detail", entries: 6, stories: 122 },
      { level: "Composites v2.0/Branches", entries: 2, stories: 7 },
      { level: "Composites v2.0/Sessions", entries: 3, stories: 11 },
    ],
    changes: [
      "Branch Detail Design Preview has four tabs, Artifact / Details / Sessions / Activity, and Session Detail Design Preview three, Artifact / Details / Activity. Each has an Activity Tab story. This replaces the 2026-09-28 ruling that hid the tab.",
      "Surfaces v2.0 Branch Detail and Session Detail: the Activity Tab placeholders are now the composed pages opened on Activity.",
      "Activity Timeline gains Document: All Events, Session Activity and Branch Activity, built from the ISS-10994 activity capture inventory: every stored event type, the rows the Document feed derives, and person, API-key (Agent) and System actors.",
      "A Session's status rows read in the Session words (Active, Inactive, Failed), not the stored values.",
    ],
  },
  {
    version: "2.0.9",
    date: "2026-10-06",
    summary:
      "The sidebar lists every v2.0 root first, then every v1.0 root, and Start Here no longer shows a version.",
    contents: [{ level: "Start Here", entries: 3, stories: 3 }],
    changes: [
      "Sidebar order: Start Here, then Foundations v2.0, Primitives v2.0, Composites v2.0, Patterns v2.0 and Surfaces v2.0, then Foundations, Primitives, Composites and Surfaces.",
      "Start Here, Introduction, Catalog and Version History show no version badge in the sidebar. Their story files keep their v1.0 tag, so the tag filter still finds them.",
    ],
  },
  {
    version: "2.0.8",
    date: "2026-10-06",
    summary:
      "Colors › Primitives follows Tailwind's order: Yellow now comes before Lime.",
    contents: [{ level: "Foundations v2.0/Colors", entries: 1, stories: 2 }],
    changes: [
      "After Base, Brand and Zinc, the hues run Red, Orange, Amber, Yellow, Lime, Green, Emerald, Teal, Cyan, Sky, Blue, Indigo, Violet, Purple, Fuchsia, Pink, Rose, as in Tailwind. The Figma export had Lime and Yellow the other way round.",
    ],
  },
  {
    version: "2.0.7",
    date: "2026-10-06",
    summary:
      "Colors › Primitives reordered: Base, Brand and Zinc first, then the hues. Zinc is the only grey scale.",
    contents: [{ level: "Foundations v2.0/Colors", entries: 1, stories: 2 }],
    changes: [
      "Primitives lists Base, then Brand, then Zinc, then the other colours in their existing order (Red to Rose).",
      "Slate, Gray, Neutral and Stone are removed from the library, leaving 205 colours in 20 families.",
    ],
  },
  {
    version: "2.0.6",
    date: "2026-10-06",
    summary:
      "Foundations v2.0/Colors gains Primitives, the primary colour library, and every Foundations v2.0 colour is now shown as hex.",
    contents: [{ level: "Foundations v2.0/Colors", entries: 1, stories: 2 }],
    changes: [
      "Colors › Primitives: 249 colours in 24 families, the Tailwind palette plus the ClosedLoop brand colours, from the Figma Primitives export (tailwindcss-colors.json). Semantic tokens will be drawn from it later.",
      "Colors › Default keeps the same tokens, but shows each value as hex instead of oklch. A translucent token shows its alpha as an eight-digit hex.",
    ],
  },
  {
    version: "2.0.5",
    date: "2026-10-06",
    summary:
      "Foundations v2.0: a copy of the five Foundations pages, where the v2.0 token changes go. Foundations stays v1.0.",
    contents: [{ level: "Foundations v2.0", entries: 5, stories: 5 }],
    changes: [
      "Foundations v2.0, a new root directly before Foundations: Colors, Typography, Spacing, Radius & Elevation and Motion, copied as they are and tagged v2.0.",
      "The copies live in stories/foundations-v2/, so v2.0 pages can change without touching the v1.0 ones. validate:catalog checks their titles.",
    ],
  },
  {
    version: "2.0.4",
    date: "2026-10-06",
    summary:
      "Composites v2.0 regrouped: the artifact detail page's shared parts sit together under Artifact Detail, and the Session pieces move out of Agents into Sessions.",
    contents: [
      { level: "Composites v2.0/Artifact Detail", entries: 6, stories: 119 },
      { level: "Composites v2.0/Sessions", entries: 2, stories: 6 },
      { level: "Composites v2.0/Sessions/Trace", entries: 3, stories: 18 },
    ],
    changes: [
      "Artifact Detail, a new group: Artifact Detail Shell (ISS-10790), Artifact Tab, Details Design Preview Host, Branch Sessions Timeline Panel, Activity Timeline and Comments Pane. They came from App Shell, Documents and Branches.",
      "Session Artifact Shell and Session Detail Design Preview move from Agents/Detail to Sessions, and Session Trace Chart, Inspector and Toolbar to Sessions/Trace.",
      "Branch Artifact Shell and Branch Detail Design Preview stay in Branches. The 11 moved stories have new story URLs.",
    ],
  },
  {
    version: "2.0.3",
    date: "2026-10-06",
    summary:
      "Primitives v2.0 and Composites v2.0: the v2.0 components moved to their own roots, so Primitives and Composites hold v1.0 only.",
    contents: [
      { level: "Primitives v2.0", entries: 1, stories: 5 },
      { level: "Composites v2.0", entries: 16, stories: 159 },
    ],
    changes: [
      "Primitives v2.0 and Composites v2.0, each directly before its v1.0 root and with the same groups. A story file tagged v2.0 is titled under the v2.0 root automatically.",
      "The 17 v2.0 story files moved, including the ISS-10790 Artifact Detail Shell and the PRD-751 components. Their story URLs changed, from composites-… to composites-v2-0-… and from primitives-… to primitives-v2-0-….",
      "Primitives and Composites now show v1.0 on their own, because everything inside them is v1.0. The pinned root badge from 2.0.2 is removed.",
    ],
  },
  {
    version: "2.0.2",
    date: "2026-10-06",
    summary:
      "Every Primitives and Composites story now carries a version tag. The 15 story files added after the v1.0 baseline are tagged v2.0.",
    contents: [
      { level: "Primitives", entries: 1, stories: 5 },
      { level: "Composites", entries: 14, stories: 138 },
    ],
    changes: [
      "Nine PRD-751 components tagged v2.0: Artifact Tab, Comments Pane, Branch Artifact Shell, Branch Sessions Timeline Panel, Branch Detail Design Preview, Session Artifact Shell, Session Detail Design Preview, Activity Timeline and Details Design Preview Host.",
      "Six other components added since v1.0 tagged v2.0: Primitives/Data Display/Person Avatar, Composites/Data Display/Inline Name Cell, Composites/Sessions/Session Inline Rename, and Session Trace Chart, Inspector and Toolbar.",
      "The Primitives and Composites roots always show v1.0 in the sidebar. The stories inside keep their own tag, v1.0 or v2.0.",
    ],
  },
  {
    version: "2.0.1",
    date: "2026-10-06",
    summary:
      "Start Here/Introduction documents Patterns as a level of its own, between Composites and Surfaces.",
    contents: [{ level: "Start Here", entries: 1, stories: 1 }],
    changes: [
      "Start Here/Introduction: Four levels is now Five levels. The new Patterns level holds page shells and page layouts. A full page is composed from patterns and composites to make a Surface.",
    ],
  },
  {
    version: "2.0.0",
    date: "2026-10-01",
    summary:
      "Surfaces v2.0: the page tree ISS-11361 targets, as its own root beside the v1.0 Surfaces, which are unchanged. Patterns v2.0: the page layouts those pages are built inside.",
    contents: [
      { level: "Composites", entries: 2, stories: 22 },
      { level: "Patterns v2.0", entries: 3, stories: 12 },
      { level: "Surfaces v2.0", entries: 62, stories: 266 },
    ],
    changes: [
      "Patterns v2.0, a new root directly before Surfaces v2.0. It follows the Surfaces v2.0 tree, so a page's layout sits at the same path as the page. Overview, then Artifacts/Sessions/Session Detail (Artifact, Details and Activity tabs) and Artifacts/Branches/Branch Detail (all four tabs): each is the ISS-10790 artifact detail shell's Default story with that type's tabs, and Details has no comments rail.",
      "Two composites added since v1.0: Composites/App Shell/Artifact Detail Shell (ISS-10790) and Composites/Insights/Dashboard Scope Control.",
      "62 page entries in the ISS-11361 order: the live sidebar (Dashboard, Artifacts, Labs, Your Teams), then Workspace Menu, Other Pages, Not In The Live App, Desktop Only, Sign In, Onboarding and System States.",
      "Each entry lists Default first, then its states in the ticket's fixed order (Loading, Syncing, Empty, No Matches, Error, Not Found, No Permission, Unavailable, Stale), then variants and tabs.",
      "220 stories reuse existing stories. 46 are planned slots for pages and states nothing renders yet, tagged planned so the sidebar filter can show or hide them.",
    ],
  },
  {
    version: "1.0.0",
    date: "2026-09-29",
    summary:
      "The baseline. Everything in this Storybook on this date is version 1.0; later versions list only what changed.",
    contents: [
      { level: "Start Here", entries: 3, stories: 3 },
      { level: "Foundations", entries: 5, stories: 5 },
      { level: "Primitives", entries: 98, stories: 343 },
      { level: "Composites", entries: 299, stories: 1612 },
      { level: "Surfaces", entries: 20, stories: 158 },
    ],
    changes: [
      "Four levels (Foundations, Primitives, Composites, Surfaces) with Start Here above them, as described in Start Here/Introduction.",
      "Composites/Navigation/Sidebar › Global Nav matches the live web sidebar in light and dark: workspace menu, Dashboard, Artifacts, Labs and Your Teams.",
      "Every story is tagged v1.0, and the sidebar shows the tag beside each item. Filter the sidebar by that tag to see the whole release.",
      "This Version History page.",
    ],
  },
] as const;
