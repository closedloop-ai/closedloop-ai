/**
 * @file session-count-population.ts
 * @description The canonical identity and SCOPE of every session/transcript
 * count the product renders beside a bare number (ISS-8474, split from
 * ISS-7905).
 *
 * ISS-7905 recorded four numbers a user meets in one sitting — 22/178 over the
 * Sessions list, 178 parsed sessions in onboarding, 18 on the Dashboard, 593
 * imported transcripts on the import splash. Every one is correct. Nothing on
 * screen said they count different things, so they read as one series that
 * fails to add up.
 *
 * Tracing them found the confusion is worse than "the labels are vague": two of
 * them had NO noun at all. The Sessions sync banner rendered a bare
 * `${completed} / ${total}` (until #7291 deleted it) and the import harness rows
 * render a bare `${processed} / ${total}`, stacked on the same screen, measuring
 * a cloud upload queue and a set of files on disk respectively. A third, the
 * Sessions list footer, says "sessions" for a population that is the whole ORG
 * on web and cloud-mode desktop but only THIS MACHINE in desktop local mode —
 * one sentence over two populations, which is why both spellings are members here.
 *
 * This module is the VALUES: which populations exist and what each measures,
 * along the axes that actually separate them. It carries no user-facing text.
 * The COPY lives in the sibling `session-count-population-display.ts`, split the
 * same way and for the same reason as `session-status.ts` /
 * `session-status-display.ts` (ISS-5592): a bundle-sensitive `"use client"`
 * surface must import a label without pulling anything heavier in behind it.
 *
 * Which pairs MUST agree and which are expected to differ is a third module,
 * `session-count-population-reconciliation.ts`, because that is a claim about
 * the relationships and not about either population alone.
 *
 * It lives in `@repo/app` because this is a RENDER-LAYER vocabulary, not a
 * transport contract, and this package is the shared product-UI package both
 * `apps/app` and the desktop renderer already import. It was first written into
 * `packages/api/src/types/`, which that package's `AGENTS.md` reserves for types
 * used by both `apps/app` and `apps/api` — this is used by neither (codex
 * review). The web-side populations stay registered here ahead of the surfaces
 * that will read them, which the move preserves: `@repo/app` is reachable from
 * both surfaces, so the vocabulary still cannot fork the way ISS-5592 found
 * `SESSION_STATUS` had.
 */

/**
 * What one tick of a count IS. The distinction ISS-5281 had to make by hand at a
 * single call site: a session is one conversation, an import source is one thing
 * the importer enumerates, and the two never convert at a fixed rate — one
 * OpenCode source is a whole `opencode.db` holding an unknown number of them.
 */
export const SESSION_COUNT_UNIT = {
  Session: "session",
  /**
   * One thing the importer enumerates and settles, which is NOT reliably one
   * transcript file (codex and whitlockk review). Claude and Codex enumerate one
   * source per transcript on disk; OpenCode's `sourcePathsForWatchEvent`
   * returns `[dbPath]`, so its whole `opencode.db` — holding an unbounded
   * number of sessions — is ONE source, and its harness row reads `1 / 1`.
   *
   * Named for the enumerated thing rather than for a file because the same two
   * populations are rendered for every harness. Calling them transcript FILES
   * made an OpenCode row announce one file found where a whole store was
   * scanned: a label asserting a unit its count does not have, which is the
   * defect this registry exists to remove.
   */
  ImportSource: "importSource",
} as const;
export type SessionCountUnit =
  (typeof SESSION_COUNT_UNIT)[keyof typeof SESSION_COUNT_UNIT];

/**
 * Whose work the population covers. The Dashboard offers this as an explicit
 * control (`InsightsScope.Me` / `Org`); the Sessions list does not, which is
 * part of why a Dashboard figure and a Sessions figure never had to agree.
 */
export const SESSION_COUNT_OWNER_SCOPE = {
  CurrentUser: "currentUser",
  Organization: "organization",
} as const;
export type SessionCountOwnerScope =
  (typeof SESSION_COUNT_OWNER_SCOPE)[keyof typeof SESSION_COUNT_OWNER_SCOPE];

/**
 * Which machine the population was observed on. This is the axis the Sessions
 * list footer currently hides: desktop local mode reads this Mac's SQLite store
 * while cloud mode reads the org over the bridge, and the rendered sentence is
 * identical either way.
 */
