/**
 * @file session-count-population-display.ts
 * @description The user-facing COPY naming each session/transcript count's
 * population and scope (ISS-8474). Split from the sibling values module for the
 * reason ISS-5592 split `session-status-display.ts`: a bundle-sensitive
 * `"use client"` surface renders these, and it must be able to import a label
 * without pulling anything heavier in behind it.
 *
 * EVERY STRING HERE IS A PROPOSAL. The wording is the operator's call, and the
 * tests that police this module assert its STRUCTURE — that each population
 * carries a scope-derived disclosure, and that no two populations render the
 * same one — never the English. Rewriting any value below is a one-line edit
 * that leaves the suite green; that is the whole reason the strings live in one
 * map instead of at six call sites.
 *
 * The scope half of a disclosure is DERIVED from
 * `SESSION_COUNT_POPULATION_SCOPE` rather than written out beside the label, so
 * a label can never claim a scope its count does not have. That is the property
 * ISS-7905 was missing: the numbers were right, the scopes were real, and only
 * the sentence connecting them was absent.
 */
import {
  SESSION_COUNT_DATE_BASIS,
  SESSION_COUNT_DEVICE_SCOPE,
  SESSION_COUNT_OWNER_SCOPE,
  SESSION_COUNT_POPULATION,
  SESSION_COUNT_POPULATION_SCOPE,
  SESSION_COUNT_TIME_SCOPE,
  SESSION_COUNT_WORKSPACE_SCOPE,
  type SessionCountDateBasis,
  type SessionCountDeviceScope,
  type SessionCountOwnerScope,
  type SessionCountPopulation,
  type SessionCountTimeScope,
  type SessionCountWorkspaceScope,
} from "./session-count-population";

/** PROPOSED owner-scope phrase. */
export const SESSION_COUNT_OWNER_SCOPE_PHRASES: Record<
  SessionCountOwnerScope,
  string
> = {
  [SESSION_COUNT_OWNER_SCOPE.CurrentUser]: "yours only",
  [SESSION_COUNT_OWNER_SCOPE.Organization]: "everyone in your org",
};

/** PROPOSED device-scope phrase. */
export const SESSION_COUNT_DEVICE_SCOPE_PHRASES: Record<
  SessionCountDeviceScope,
  string
> = {
  [SESSION_COUNT_DEVICE_SCOPE.ThisDevice]: "on this Mac",
  [SESSION_COUNT_DEVICE_SCOPE.AllSyncedDevices]: "on all your devices",
};

/** PROPOSED workspace-scope phrase. */
export const SESSION_COUNT_WORKSPACE_SCOPE_PHRASES: Record<
  SessionCountWorkspaceScope,
  string
> = {
  [SESSION_COUNT_WORKSPACE_SCOPE.CurrentWorkspace]: "in this workspace",
  [SESSION_COUNT_WORKSPACE_SCOPE.AllWorkspaces]: "in every workspace",
};

/** PROPOSED time-scope phrase. */
export const SESSION_COUNT_TIME_SCOPE_PHRASES: Record<
  SessionCountTimeScope,
  string
> = {
  [SESSION_COUNT_TIME_SCOPE.AllTime]: "no date limit",
  [SESSION_COUNT_TIME_SCOPE.SelectedWindow]: "in the selected date range",
  // Not a window, and deliberately not "right now" either: the denominator is a
  // HIGH-WATER mark that retains work parked after it was counted ready and
  // only snaps back on caught-up, so it is not an instantaneous depth. What is
  // true of it is that it covers this sync run and never a date range.
  [SESSION_COUNT_TIME_SCOPE.LiveQueueDepth]: "so far this sync run",
};

/**
 * PROPOSED date-basis phrase (ISS-10604).
 *
 * `NotWindowed` is deliberately EMPTY and {@link describeSessionCountScope}
 * drops empty clauses. A count no date range bounds has no column to name, and
 * a phrase here would sit beside "no date limit" saying the same thing again.
 * The emptiness is load-bearing rather than a gap: it is what keeps the one
 * population rendered today (the import splash harness row, all-time) wording
 * itself exactly as it did before this axis existed.
 */
export const SESSION_COUNT_DATE_BASIS_PHRASES: Record<
  SessionCountDateBasis,
  string
