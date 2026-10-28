/**
 * @file session-date-window-contract.ts
 * @description WHICH session timestamp a desktop `startDate`/`endDate` window is
 * measured against — the vocabulary, and which basis each read surface uses.
 *
 * ISS-10604 made the vocabulary a value the renderer threaded across IPC with
 * each insights read. ISS-10541 removed that argument, so the insights basis
 * is no longer a caller's choice.
 * The SQL and hydrated-fold resolvers that turn one of these into a predicate
 * stay in `main/agent-sync/session-date-window.ts`. That module does NOT
 * re-export what moved — Biome's `noBarrelFile` refuses the shim — so every
 * importer of the names below points here directly.
 */

/** Which session timestamp a `startDate`/`endDate` window is measured against. */
export const SessionDateWindowField = {
  /** Genuine activity — "active in this window". */
  LastActivity: "lastActivityAt",
  /** Session start — "started in this window". */
  Started: "startedAt",
} as const;
export type SessionDateWindowField =
  (typeof SessionDateWindowField)[keyof typeof SessionDateWindowField];

/**
 * The field the whole Sessions SURFACE windows on — the list AND the summary
 * cards (usage/KPI) above it AND the count-only badge read. For a given range
 * these are ONE cohort: the cards summarize exactly the population the table
 * lists, so they must bound on the same timestamp or the cards reconcile
 * against a different set than the table shows.
 *
 * `lastActivityAt` is the correct basis because it is the field the list is
 * ORDERED by (FEA-2180): bounding on start time while sorting by activity drops
 * recently-active sessions that started before the window even though they rank
 * at the top. The denormalized `sessions.last_activity_at` is
 * `COALESCE(MAX(events.created_at), <started_at floor>)`
 * (`recomputeSessionLastActivityAt`), so it already folds the started-at floor
 * in and never falls below the start — verified on a 3,154-session local
 * corpus, where zero rows have `last_activity_at < started_at`. That is why the
 * window can only ever ADD the started-before/active-inside rows, never drop a
 * row the started-at basis included.
 */
export const SESSIONS_SURFACE_DATE_WINDOW_FIELD =
  SessionDateWindowField.LastActivity;

/**
 * The local Insights agents-spend read retains its session-start window.
 * Sessions list, usage, and analytics instead use the surface last-activity
 * window; this constant is not a cloud Sessions analytics counterpart.
 */
export const SESSIONS_ANALYTICS_DATE_WINDOW_FIELD =
  SessionDateWindowField.Started;