export const SESSION_COUNT_DEVICE_SCOPE = {
  ThisDevice: "thisDevice",
  AllSyncedDevices: "allSyncedDevices",
} as const;
export type SessionCountDeviceScope =
  (typeof SESSION_COUNT_DEVICE_SCOPE)[keyof typeof SESSION_COUNT_DEVICE_SCOPE];

/**
 * Which working directories the population spans. A count taken before any
 * workspace selection exists spans all of them.
 */
export const SESSION_COUNT_WORKSPACE_SCOPE = {
  CurrentWorkspace: "currentWorkspace",
  AllWorkspaces: "allWorkspaces",
} as const;
export type SessionCountWorkspaceScope =
  (typeof SESSION_COUNT_WORKSPACE_SCOPE)[keyof typeof SESSION_COUNT_WORKSPACE_SCOPE];

/**
 * The window the population is bounded by. `LiveQueueDepth` is not a window at
 * all and that is the point: the startup readiness bar's sync pair answers "how
 * much is moving right now", so it never responds to the toolbar's date range,
 * and a reader who assumes it does will try to reconcile it with a windowed
 * figure and fail.
 */
export const SESSION_COUNT_TIME_SCOPE = {
  AllTime: "allTime",
  SelectedWindow: "selectedWindow",
  LiveQueueDepth: "liveQueueDepth",
} as const;
export type SessionCountTimeScope =
  (typeof SESSION_COUNT_TIME_SCOPE)[keyof typeof SESSION_COUNT_TIME_SCOPE];

/**
 * WHICH stored timestamp a windowed population's range is measured against
 * (ISS-10604).
 *
 * {@link SESSION_COUNT_TIME_SCOPE} says only WHETHER a range applies. Two counts
 * can both be `SelectedWindow` over one date range and still cover different
 * rows, because the product draws a real split between windowing on last
 * activity and windowing on session start — `SESSIONS_SURFACE_DATE_FIELD`
 * against `SESSIONS_ANALYTICS_DATE_FIELD` on cloud
 * (`apps/api/app/agent-sessions/service/session-date-field.ts`), and
 * `SESSIONS_SURFACE_DATE_WINDOW_FIELD` against
 * `SESSIONS_ANALYTICS_DATE_WINDOW_FIELD` on desktop
 * (`apps/desktop/src/shared/session-date-window-contract.ts`). Without this axis
 * two such scope records are byte-identical, so `differingScopeAxes` returns an
 * EMPTY list for them: the contract can say the two counts differ and cannot
 * name one reason, and the disclosure derived from it has nothing to say.
 *
 * `NotWindowed` is a member rather than an absent field so a population cannot
 * be registered without answering. An optional field defaults silently, and the
 * next windowed count added would inherit an agreement it has not earned.
 *
 * A POPULATION'S BASIS IS WHAT IT SHIPS ON, not what a rollout will make it
 * (#7549 review, whitlockk). That rule is why the dashboard rows read `Started`
 * while `sessions-analytics-activity-window` was default-off, and it is the same
 * rule that moves them now: ISS-10541 retired that cohort, so last activity is
 * what the dashboard SHIPS on and there are no `Started` session-count
 * populations left to register.
 *
 * `Started` stays a member of the enum for the reads ISS-10604 recorded as
 * outside the ruling's reach — the export fold, heatmap, frustration,
 * lost-work, tokenops-waste, agent-pipeline and agents-spend — plus the Sessions
 * Analytics tab and the Agents section on both shells.
 *
 * Two of those DO render session counts on that basis, and neither has a row
 * here: `tokenops-waste.ts` emits a per-model `sessions` and `usdPerSession`,
 * and `LostWorkTotals` emits `sessionCount` / `sessionsByClass`. Each is on its
 * own page with no Sessions tile beside it, which is why they were never
 * registered — but "no session count uses this basis" would be false, so the
 * enum member is load-bearing rather than vestigial. A count added on that basis
 * must be able to say so, which an enum missing the member could not.
 */
export const SESSION_COUNT_DATE_BASIS = {
  /** No date column bounds this population, so there is no basis to differ on. */
  NotWindowed: "notWindowed",
  /** Bounded on when each session was last active — "active in this window". */
  LastActivity: "lastActivity",
  /** Bounded on when each session started — "belongs to the period it began in". */
  Started: "started",
} as const;
export type SessionCountDateBasis =
  (typeof SESSION_COUNT_DATE_BASIS)[keyof typeof SESSION_COUNT_DATE_BASIS];