> = {
  [SESSION_COUNT_DATE_BASIS.NotWindowed]: "",
  [SESSION_COUNT_DATE_BASIS.LastActivity]: "dated by last activity",
  [SESSION_COUNT_DATE_BASIS.Started]: "dated by session start",
};

/**
 * PROPOSED name for each population. These are the words ISS-7905 found missing
 * — each one says what is being counted, leaving the scope to the derived
 * phrase so the two halves cannot contradict each other.
 */
export const SESSION_COUNT_POPULATION_LABELS: Record<
  SessionCountPopulation,
  string
> = {
  // The list and Dashboard populations SHARE a label with their opposite-scope
  // twin. A "Local " prefix was the first attempt and it marks the wrong one:
  // the difference is two axes (whole org becomes just you AND all devices
  // becomes this Mac), the reader never sees both spellings to contrast them,
  // and the broader claim would end up the unmarked one. The derived scope
  // clause separates them precisely and cannot drift, which is why the
  // distinctness guard is over the COMPOSED disclosure and not the noun.
  [SESSION_COUNT_POPULATION.SessionsInWindowOrg]:
    "Sessions matching your filters",
  [SESSION_COUNT_POPULATION.SessionsInWindowThisDevice]:
    "Sessions matching your filters",
  // The two "Sessions started" nouns that sat here belonged to the retired
  // dashboard populations, and the noun is why they could not simply be
  // repointed: it asserted the session-START basis, which ISS-10541 removed from
  // every count this registry lists. The tile now renders the population above.
  // Not "on this device": the scope clause already says where, and a device
  // hardcoded here would go on asserting it after the scope record moved.
  [SESSION_COUNT_POPULATION.LocalSessionCorpus]: "Sessions found",
  [SESSION_COUNT_POPULATION.CloudSyncDeliveredSessions]: "Sessions uploaded",
  // Not "queued": the total excludes work parked behind a backoff, an auth
  // gate, or a transport outage, so it is not the backlog. "Ready" is the field
  // it is built from, and "so far" says it can still grow mid-run.
  [SESSION_COUNT_POPULATION.CloudSyncInFlightSessions]:
    "Sessions ready to upload so far",
  // Deliberately NOT "read": the counter advances on any TERMINAL outcome, so a
  // quarantined source raises it without having been read, and `settlePass`
  // forces it to the total when a pass ends short.
  //
  // Deliberately "sources" and not "transcript files" either: the same two
  // labels are rendered for EVERY harness row, and one OpenCode source is the
  // whole `opencode.db`, so a `1 / 1` there is one store and not one file.
  [SESSION_COUNT_POPULATION.SettledImportSources]:
    "Import sources finished (imported, skipped, or given up on)",
  [SESSION_COUNT_POPULATION.DiscoveredImportSources]: "Import sources found",
  [SESSION_COUNT_POPULATION.MaintenanceRebuildSessions]: "Sessions rebuilt",
};

/**
 * The scope half of a disclosure, composed from the population's own scope
 * record. Order is widest-to-narrowest — device, then workspace, then time, then
 * the date basis that refines it — so two counts that differ on only one axis
 * differ at a predictable position rather than somewhere in the middle of a
 * sentence.
 */
export const describeSessionCountScope = (
  population: SessionCountPopulation
): string => {
  const scope = SESSION_COUNT_POPULATION_SCOPE[population];
  return [
    SESSION_COUNT_OWNER_SCOPE_PHRASES[scope.owner],
    SESSION_COUNT_DEVICE_SCOPE_PHRASES[scope.device],
    SESSION_COUNT_WORKSPACE_SCOPE_PHRASES[scope.workspace],
    SESSION_COUNT_TIME_SCOPE_PHRASES[scope.time],
    SESSION_COUNT_DATE_BASIS_PHRASES[scope.dateBasis],
  ]
    .filter((phrase) => phrase.length > 0)
    .join(", ");
};

/**
 * The full disclosure for one count: what it counts, and over what. This is the
 * string a surface renders beside its number, and it is what the ISS-8474
 * distinctness guard requires to be unique across populations — a reader who
 * can see two counts at once must be able to tell which is which.
 */
export const describeSessionCountPopulation = (
  population: SessionCountPopulation
): string =>
  `${SESSION_COUNT_POPULATION_LABELS[population]} (${describeSessionCountScope(population)})`;