/**
 * Every count in the product a reader could mistake for another. A new count
 * that renders a session or transcript total belongs here before it belongs on a
 * screen: the reconciliation table is exhaustive over this set, so adding a
 * member fails that module's test until its relationship to every existing
 * population has been stated.
 */
export const SESSION_COUNT_POPULATION = {
  /**
   * What "sessions" MEANS on this product (operator ruling 2026-09-17,
   * ISS-10541 / ISS-10543): sessions ACTIVE IN THE SELECTED WINDOW — bounded on
   * `lastActivityAt` over stable UTC calendar days, narrowed by whatever facet
   * selection the surface the count is read on carries. Read from the org over
   * the cloud.
   *
   * The facet clause is deliberately NOT an unconditional promise that every
   * site applies a filter set. It is the definition; a surface with no facet
   * control renders it with an empty selection, which is a correct reading of
   * the definition rather than an exception to it. The Sessions toolbar is the
   * only facet control over this population today, so every OTHER site that
   * renders it can only ever show the unfaceted count. A reader holding Sessions
   * facets and then reading one of those sites is the residual gap, and it
   * belongs to the ruling's still-unlanded consequence that the Dashboard honour
   * those facets too.
   *
   * The argument used to be carried by "the tour intro, which has none", and
   * ISS-10546 (#7513) retired that surface — so it is now made without the
   * example rather than resting on a site the registry no longer lists
   * (marisolashgrove review, PR #7527).
   *
   * An unbounded range ("all") sends no date bounds at all, so this population
   * collapses onto the whole corpus for that selection. That is the window doing
   * what the reader asked, not a second definition.
   *
   * ISS-10541 made the DASHBOARD KPI TILE render this population too, which is
   * what closed the 1,399-beside-1,290 the ticket was filed for. There is no
   * longer a `dashboardWindowedOrg` member holding "sessions STARTED in the
   * window, facets ignored": the tile's SQL windows on `lastActivityAt` like the
   * list's, unconditionally, so a separate member would be the registry
   * asserting a split the product no longer has. The tile has no facet control,
   * so it renders the empty selection — the case the paragraph above already
   * calls a correct reading rather than an exception.
   *
   * Named for the population and no longer for the list, because more than the
   * list renders it: the Sessions list footer, the Sessions metric card above
   * it, and now the Dashboard KPI tile. The desktop tour intro was one and is
   * not any more — ISS-10546 (#7513) retired that card in the same diff that
   * deleted its reconciliation rows, so naming it here would send a reader
   * looking for a site the product no longer has.
   */
  SessionsInWindowOrg: "sessionsInWindowOrg",
  /**
   * The same definition read from THIS machine's local store. A separate member
   * from the org spelling deliberately: desktop local mode renders the same
   * sentence for a strictly different population.
   *
   * Its `CurrentUser` owner axis is the store's scope, NOT a predicate:
   * `computeUtilization` is `COUNT(*) ... WHERE <window>` with no `user_id`
   * clause, and the operator ruled on 2026-09-20 (ISS-10413) that the SQL stays
   * as written. Adding the predicate would be a regression, not a tightening:
   * `claimUnownedSessionIdentity` refuses to stamp an owner onto a store that
   * holds a foreign `user_id` (`ForeignOwnerPresent`), which leaves THIS
   * reader's own pre-stamping rows at `user_id IS NULL` indefinitely, so
   * `user_id = <me>` would drop their own sessions out of their own KPI.
   *
   * The residual that ruling's "single-user store" premise does not cover
   * (whitlockk review): the same skip leaves a PREVIOUS account's rows in place, so
   * on a device that has changed hands this counts them too. Tracked as
   * ISS-10746; until it is answered, read this member as the device's corpus in
   * the window. {@link LocalSessionCorpus} carries the axis on the same terms.
   * Both notes were written against the retired `dashboardWindowedThisDevice`
   * and move here with the tile, because the SQL they describe is the tile's.
   */
  SessionsInWindowThisDevice: "sessionsInWindowThisDevice",
  /**
   * Every row in this machine's local `sessions` table, unfiltered and
   * unwindowed — the `32,793`. One site renders it: the Dashboard header's
   * "Analyzing locally · N sessions", which reports how much of the local
   * corpus has been parsed, not how much work happened in a window.
   *
   * "Parsed" does no filtering work — nothing in `countSqliteSessions`
   * restricts to successfully-parsed rows — which is why the population is
   * named for what it actually is.
   */
  LocalSessionCorpus: "localSessionCorpus",
  /**
   * Sessions this device has delivered to the cloud AND seen acked: the
   * numerator of the desktop startup readiness bar's sync progress, which draws
   * delivered over in-flight as its counter and percentage
   * (`syncCounterInputs` in `apps/desktop/src/renderer/startup-readiness/
   * use-startup-readiness.ts`; ISS-11668 ruling 10, operator, 2026-10-01).
   *
   * That bar is where the pair lives now. The Sessions sync progress banner that
   * first rendered it was deleted by #7291 and not brought back; ISS-11668's
   * ruling put the sync progress on the startup bar instead (ISS-10658).
   */
  CloudSyncDeliveredSessions: "cloudSyncDeliveredSessions",
  /**
   * The startup readiness bar's sync denominator: the high-water
   * `delivered + ready` this identity has reached. It EXCLUDES work parked
   * behind a backoff, auth gate, or transport outage, so reaching parity with
   * the numerator does not mean every local session has synced.
   *
   * There is no fallback pair beside these two any more. The deleted banner
   * also derived a numerator from departures out of the owed queue, for a main
   * process that predated the lane's own delivery counts; the startup bar
   * refuses that derivation (a withhold or a dead letter departs the queue with
   * nothing uploaded, so it cannot be called sessions synced). With no surface
   * drawing them, `cloudSyncQueueDepartedSessions` and
   * `cloudSyncKnownQueueSessions` were retired rather than left describing a
   * component that is not there, and `resolveSyncCounter` lost the derived
   * branch that produced them (ISS-10658).
   */
  CloudSyncInFlightSessions: "cloudSyncInFlightSessions",
  /**
   * IMPORT SOURCES the importer has SETTLED — reached a terminal outcome for
   * this pass, which `IngestProgressTracker` documents as "imported,
   * dead-lettered, or skipped".
   *
   * Named for the terminal outcome and NOT for a successful read (whitlockk and
   * codex review). Two reachable cases make "read" false here: a source
   * quarantined past its parse bound advances this counter without having been
   * read, and `settlePass` overwrites the numerator with the denominator when a
   * pass ends, so a pass that gave up on a third of its input still renders
   * parity. The count is right; only the verb was wrong.
   *
   * Named for a SOURCE and not a transcript file for the second half of the
   * same finding: one OpenCode source is the whole `opencode.db`, so a row
   * reading `1 / 1` would have announced one transcript file where a store of
   * many sessions was settled. See {@link SESSION_COUNT_UNIT.ImportSource}.
   */
  SettledImportSources: "settledImportSources",
  /**
   * IMPORT SOURCES the scan has FOUND — the `593`, and the harness row's
   * denominator. A separate population from the one above because it is still
   * GROWING while the import runs: harnesses register their totals as each
   * source scan finishes, so at `0 / 593` nothing has been settled yet and
   * calling the 593 "settled" would put the numerator's verb on the
   * denominator.
   */
  DiscoveredImportSources: "discoveredImportSources",
  /** Stale session rows the post-import maintenance pass re-derives. */
  MaintenanceRebuildSessions: "maintenanceRebuildSessions",
} as const;
export type SessionCountPopulation =
  (typeof SESSION_COUNT_POPULATION)[keyof typeof SESSION_COUNT_POPULATION];

/** What a population measures, along the axes that separate it from the rest. */
export type SessionCountPopulationScope = {
  readonly unit: SessionCountUnit;
  readonly owner: SessionCountOwnerScope;
  readonly device: SessionCountDeviceScope;
  readonly workspace: SessionCountWorkspaceScope;
  readonly time: SessionCountTimeScope;
  readonly dateBasis: SessionCountDateBasis;
};

/**
 * The structural fact behind each count. The rendered disclosure is DERIVED from
 * this record rather than written beside it, so a label cannot describe a scope
 * the count does not have.
 */
export const SESSION_COUNT_POPULATION_SCOPE: Record<
  SessionCountPopulation,
  SessionCountPopulationScope
> = {
  [SESSION_COUNT_POPULATION.SessionsInWindowOrg]: {
    unit: SESSION_COUNT_UNIT.Session,
    owner: SESSION_COUNT_OWNER_SCOPE.Organization,
    device: SESSION_COUNT_DEVICE_SCOPE.AllSyncedDevices,
    workspace: SESSION_COUNT_WORKSPACE_SCOPE.AllWorkspaces,
    time: SESSION_COUNT_TIME_SCOPE.SelectedWindow,
    dateBasis: SESSION_COUNT_DATE_BASIS.LastActivity,
  },
  [SESSION_COUNT_POPULATION.SessionsInWindowThisDevice]: {
    unit: SESSION_COUNT_UNIT.Session,
    owner: SESSION_COUNT_OWNER_SCOPE.CurrentUser,
    device: SESSION_COUNT_DEVICE_SCOPE.ThisDevice,
    workspace: SESSION_COUNT_WORKSPACE_SCOPE.AllWorkspaces,
    time: SESSION_COUNT_TIME_SCOPE.SelectedWindow,
    dateBasis: SESSION_COUNT_DATE_BASIS.LastActivity,
  },
  [SESSION_COUNT_POPULATION.LocalSessionCorpus]: {
    unit: SESSION_COUNT_UNIT.Session,
    owner: SESSION_COUNT_OWNER_SCOPE.CurrentUser,
    device: SESSION_COUNT_DEVICE_SCOPE.ThisDevice,
    workspace: SESSION_COUNT_WORKSPACE_SCOPE.AllWorkspaces,
    time: SESSION_COUNT_TIME_SCOPE.AllTime,
    dateBasis: SESSION_COUNT_DATE_BASIS.NotWindowed,
  },
  [SESSION_COUNT_POPULATION.CloudSyncDeliveredSessions]: {
    unit: SESSION_COUNT_UNIT.Session,
    owner: SESSION_COUNT_OWNER_SCOPE.CurrentUser,
    device: SESSION_COUNT_DEVICE_SCOPE.ThisDevice,
    workspace: SESSION_COUNT_WORKSPACE_SCOPE.AllWorkspaces,
    time: SESSION_COUNT_TIME_SCOPE.LiveQueueDepth,
    dateBasis: SESSION_COUNT_DATE_BASIS.NotWindowed,
  },
  [SESSION_COUNT_POPULATION.CloudSyncInFlightSessions]: {
    unit: SESSION_COUNT_UNIT.Session,
    owner: SESSION_COUNT_OWNER_SCOPE.CurrentUser,
    device: SESSION_COUNT_DEVICE_SCOPE.ThisDevice,
    workspace: SESSION_COUNT_WORKSPACE_SCOPE.AllWorkspaces,
    time: SESSION_COUNT_TIME_SCOPE.LiveQueueDepth,
    dateBasis: SESSION_COUNT_DATE_BASIS.NotWindowed,
  },
  [SESSION_COUNT_POPULATION.DiscoveredImportSources]: {
    unit: SESSION_COUNT_UNIT.ImportSource,
    owner: SESSION_COUNT_OWNER_SCOPE.CurrentUser,
    device: SESSION_COUNT_DEVICE_SCOPE.ThisDevice,
    workspace: SESSION_COUNT_WORKSPACE_SCOPE.AllWorkspaces,
    time: SESSION_COUNT_TIME_SCOPE.AllTime,
    dateBasis: SESSION_COUNT_DATE_BASIS.NotWindowed,
  },
  [SESSION_COUNT_POPULATION.SettledImportSources]: {
    unit: SESSION_COUNT_UNIT.ImportSource,
    owner: SESSION_COUNT_OWNER_SCOPE.CurrentUser,
    device: SESSION_COUNT_DEVICE_SCOPE.ThisDevice,
    workspace: SESSION_COUNT_WORKSPACE_SCOPE.AllWorkspaces,
    time: SESSION_COUNT_TIME_SCOPE.AllTime,
    dateBasis: SESSION_COUNT_DATE_BASIS.NotWindowed,
  },
  [SESSION_COUNT_POPULATION.MaintenanceRebuildSessions]: {
    unit: SESSION_COUNT_UNIT.Session,
    owner: SESSION_COUNT_OWNER_SCOPE.CurrentUser,
    device: SESSION_COUNT_DEVICE_SCOPE.ThisDevice,
    workspace: SESSION_COUNT_WORKSPACE_SCOPE.AllWorkspaces,
    time: SESSION_COUNT_TIME_SCOPE.AllTime,
    dateBasis: SESSION_COUNT_DATE_BASIS.NotWindowed,
  },
};

/** Every population, in declaration order, for exhaustive iteration. */
export const ALL_SESSION_COUNT_POPULATIONS: readonly SessionCountPopulation[] =
  Object.values(SESSION_COUNT_POPULATION);
