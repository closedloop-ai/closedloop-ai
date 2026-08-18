/**
 * Agents workspace API types (T-1.1).
 *
 * Canonical shared DTOs for the Agents workspace slice, consumed by BOTH the
 * web surface (`apps/app`) and the desktop renderer. All enums follow the
 * repo-sanctioned `{...} as const` + `(typeof X)[keyof typeof X]` idiom —
 * never TypeScript `enum`. Pattern mirrors `packages/api/src/types/branch.ts`.
 *
 * Sourced from `apps/prototypes/app/p/agents/mock.ts` and `detail-data.ts`
 * field shapes — but authored clean here; NO import of prototype code.
 *
 * @repo/api MUST NOT import from @repo/app or apps/prototypes.
 */

import type { AgentComponentInvocationReadPage } from "./agent-component-invocation.ts";
import type { AgentSessionListItem } from "./agent-session.js";
import type { CohortDeliveryMetrics } from "./analytics.js";
import type { BranchRow } from "./branch.js";
import {
  type ComponentSourceKind,
  type ComponentSourceProvenance,
  resolveComponentSource,
} from "./component-source.ts";

// --- Inventory read caps ---

/**
 * Upper bound on the org agent-component inventory a single list call may
 * return, across every surface. The org inventory is a bounded, deduped set;
 * capping the working set keeps a pathological org (tens of thousands of raw
 * rows) from OOMing or timing out the request while comfortably exceeding any
 * realistic distinct-component count.
 *
 * This is the ONE source of truth for the 5000 cap — import it everywhere
 * instead of re-declaring the literal:
 *  - `apps/api/app/agent-components/validators.ts` — the max `limit` a caller
 *    may request (`AGENT_COMPONENT_LIST_MAX_LIMIT`).
 *  - `apps/api/app/agent-components/service.ts` — the cloud DB read cap
 *    (`MAX_ORG_INVENTORY_ROWS`).
 *  - `apps/desktop/src/main/shared-agent-components-api.ts` — the local-source
 *    `limit` clamp, so the shared workspace's full-inventory fetch is not
 *    truncated on desktop.
 *  - `packages/app/agents/lib/agents-timeframe.ts` — the workspace's
 *    single-page fetch limit (`AGENT_INVENTORY_FETCH_LIMIT`).
 */
export const AGENT_COMPONENT_INVENTORY_CAP = 5000;

/**
 * ISS-5464: how many session summaries a component detail's `sessionsTab` may
 * carry.
 *
 * This is a PAYLOAD bound, not a truth bound. The detail's `sessions` field is
 * the true, uncapped session count and stays authoritative; this only bounds how
 * many individual `AgentSessionListItem` records travel with the response.
 *
 * The value is the number of rows the Sessions tab actually renders
 * (`AGENTS_PAGE_SIZE` in `packages/app/agents/lib/agents-timeframe.ts`, held
 * equal by `detail-sessions-tab-truncation-total.test.tsx` — the lockstep guard
 * lives on the `packages/app` side because that is the only side that may
 * import both constants). Before this bound the read shipped up to
 * `MAX_DETAIL_SESSION_IN_IDS` (1000) fully-enriched session summaries — measured
 * at 1_656_281 of 2_185_823 response bytes for a component with 1218 sessions —
 * and the tab then discarded 95% of them in a `slice(0, 50)`.
 *
 * The rows are chosen by `lastActivityAt DESC` in SQL, so the retained slice is
 * the recency head of the session-id set the detail read saw. The tab's notice
 * deliberately does NOT claim "most recent" — `resolveDetailSessionTabs` slices
 * that id set to `MAX_DETAIL_SESSION_IN_IDS` from an unordered group-by, so above
 * 1000 sessions it is the recency head of an arbitrary subset.
 */
export const AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS = 50;

// --- Core inventory enums ---

/**
 * The kind of harness component an inventory entry represents. This is the
 * canonical const-object for the `componentKind` DB column on `AgentComponent`
 * (cloud) and `agent_components` (desktop); the values are the exact string
 * literals persisted to that column. Import this everywhere — do not declare a
 * second discriminator with the same values.
 *
 * 10 values: `Plugin` replaces the deprecated "pack" vocabulary (there is no
 * `Pack`/`pack` value; desktop `agent_packs` rows project to
 * `componentKind=plugin`), and `Tool` (FEA-3048) is the first-class,
 * OBSERVABLE-ONLY kind for built-in CLI tools (Read/Grep/Glob/Edit/Bash …).
 * The desktop rollup (`insertToolAndMcpUsage`) has always written non-`mcp__`
 * tool events as `component_kind='tool'`; before FEA-3048 this kind was absent
 * from the enum, so `toKind()` coerced it to `Config` ("Memory & config") — the
 * bug this member fixes. `Tool` renders as its own kind but is NOT
 * admin-distributable via the catalog/promote flow (tools are observable, not
 * distributable — like `Mcp`).
 *
 * `Orchestration` (FEA-2642) is the sibling observable-only kind for
 * agent-runtime / harness tools (ToolSearch, Monitor, Workflow, ExitPlanMode,
 * ScheduleWakeup, Cron*, …). The parser classifies these `kind:"harness"`
 * (see `NormalizedToolKind`); the desktop rollup routes them to
 * `component_kind='orchestration'` so they no longer bucket into `Tool`
 * alongside built-in IO tools. NOT named `harness` — that string is the vendor
 * axis (claude|codex|both, see `Harness`) and already a column on this row.
 * Observable, not distributable — same treatment as `Tool`/`Mcp`.
 *
 * Kept as a const-object enum (never TypeScript `enum`) to follow the
 * repo-sanctioned pattern (see `branch.ts`).
 */
export const AgentComponentKind = {
  Subagent: "subagent",
  Command: "command",
  Skill: "skill",
  Workflow: "workflow",
  Mcp: "mcp",
  Hook: "hook",
  Config: "config",
  Plugin: "plugin",
  Tool: "tool",
  Orchestration: "orchestration",
} as const;
export type AgentComponentKind =
  (typeof AgentComponentKind)[keyof typeof AgentComponentKind];

/**
 * Which AI harness a component targets.
 * Matches the prototype's `Harness` const object.
 *
 * `Opencode` (ISS-4386) is a real individual harness the desktop collectors now
 * discover components for — OpenCode agents/commands live in the OpenCode config
 * home and are attributed `harness=opencode`. It is added to the display
 * contract (not just passed through as an out-of-contract string) so the
 * exhaustive `Record<Harness, …>` label/facet maps and the individual-harness
 * filter options include it rather than silently coercing it to Claude.
 * `Both` stays the "used across harnesses" synthetic collapse, NOT a per-harness
 * value a user would filter on.
 */
export const Harness = {
  Claude: "claude",
  Codex: "codex",
  Opencode: "opencode",
  Both: "both",
} as const;
export type Harness = (typeof Harness)[keyof typeof Harness];

/**
 * Where a component came from.
 * `Pack` = installed from a marketplace; `Repo` = checked into a source repo;
 * `Local` = builder-specific; `Server` = the MCP server that exposes the tool;
 * `Scope` = the cascade level of a config file.
 */
export const SourceType = {
  Pack: "pack",
  Repo: "repo",
  Local: "local",
  Server: "server",
  Scope: "scope",
} as const;
export type SourceType = (typeof SourceType)[keyof typeof SourceType];

// ISS-5009 `ComponentScope` moved to its own leaf module `./component-scope.ts`
// (ISS-6232 review). `component-source.ts` needs the `Plugin` member to keep an
// installed plugin off the `organic` terminal, and this file imports
// `component-source.ts`, so leaving the const here would have made the shared
// derivation import this whole module back — a cycle, and a fat one: the desktop
// reader deliberately keeps `component-source.ts` a leaf so the runtime import
// stays out of the pglite boot path. Import it from `./component-scope.ts`.

// --- Sort / group / metric enums (list-surface controls) ---

/**
 * Columns by which the inventory table can be sorted.
 */
export const AgentComponentSortKey = {
  Name: "name",
  Type: "type",
  Metric: "metric",
  // FEA-4098 (Slice 3): `Owner` is gone — the single git-attributed owner was
  // replaced by the `collaborators` authors people-set (discoverer + editors of
  // the version's `DefinitionVersion` lineage), which is a set, not a scalar
  // sort key. There is intentionally no `Collaborators` sort key: sorting a
  // people-set by its first member is arbitrary, so the column is unsortable.
  Source: "source",
  Harness: "harness",
  Invocations: "invocations",
  Sessions: "sessions",
} as const;
export type AgentComponentSortKey =
  (typeof AgentComponentSortKey)[keyof typeof AgentComponentSortKey];

/**
 * Sort direction for the inventory table.
 */
export const AgentComponentSortDir = {
  Asc: "asc",
  Desc: "desc",
} as const;
export type AgentComponentSortDir =
  (typeof AgentComponentSortDir)[keyof typeof AgentComponentSortDir];

/**
 * Grouping dimensions available on the inventory table.
 */
export const AgentComponentGroupBy = {
  None: "none",
  Type: "type",
  // FEA-4098 (Slice 3): group by the authors people-set — a component lands in a
  // group per distinct collaborator (discoverer + editors), replacing the
  // single-owner grouping. A component with several authors appears under each.
  Collaborators: "collaborators",
  Harness: "harness",
} as const;
export type AgentComponentGroupBy =
  (typeof AgentComponentGroupBy)[keyof typeof AgentComponentGroupBy];

/**
 * Which efficiency metric the value column displays.
 *
 * ISS-4667: `LocPerDollar` is the canonical code-efficiency mode — LOC/$, lines
 * per dollar, higher is better. The KLOC-unit `kloc-per-dollar` mode and the
 * INVERTED `dollar-per-kloc` mode are both gone: one metric, one unit, one
 * orientation on every surface. Persisted views carrying either legacy value
 * migrate to `LocPerDollar` (see `use-agent-components-view-state.ts`).
 */
export const AgentMetricMode = {
  LocPerDollar: "loc-per-dollar",
  ValueIndex: "value-index",
} as const;
export type AgentMetricMode =
  (typeof AgentMetricMode)[keyof typeof AgentMetricMode];

/**
 * ISS-4667: persisted `metricMode` values that no longer exist, mapped to the
 * canonical mode they become on restore. `kloc-per-dollar` was the same metric
 * in the wrong unit and `dollar-per-kloc` was its inverted variant, so both land
 * on {@link AgentMetricMode.LocPerDollar}. Consumed by the saved-view parser so
 * a stored legacy value migrates instead of failing validation and discarding
 * the user's whole saved view (sort, columns, order) along with it.
 */
export const LEGACY_AGENT_METRIC_MODES: Readonly<
  Record<string, AgentMetricMode>
> = {
  "kloc-per-dollar": AgentMetricMode.LocPerDollar,
  "dollar-per-kloc": AgentMetricMode.LocPerDollar,
};

// --- Data shapes ---

/**
 * A single agent component inventory row (the list surface render shape).
 * Extends the prototype `AgentComponent` with `owner` and `collaborators`
 * populated server-side (no runtime hash derivation needed on the client).
 */
export type AgentComponent = {
  /**
   * The database UUID of the canonical `AgentComponent` cloud record for this
   * org-level identity. NOT a colon-slug — the stub data-source may emit a
   * temporary slug during development, but the real HTTP source always returns
   * the DB UUID here. Consumers must treat this as an opaque string.
   */
  id: string;
  /**
   * Org-level identity slug (`${componentKind}::${normalizedKey}`, URL-encoded
   * on the wire). This — NOT `id` — is the key the detail
   * (`GET /agent-components/{slug}`) and token-trend endpoints resolve by, and
   * the value callers must use to build the detail-page href. Distinct from
   * `id`, which is the (surface-specific) row identity: the DB UUID on the cloud
   * inventory path (needed by the admin promote flow) and the slug itself on the
   * desktop / orphan paths. Always populated by every real data source.
   */
  slug: string;
  name: string;
  kind: AgentComponentKind;
  sourceType: SourceType;
  /** Display label for the Source column (pack name, repo, server, or scope). */
  source: string;
  /**
   * ISS-5009 — the HONEST Source projection, when the producer computed one.
   *
   * `source` above is a legacy fallback chain that ends at the component's own
   * identity key, so a component with no real provenance renders the same string
   * the Component column already shows. This field says whether that happened
   * and, when real provenance exists, carries it together with the source type it
   * actually came from (derived in ONE ordered switch, so the value and the type
   * can never describe different branches).
   *
   * Additive + optional: omitted by a producer that predates ISS-5009, so a
   * reader MUST treat absence as "assume `source`/`sourceType` are meaningful"
   * (today's behavior). `source` and `sourceType` above are deliberately NOT
   * changed and NOT nullable — shared client code sorts and builds facets with an
   * unguarded `.localeCompare` on `source`, and that code ships inside installed
   * desktop bundles that read this cloud DTO, so emitting a null there would
   * throw in an older build.
   */
  honestSource?: AgentComponentHonestSource;
  harness: Harness;
  /** Usage metrics — null for configured-only kinds with no reliable logs. */
  invocations: number | null;
  sessions: number | null;
  /**
   * ISS-4667: LOC/$ — lines changed per dollar across the sessions that used
   * this component. Raw lines, no divide-by-1000, higher is better. `null` when
   * the ratio is genuinely undefined (no cost, no measurable lines) or the
   * component's kind has no reliable per-component attribution
   * ({@link isLocPerDollarVerifiableKind}) — never a fabricated `0`.
   */
  locPerDollar: number | null;
  /**
   * @deprecated ISS-4667 — the KLOC-unit predecessor of {@link locPerDollar}.
   * Present ONLY so a producer that predates ISS-4667 is still understood on
   * read (resolve via `resolveLocPerDollar`, which scales it into LOC/$). Never
   * emitted by this repo's producers and never rendered directly.
   */
  klocPerDollar?: number | null;
  trend: readonly number[];
  /**
   * FEA-4098 (Slice 3): the AUTHORS of this exact version — the discoverer (first
   * observer of the version's `DefinitionVersion` hash in the org) followed by
   * every later distinct editor, derived from the `DefinitionVersionEditor`
   * lineage. Discoverer-first, deduped by user, display names. Replaces the
   * single git-attributed `owner`. Empty when the row has no linked
   * `DefinitionVersion` (a legacy/event-minted row with no fingerprint, or a
   * version predating lineage capture) — never fabricated.
   *
   * Distinct from the version's USERS (who ran this version), which lands in a
   * separate "Used By" column in a later slice (FEA-4098 Slice 4).
   */
  collaborators: readonly string[];
  /**
   * FEA-4098 — DEPRECATED additive compatibility alias for `collaborators`.
   *
   * The single git-attributed Owner was replaced by the `collaborators` authors
   * people-set, and no current in-repo consumer reads this field. It is emitted
   * additively — the DISCOVERER (first entry of `collaborators`), omitted when
   * there are no authors — purely so a version-skewed older client that still
   * reads `owner` receives a valid display string instead of `undefined` (which
   * an old `initialsOf(owner)` path would throw on). New code MUST read
   * `collaborators`; do not reintroduce a single-owner UI. Omitted (never
   * `null`) when the version has no linked authors, so absence stays skew-safe.
   */
  owner?: string;
  /**
   * FEA-3982 (Slice 2) — the exact-version fingerprint this row was keyed on: the
   * `DefinitionVersion.definitionHash` when linked, else the coarse
   * `AgentComponent.contentHash`. Two rows that share a `name`/`slug` but differ
   * in bytes carry DIFFERENT `versionId`s, so the surface can tell whether two
   * people run the same version or two different file contents of the same name.
   * Additive + optional: absent (omitted) for a legacy/event-minted row with no
   * captured definition, and for version-skewed cloud responses that predate this
   * field — a reader MUST treat absence as "unversioned / name-only".
   */
  versionId?: string;
  /**
   * FEA-3982 (Slice 2) — the short (8-hex) display badge derived from
   * {@link versionId}. Present exactly when `versionId` is; omitted otherwise.
   */
  fingerprint?: string;
  /**
   * FEA-4267 — the number of distinct versions collapsed into this canonical
   * catalog FAMILY row. The list endpoint groups a component's per-version
   * buckets (which back per-version analytics on the detail page) into ONE row
   * per logical component; this is how many versions folded in. Present
   * (additive, optional) ONLY when the family collapsed more than one version, so
   * a surface can render a quiet "N versions" signal; omitted (never `1`, never
   * `null`) for a single-version component and on version-skewed responses that
   * predate this field — a reader MUST treat absence as "single / unversioned".
   * When present, `versionId`/`fingerprint` are omitted (a multi-version row does
   * not badge a single fingerprint); per-version detail lives on the detail page.
   */
  versionCount?: number;
  /**
   * ISS-5534 — the PACK (plugin) identities this row participates in, so a
   * consumer can tell a plugin's rolled-up total apart from the specific child
   * rows it was rolled up FROM. Read it by KIND:
   *
   *  - on a `plugin` row: the pack ids its `invocations`/`sessions` were summed
   *    over — `pluginPackCandidates`, i.e. every folded `packId` plus the
   *    plugin's own key (a plugin's `packId` normally equals its `componentKey`).
   *    Always at least one entry for a keyed plugin, which is what lets a reader
   *    detect that the producer speaks this field at all.
   *  - on any other kind: the pack(s) the row itself belongs to. Omitted for a
   *    standalone component that belongs to no pack — which is a real answer,
   *    NOT the skew case below.
   *
   * Additive and optional. A version-skewed producer that predates the field
   * omits it EVERYWHERE, including on plugin rows, so a reader distinguishes the
   * two cases by looking at the PLUGIN row: an absent `packIds` there means "this
   * producer cannot tell me parentage" and the reader must degrade to a
   * population-wide heuristic (which may under-count) rather than to an
   * over-count. An absent `packIds` on a non-plugin row from a producer that DID
   * populate the plugin's is simply a component with no pack.
   *
   * Never `null` and never `[]` — omitted instead, so absence stays skew-safe.
   */
  packIds?: string[];
  /**
   * IDs of all compute targets (devices) in the org that have observed this
   * component. Populated by the list endpoint (org-level dedup join); empty
   * array if the component has only been seen by an unregistered target.
   */
  computeTargetIds: string[];
  /**
   * ISO timestamp of when the component was first observed org-wide.
   *
   * May be `""` — nothing backing this identity recorded a timestamp. Parse
   * defensively: `new Date("")` is `Invalid Date`.
   *
   * Always an observation, never the time the response was generated (ISS-5577).
   * This holds on EVERY producer: the list and both detail paths derive it from
   * real evidence and emit `""` when their source rows carry none, so a
   * null-timestamp identity reads as unknown on the list and on its own detail
   * rather than as "first seen just now" in one place and unknown in the other.
   */
  firstSeenAt: string;
  /**
   * ISO timestamp of the most recent org-wide observation; `""` when unknown,
   * under the same every-producer guarantee as
   * {@link AgentComponent.firstSeenAt}.
   */
  lastSeenAt: string;
  /**
   * ISO timestamp of the component's most recent ACTUAL invocation org-wide —
   * the max `AgentComponentSessionUsage.lastInvokedAt` across all of its usage
   * rows. Unlike `lastSeenAt` (an inventory-observation time the pack scanner
   * refreshes to `now()` on every sync for still-installed components), this is
   * a real usage-recency signal. Absent (`undefined`) when the component has no
   * usage rows at all (configured-only kinds, or never invoked). Consumers that
   * need "recently active" MUST key off this field, not `lastSeenAt`
   * (FEA-3179 / FEA-3160).
   */
  lastInvokedAt?: string;
};

/**
 * Query filters accepted by the list endpoint and the data-source `list()` port.
 */
export type AgentComponentQueryFilters = {
  kinds?: readonly AgentComponentKind[];
  /**
   * FEA-4098 (Slice 3): filter to components authored by (collaborator display
   * name of) this person — matched against the {@link AgentComponent.collaborators}
   * authors set. Replaces the old single-`owner` filter.
   */
  collaborator?: string;
  source?: string;
  harness?: Harness;
  search?: string;
  limit?: number;
  offset?: number;
  /**
   * Inclusive lower bound (ISO-8601 timestamp) for the USAGE time window. When
   * present, the list endpoint scopes every usage lane (invocations, sessions,
   * plugin child-usage rollup, orphan usage) to
   * `AgentComponentSessionUsage.lastInvokedAt >= startDate` and drops components
   * with zero in-window usage. Absent ⇒ all-time inventory view (unchanged).
   *
   * This is intentionally the USAGE observation time, not the inventory
   * `lastSeenAt` (the pack scanner sets `lastSeenAt = now()` on every sync for
   * still-installed components, so `lastSeenAt`-based windowing is a no-op).
   */
  startDate?: string;
  /**
   * FEA-3178: inclusive UPPER bound (ISO-8601 timestamp) for the USAGE time
   * window, on the SAME `lastInvokedAt` basis as `startDate`. When present, the
   * list endpoint additionally scopes every usage lane to
   * `AgentComponentSessionUsage.lastInvokedAt <= endDate`. Absent ⇒ unbounded
   * above (unchanged). Paired with `startDate` to fetch the PRECEDING equivalent
   * window (`startDate = prevStart`, `endDate = prevEnd`) for the
   * period-over-period delta on the Agents summary cards.
   */
  endDate?: string;
};

/**
 * Paginated list response from the data-source `list()` method.
 */
export type AgentComponentListResponse = {
  items: AgentComponent[];
  total: number;
  hasMore?: boolean;
};

/**
 * Metadata about a component's definition file (path, format, model, etc.).
 * Used by the Properties panel and read-only Prompt panel on the detail page.
 */
export type AgentComponentProperties = {
  /** Filesystem or config path of the definition file. */
  path: string;
  /** Source format of the definition (md, json, yml, bash, toml). */
  format: string;
  /** AI model override, if specified in the definition frontmatter. */
  model?: string;
  /** Explicit allow-list of tools the component may invoke. */
  allowedTools?: readonly string[];
  /** MCP server connection info, present for Mcp kind only. */
  server?: {
    url: string;
    auth: string;
    health: string;
  };
  /** Maximum concurrent invocations (Workflow kind). */
  maxConcurrency?: number;
  /** Sub-agents this workflow orchestrates (Workflow kind). */
  orchestrates?: readonly string[];
};

/**
 * One content-addressed revision of a component's definition (FEA-2923
 * versioning). A version's identity on the wire is `(component, hash)` — NOT the
 * invoking owner: the same file bytes are one version no matter who ran it.
 * Ordered newest-first on the detail response.
 *
 * ISS-6232 (review): {@link ComponentVersion.source} is deliberately NOT part of
 * that reported identity. The STORED desktop/cloud revision row still carries a
 * `source` dimension (the `""` sentinel on every row ever written), and this
 * change does not touch it — re-keying it would fork every retained revision.
 * The reported `source` is the owning COMPONENT's origin, so it may sharpen as
 * observers accumulate (`unknown` → `gstack` once a second machine contributes a
 * pack id) without minting a revision. That is correct precisely BECAUSE it is
 * not an identity dimension of the reported version.
 */
export type ComponentVersion = {
  /** sha256 of the definition text — the version identity + selector value. */
  hash: string;
  /**
   * F1 (FEA-3290 / PRD-527) provenance-FREE exact fingerprint of this revision
   * (`computeDefinitionHash`, Slice-1 contract). Distinct from the legacy raw
   * full-file sha256 in `hash`: the fingerprint preserves meaningful
   * whitespace/case and EXCLUDES all provenance. Optional — present only once
   * the coarse revision is linked to its `DefinitionVersion` (during the
   * pre-backfill window a still-unlinked revision surfaces via `hash` alone, so
   * no version disappears). The shipped Prompt-panel version selector keys off
   * `hash`, so this is additive; consumers wanting the exact identity read it.
   */
  definitionHash?: string;
  /**
   * F1: the `NORMALIZER_CONTRACT_VERSION` under which `definitionHash` was
   * produced, so a stored fingerprint is never reinterpreted under a later rule
   * set. Present only alongside `definitionHash`.
   */
  normalizerContractVersion?: number;
  /**
   * The origin of the COMPONENT this revision belongs to, resolved across every
   * observer of the identity — NOT a per-revision fact.
   *
   * ISS-6232: NEVER an empty string. It is the pack name, the repository, or one
   * of the explicit `ComponentSourceToken` terminals (`component-source.ts`):
   * `organic` for a component authored on the machine it was observed on,
   * `unknown` when no provenance was captured. The two used to collapse into the
   * same `""`, which made the source dimension of the identity resolve to a
   * constant and made the field assert every component's origin was unknown.
   *
   * The scope is stated deliberately. Nothing has ever recorded a source PER
   * REVISION — the stored column is the `""` sentinel on every row — so this is
   * the identity's origin folded across its inventory rows
   * (`unionComponentSourceProvenance`) and applied to the whole history. A
   * revision therefore reports the most specific origin ANY observer of the
   * component saw, which is what lets "I riffed superpowers' skill" resolve at
   * all; it does not claim that this particular revision was captured from that
   * pack. Do not read it as evidence about one revision's capture site.
   */
  source: string;
  /**
   * ISS-6232 (review): which BRANCH produced {@link ComponentVersion.source} —
   * a pack id, a repository, or one of the two explicit terminals.
   *
   * Pack ids are free strings, so a pack literally named `organic` or `unknown`
   * is byte-identical to a terminal; this is the discriminator that tells them
   * apart, instead of reserving names a marketplace is free to use. Additive and
   * OPTIONAL: omitted for a revision whose `source` came from a persisted label
   * written before the derivation existed (which branch would have produced it
   * is unknowable, so it is not guessed), and absent entirely from older
   * responses — a consumer must treat a missing value as "not stated" and fall
   * back to reading `source` as an opaque label.
   */
  sourceKind?: ComponentSourceKind;
  /** Source format of this revision (md, json, yml, …). */
  format: string;
  /** ISO timestamp the content of this revision was first observed. */
  createdAt: string;
  /** True for the revision matching the component's current content hash. */
  isCurrent: boolean;
  /** The definition text for this revision (the Prompt panel content). */
  content: string;
};

/**
 * Surface-neutral revision row consumed by {@link buildComponentVersions}. Both
 * the cloud read (`agent_component_versions` via Prisma) and the desktop read
 * (the same table via raw SQL) adapt their own row into this shape — the caller
 * pre-resolves `createdAt` (cloud: `firstSeenAt`; desktop: `first_seen_at ??
 * last_seen_at`) so the shared mapper stays a pure transform with no per-surface
 * fallback logic.
 */
export type ComponentVersionRow = {
  /** Content hash — the revision identity. */
  contentHash: string;
  /**
   * F1 (FEA-3290) provenance-free exact fingerprint, when the revision has been
   * linked to its `DefinitionVersion`. Passed through to `ComponentVersion`
   * unchanged. Optional so the desktop reader (which does not yet supply it)
   * compiles unaffected.
   */
  definitionHash?: string;
  /** F1: the normalizer-contract version for `definitionHash`, when present. */
  normalizerContractVersion?: number;
  /**
   * The revision's PERSISTED source label; null/`""` on every row written
   * before ISS-6232 (the collector's sentinel). Resolved against the owning
   * component's provenance by {@link buildComponentVersions}, so the DTO never
   * carries the sentinel through.
   */
  source: string | null;
  /** Source format; null when unset (mapped to "md" on the DTO). */
  format: string | null;
  /** ISO timestamp this revision was first observed ("" when unknown). */
  createdAt: string;
  /** The definition text for this revision. */
  content: string;
};

/**
 * Map content-hash revision rows (newest-first) into `ComponentVersion`s. SSOT
 * for BOTH the cloud service (`apps/api/app/agent-components/service.ts`) and the
 * desktop local IPC source (`apps/desktop/src/main/shared-agent-components-api.ts`)
 * so the two surfaces cannot drift (mirrors the `buildComponentProperties`
 * precedent — see AGENTS.md "Cross-surface consistency").
 *
 * `isCurrent` flags the row whose hash matches `currentHash`; when no row matches
 * (or `currentHash` is null), the newest row (index 0) is flagged current so the
 * Prompt panel always defaults to a revision.
 *
 * ISS-6232: `provenance` is the OWNING component's captured provenance, used to
 * resolve a revision whose persisted `source` is still the pre-derivation `""`
 * sentinel. Both surfaces pass their own representative inventory row, so the
 * same revision resolves to the same source on web and desktop. Resolving here
 * rather than rewriting the column keeps the STORED version identity
 * `(kind, key, source, hash)` byte-identical — the reported `source` is a
 * component-level attribute, not a dimension of the reported revision identity.
 * See {@link resolveComponentSource} and {@link ComponentVersion.sourceKind}.
 */
export function buildComponentVersions(
  rows: readonly ComponentVersionRow[],
  currentHash: string | null,
  provenance: ComponentSourceProvenance
): ComponentVersion[] {
  const hasCurrentMatch =
    currentHash != null && rows.some((r) => r.contentHash === currentHash);
  return rows.map((r, index) => {
    const resolvedSource = resolveComponentSource(r.source, provenance);
    return {
      hash: r.contentHash,
      // F1 passthrough (FEA-3290): present only once the coarse revision is
      // linked to its exact `DefinitionVersion`; omitted (undefined) otherwise
      // so the wire shape is byte-identical to pre-F1 for still-unlinked rows.
      ...(r.definitionHash == null ? {} : { definitionHash: r.definitionHash }),
      ...(r.normalizerContractVersion == null
        ? {}
        : { normalizerContractVersion: r.normalizerContractVersion }),
      source: resolvedSource.value,
      // Omitted, not nulled, when the value came from a persisted label: an
      // absent optional field is the wire shape older readers already handle.
      ...(resolvedSource.kind == null
        ? {}
        : { sourceKind: resolvedSource.kind }),
      format: r.format ?? "md",
      createdAt: r.createdAt,
      isCurrent: hasCurrentMatch ? r.contentHash === currentHash : index === 0,
      content: r.content,
    };
  });
}

/**
 * F1 (FEA-3290 / PRD-527 · AC-5, AC-7, AC-020) honest resolution state of an
 * inventory component. Mirrors the `component_resolved_state` DB enum exactly
 * (SSOT for the string literals). CRITICAL: `inaccessible` (permission-denied)
 * is DISTINCT from `missing` (deleted/absent) — the read surface must NEVER
 * collapse the two, so a private body a viewer cannot read is never reported as
 * gone. `unresolved` gates name-only / label-minted rows out of "configured
 * component"; legacy rows default to `unresolved`.
 */
export const ComponentResolvedState = {
  Resolved: "resolved",
  Unresolved: "unresolved",
  Inaccessible: "inaccessible",
  Missing: "missing",
} as const;
export type ComponentResolvedState =
  (typeof ComponentResolvedState)[keyof typeof ComponentResolvedState];

/**
 * F1 (FEA-3290) source-occurrence kind. Mirrors the `source_occurrence_type` DB
 * enum. `repository` populates repo evidence, `local` the device/path evidence,
 * `pack` the pack membership.
 *
 * FEA-3982 (Slice 1 / concern D) adds `StaticFile` (a loose checked-in / shipped
 * definition file that is not a repo scan), `Distributed` (pushed via a
 * distribution rather than pack-installed), and `BuiltinClaude` / `BuiltinCodex`
 * (shipped inside the harness binary). All additive; a version-skewed reader
 * that does not know a value MUST degrade it to `Local` via
 * {@link normalizeSourceOccurrenceType}.
 */
export const SourceOccurrenceType = {
  Repository: "repository",
  Local: "local",
  Pack: "pack",
  StaticFile: "static_file",
  Distributed: "distributed",
  BuiltinClaude: "builtin_claude",
  BuiltinCodex: "builtin_codex",
} as const;
export type SourceOccurrenceType =
  (typeof SourceOccurrenceType)[keyof typeof SourceOccurrenceType];

/**
 * The set of `SourceOccurrenceType` literals, for O(1) membership checks at wire
 * boundaries. Derived from the const so a new value is covered automatically.
 */
const SOURCE_OCCURRENCE_TYPE_VALUES = new Set<string>(
  Object.values(SourceOccurrenceType)
);

/**
 * FEA-3982 skew-safe coercion: map an unknown/absent occurrence-type string
 * (from an older or newer peer) to a known {@link SourceOccurrenceType},
 * degrading anything unrecognized to `Local` — the safe default per PLN-1494 so
 * a peer on a different version can never crash the reader or surface a raw
 * unknown provenance value.
 */
export function normalizeSourceOccurrenceType(
  value: string | null | undefined
): SourceOccurrenceType {
  if (value && SOURCE_OCCURRENCE_TYPE_VALUES.has(value)) {
    return value as SourceOccurrenceType;
  }
  return SourceOccurrenceType.Local;
}

/**
 * FEA-3982 — the editor's role on a `DefinitionVersion` edit-lineage row. Mirrors
 * the `definition_version_editor_role` DB enum. `Discoverer` = the first user
 * observed to carry that exact hash in the org; `Editor` = any later distinct
 * user who authored/observed the same bytes.
 */
export const DefinitionVersionEditorRole = {
  Discoverer: "discoverer",
  Editor: "editor",
} as const;
export type DefinitionVersionEditorRole =
  (typeof DefinitionVersionEditorRole)[keyof typeof DefinitionVersionEditorRole];

/**
 * F1 (FEA-3290 · AC-5) whether a source occurrence's definition body was
 * readable at capture. Mirrors the `source_access_state` DB enum. `inaccessible`
 * (permission-denied) is DISTINCT from a deleted/absent occurrence: last-known-
 * good is preserved and an inaccessible private body is never conflated with
 * "missing".
 */
export const SourceAccessState = {
  Accessible: "accessible",
  Inaccessible: "inaccessible",
} as const;
export type SourceAccessState =
  (typeof SourceAccessState)[keyof typeof SourceAccessState];

/**
 * F1 (FEA-3290 / PRD-527) provenance record: one proven location an exact
 * `DefinitionVersion` was observed at. Surface-neutral DTO for the "where was
 * this version seen" affordance on the detail read path. Typed by
 * `occurrenceType`; the evidence fields not relevant to a type are null. Never
 * carries the definition body — a `SourceOccurrence` describes provenance, and a
 * private body is never exposed cross-org (AC-019). `accessState` surfaces the
 * inaccessible-vs-accessible distinction so the UI never collapses an
 * inaccessible occurrence into "missing" (AC-5).
 */
export type SourceOccurrence = {
  /** repository | local | pack. */
  occurrenceType: SourceOccurrenceType;
  /** Whether the body was readable at capture (accessible | inaccessible). */
  accessState: SourceAccessState;
  /** repository evidence: `owner/repo` full name; null for other types. */
  repoFullName: string | null;
  /** repository evidence: path within the repo; null for other types. */
  repoPath: string | null;
  /** repository evidence: observed commit sha; null for other types. */
  repoCommit: string | null;
  /** local evidence: the compute target the occurrence was seen on; else null. */
  computeTargetId: string | null;
  /** local evidence: filesystem path read from; null for other types. */
  localPath: string | null;
  /** pack evidence: the pack whose membership carries this version; else null. */
  packId: string | null;
  /** ISO timestamp this provenance was first observed. */
  firstSeenAt: string;
  /** ISO timestamp this provenance was most recently observed. */
  lastSeenAt: string;
};

/**
 * Full component detail response — the list row plus definition metadata,
 * source prompt, and pre-fetched Sessions / Branches tab data.
 *
 * `sessionsTab` and `branchesTab` carry pre-fetched stub data in Phase 1
 * (both are `[]` from the stub source); detail tab adapters
 * (`agent-component-session-adapter`, `agent-component-branch-adapter`)
 * transform these into the presentational row types consumed by the
 * shared session/branch table components.
 */
export type AgentComponentDetail = AgentComponent & {
  /**
   * FEA-3294 bounded per-occurrence history. Optional for version-skewed cloud
   * responses and local readers that have not adopted the invocation contract.
   * When present, the page carries its own complete-match total, continuation
   * signal, and unmatched/ambiguous attribution counts.
   */
  invocationRows?: AgentComponentInvocationReadPage;
  /** Definition file metadata (path, format, model, allowedTools, server, …). */
  properties: AgentComponentProperties;
  /**
   * Raw source text of the definition file (the read-only Prompt panel content).
   * Null for configured-only kinds that have no text prompt (Hook, Config when
   * the source is binary or inaccessible).
   */
  prompt: string | null;
  /**
   * Content-hash revision history, newest-first. Each entry is a distinct
   * `(source, hash)` of the definition; `isCurrent` flags the live one. Empty
   * for components with no captured definition text (event-only / configured
   * kinds). The Prompt panel's version selector pages through these.
   */
  versions: readonly ComponentVersion[];
  /**
   * ISS-5029 — TRUE when {@link versions} is known to be PARTIAL: some revision
   * this identity actually has is not in the list. Two independent caps can
   * cause it, and either one is enough:
   *  - the desktop packer dropped retained revisions at its per-family entry cap
   *    or per-component variant byte budget, so they never reached the cloud
   *    (`AgentComponent.variantsTruncated`, folded across the identity's device
   *    rows);
   *  - the detail read's own bounded `take` bound, so the cloud holds more
   *    revisions than this response carries.
   *
   * Derived from the read/loop whose bound actually BOUND — never from a length
   * comparison, which is wrong whenever dedupe, a primary-hash skip, or a family
   * boundary changes the count (the ISS-4797/4799 lesson, PR #4354).
   *
   * Additive/optional and OMITTED (not `false`) when nothing was dropped, so a
   * version-skewed reader that does not know the field sees exactly today's
   * shape and treats absent as "not truncated".
   */
  versionsTruncated?: boolean;
  /**
   * F1 (FEA-3290 · AC-5, AC-7, AC-020) honest resolution state. `resolved` when
   * the component is backed by an exact definition; `unresolved` for legacy /
   * name-only / label-minted rows; `inaccessible` (permission-denied) is kept
   * DISTINCT from `missing` (deleted/absent) so the surface never collapses the
   * two. Defaults to `unresolved` (the DB column default) when the row predates
   * the resolution derivation.
   */
  resolvedState: ComponentResolvedState;
  /** Pre-fetched sessions that invoked this component. */
  sessionsTab: readonly AgentSessionListItem[];
  /**
   * ISS-5464: whether {@link sessionsTab} carries FEWER sessions than actually
   * used this component — i.e. the array is a bounded sample, not the set.
   *
   * Stated by the PRODUCER, because only the producer knows. The renderer used
   * to infer it from `sessionsTab.length >= AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS`,
   * but that constant is honoured by exactly one of the two producers: the cloud
   * read caps the array at 50, while desktop's
   * `getSharedAgentSessionsWithLocCostByIds` returns every id it can hydrate and
   * caps at nothing. On desktop `length === 50` therefore meant only "this
   * component has at least 50 hydrated sessions", and the tab announced a
   * truncation that had not happened. Two producers, one constant, one of them
   * wrong — so the fact travels on the wire instead of being re-derived.
   *
   * Both producers can compute it honestly from what they hold: cloud compares
   * the returned rows against the session-id set it read them for, desktop
   * compares the hydrated rows against the ids it asked for (it drops ids it
   * cannot project, which is the same disclosure from the reader's side).
   */
  sessionsTabTruncated: boolean;
  /** Pre-fetched branches that reference this component. */
  branchesTab: readonly BranchRow[];
  /**
   * ISS-5464: whether {@link branchesTab} is a bounded sample of the branches
   * that reference this component.
   *
   * The branch attribution read fans out over the session-id set, which is
   * `slice`d to `MAX_DETAIL_SESSION_IN_IDS` — so when that slice dropped
   * sessions, branches reachable only through the dropped ones are missing and
   * `branchesTab.length` is a floor. Unlike sessions there is no uncapped branch
   * count anywhere on the detail, so the tab can state nothing BUT a floor;
   * this flag is what tells it whether it has anything to disclose at all.
   */
  branchesTabTruncated: boolean;
  /**
   * Per-device provenance: one entry per compute target that has an
   * `AgentComponent` row for this org-level identity. Populated on-read
   * by the detail endpoint; empty array if no inventory rows exist yet.
   */
  provenance: {
    computeTargetId: string;
    installPath?: string;
    scope?: string;
    projectPath?: string;
  }[];
  /**
   * Sessions in which this component was invoked, with optional branch
   * attribution derived on-read via the `artifact_link` SessionBranch join.
   * One entry per `AgentComponentSessionUsage` row aggregated to session
   * granularity; `invocationCount` is the org-wide total for that session.
   */
  usageSessions: {
    sessionId: string;
    branchName?: string | null;
    invocationCount: number;
    /**
     * FEA-2923: the definition revision hash this session ran against
     * (hash-at-invocation). Matches one of `versions[].hash`; null when the
     * content had not been collected when the session ran.
     */
    versionHash?: string | null;
    /**
     * F1 (FEA-3290): the exact provenance-free fingerprint of the version this
     * session ran against, resolved via the usage row's `definitionVersionId`
     * link. Matches one of `versions[].definitionHash`. Undefined during the
     * pre-backfill window (link still NULL); consumers wanting exact-version
     * corroboration read it, while `versionHash` stays the wire-compat field.
     */
    definitionHash?: string | null;
  }[];
  /**
   * FEA-4335: the resolved NAME-LEVEL analytics key
   * (`agent_component_session_usage.component_key`) for this component's identity.
   *
   * The detail can be navigated to by a CONTENT-HASH routable slug
   * (`${kind}::${fingerprint}`) that disambiguates two same-named, different-byte
   * versions — but the desktop optimization-analytics IPC
   * (`getComponentModelTrend`, `getSubagentFrequency`, `isSkillLoaded`) keys on
   * the name-level `component_key`, NOT the fingerprint. Deriving the key from the
   * slug (`analyticsKeyFromSlug`) yields the 64-hex hash for a content-hash route
   * and every optimization query misses. This field carries the key the detail
   * resolved the hash back to so the renderer can key those IPC calls correctly.
   *
   * Additive + optional: populated by the desktop local reader; omitted by cloud
   * responses (the panel is desktop-only) and by version-skewed clients that
   * predate it. A reader MUST fall back to the slug's key half when it is absent.
   */
  analyticsKey?: string;
  /**
   * ISS-4403: the CONTENT SCOPE the detail's usage/session reads were actually
   * narrowed to — the resolver's `effectiveFingerprint`. Present ONLY when the
   * detail resolved via a real content-hash route (the URL carried a hash that
   * matched a live inventory row), in which case it equals the full
   * `component_version_hash` every usage lane on this page was filtered by.
   *
   * This is deliberately NOT {@link versionId}: `versionId` is the representative
   * bucket's fingerprint and is emitted even for a legacy name-level route (whose
   * usage reads span the WHOLE name, all versions). Scoping the desktop
   * optimization-analytics IPC by `versionId` on such a route would narrow the
   * panel to one version while the rest of the detail page shows the name-level
   * aggregate — a silent divergence, and it would hide hashless/other-version
   * history from a legacy bookmark. The panel MUST scope by THIS field so its
   * numbers match the page's own scope, and fall back to name-level analytics
   * (no fingerprint arg) when it is absent.
   *
   * Additive + optional: populated by the desktop local reader; omitted for a
   * name-level route, a hash-less component, cloud responses, and version-skewed
   * clients that predate it. Absence MUST degrade to name-level analytics.
   */
  analyticsFingerprint?: string;
} & CohortDeliveryMetrics;

/**
 * Change event emitted by `AgentComponentsDataSource.subscribe()`.
 * `componentId` is omitted when the entire inventory may have changed
 * (e.g. an install/uninstall event); subscribers should re-fetch the list.
 */
export type AgentComponentsChange = {
  componentId?: string;
};

/**
 * ISS-5009: the honest Source projection for one component — whether the
 * producer found REAL provenance, and if so what it was and which kind of source
 * it came from. Carried on {@link AgentComponent.honestSource}.
 *
 * Grouped in one object rather than three loose optional keys so the triple
 * cannot be half-adopted: a consumer that honors `hasProvenance` necessarily has
 * the matching value and type in hand. `source` and `sourceType` here are derived
 * TOGETHER from a single ordered switch over the winning provenance branch, so
 * the type always describes the value (the invariant
 * `resolveDetailSourceProjection` already documents for its own pair).
 */
export type AgentComponentHonestSource = {
  /**
   * `false` when the producer found no real provenance and its legacy `source`
   * fell through to the component's own identity key. Consumers gated on ISS-5009
   * render an empty value rather than that echo.
   */
  hasProvenance: boolean;
  /**
   * The real provenance — a pack id, a repository URL, or a settings SCOPE TOKEN
   * ({@link ComponentScope}). `null` exactly when `hasProvenance` is false.
   *
   * NEVER a filesystem location, on either surface. A path says where a copy was
   * installed, not where the component came from, and this DTO feeds an ORG-WIDE
   * catalog, so printing one would show every member another member's local
   * paths. Concretely: the project branch emits the SCOPE TOKEN
   * (`scope ?? ComponentScope.Project`) and never the row's `projectPath`, and
   * `installPath` is absent from the honest chain entirely — it survives only in
   * the untouched legacy `source` fallback that the flag-off render still uses.
   */
  source: string | null;
  /**
   * The source type of the branch that produced {@link source}. When
   * `hasProvenance` is false this is the kind-only fallback (`Server` for an MCP
   * tool, else `Local`) and describes no value.
   */
  sourceType: SourceType;
};

// ---------------------------------------------------------------------------
// Desktop local optimization-analytics types (AC-022 / T-16.11)
// Served from local SQLite over IPC; never round-trips to the cloud.
// ---------------------------------------------------------------------------

/**
 * One (model, day) bucket in a component's per-model token/cost/latency trend.
 *
 * All token counts are plain numbers (SQLite BigInt columns are coerced on the
 * main-process side before crossing IPC). `latencyAvgMs` and `latencyMaxMs` are
 * the AVG and MAX of `claude_code_api_request.duration_ms` when rows exist for
 * that (session, model) pair; null when no latency rows are present. These are
 * honest mean/max — NOT percentiles (SQLite lacks percentile_cont).
 *
 * `compactionCount` counts sessions in the window where the component was active
 * AND an actual context-compaction event was recorded (the `events` table's
 * 'Compaction' rows) — a real truncation/compaction signal, not the former
 * cache-write-tokens proxy that fired on nearly every cached session.
 */
export type ComponentModelTrendPoint = {
  /** UTC day bucket, e.g. "2025-06-15" */
  day: string;
  /** AI model identifier, e.g. "claude-opus-4-5" */
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Estimated USD cost for this bucket; null when pricing data is absent. */
  estimatedCostUsd: number | null;
  /** Mean request latency in milliseconds; null when no API-request rows exist. */
  latencyAvgMs: number | null;
  /** Max request latency in milliseconds; null when no rows exist. */
  latencyMaxMs: number | null;
  /** Sessions in this bucket that recorded a context-compaction event. */
  compactionCount: number;
};

/**
 * Response for `db.getComponentModelTrend`.
 * `points` are ordered by (day ASC, model ASC).
 */
export type ComponentModelTrendResponse = {
  componentKind: string;
  componentKey: string;
  windowDays: number;
  points: ComponentModelTrendPoint[];
};

/**
 * One day bucket for sub-agent pull-in frequency.
 * Counts the number of distinct sessions in which the sub-agent was invoked.
 */
export type SubagentFrequencyPoint = {
  /** UTC day bucket, e.g. "2025-06-15" */
  day: string;
  /** Number of sessions the sub-agent was pulled in on that day. */
  sessionCount: number;
  /** Total invocations across those sessions. */
  invocations: number;
};

/**
 * Response for `db.getSubagentFrequency`.
 * `points` are ordered by day ASC.
 */
export type SubagentFrequencyResponse = {
  subagentKey: string;
  windowDays: number;
  points: SubagentFrequencyPoint[];
};

/**
 * Response for `db.isSkillLoaded`.
 * Indicates whether the skill has an inventory row (exists in `agent_components`)
 * and whether it has any usage rows (in `agent_component_session_usage`).
 * A skill that exists but has zero usage rows may not be loading correctly.
 */
export type SkillLoadedResponse = {
  skillKey: string;
  /** True when an `agent_components` row exists for this skill key. */
  existsInInventory: boolean;
  /** True when at least one `agent_component_session_usage` row exists. */
  hasUsage: boolean;
  /** Total invocations across all time; 0 when `hasUsage` is false. */
  totalInvocations: number;
  /**
   * ISO timestamp of the most recent usage row (`last_invoked_at`);
   * null when `hasUsage` is false.
   */
  lastUsedAt: string | null;
};

// ---------------------------------------------------------------------------
// LOC/$ (efficiency) verifiability — FEA-4052
// ---------------------------------------------------------------------------

/**
 * FEA-4052 — the component kinds for which per-component LOC/$ (cost-efficiency)
 * attribution is RELIABLE.
 *
 * LOC/$ is derived by attributing a session's local-git LOC + token cost to the
 * components that ran in it (see `computeLocPerDollar` in
 * `apps/api/app/agent-components/loc-per-dollar.ts`). Attribution is only honest for a kind
 * whose invocation IS the whole unit of work the LOC/cost measures:
 *   - `subagent` — a delegated agent that authors the session's work. A subagent
 *     runs its own session, so that session's full LOC/cost is genuinely caused
 *     by that one component. This is the only kind we can attribute today.
 *
 * Every other kind CANNOT be reliably attributed a per-component LOC/$:
 *   - `skill` / `command` — a single session can record BOTH a skill and a
 *     command (and other components) independently, yet each usage row is given
 *     the session's FULL LOC and FULL cost. `computeLocPerDollar` reads the same
 *     session totals for each row, so two co-invoked components in one session
 *     each report the whole session's efficiency, not their own share. Until a
 *     session's LOC/cost can be PARTITIONED across the components co-invoked in
 *     it, a skill/command LOC/$ figure is session-level, not component-level, and
 *     would over-claim. They are excluded rather than render a misleading number
 *     (wongk, PR #3720). Re-add them here once session partitioning exists.
 *   - `plugin` rolls up its children's usage (its own number is version-agnostic
 *     and not a single component's efficiency);
 *   - `mcp` / `tool` / `orchestration` are ambient tool calls, not session
 *     drivers — a session's whole LOC/cost is not caused by one tool invocation;
 *   - `workflow` / `hook` / `config` carry no reliable per-component work signal.
 *
 * The gate is per component TYPE (not per instance): a tab/column/card for a
 * non-verifiable kind hides LOC/$ entirely rather than render a session-level
 * number that misattributes shared work to one component. Consumed by the
 * service (to null out `locPerDollar` for non-verifiable kinds) and by both UI
 * surfaces (to hide the LOC/$ column and metric card) so the show/hide decision
 * is identical everywhere.
 *
 * NOTE: keep this in sync with {@link AgentComponentKind}. `LOC_PER_DOLLAR_VERIFIABILITY`
 * below is an exhaustive `Record<AgentComponentKind, boolean>` map — a new kind
 * added to the enum fails `tsc` there until it is intentionally classified, so
 * this set can never silently omit (or wrongly include) a kind.
 */
/**
 * Exhaustive classification of every {@link AgentComponentKind} as LOC/$
 * verifiable (`true`) or not (`false`). Because it is typed
 * `Record<AgentComponentKind, boolean>`, adding a kind to the enum without
 * classifying it here fails `tsc` — the gate can never silently drift. Only
 * `subagent` is verifiable today (see the doc on {@link LOC_PER_DOLLAR_VERIFIABLE_KINDS}).
 */
const LOC_PER_DOLLAR_VERIFIABILITY: Record<AgentComponentKind, boolean> = {
  [AgentComponentKind.Subagent]: true,
  // Session-level attribution, not component-level — excluded until a session can
  // be partitioned across its co-invoked components (wongk, PR #3720).
  [AgentComponentKind.Skill]: false,
  [AgentComponentKind.Command]: false,
  // Rolls up children / ambient tool calls / no per-component work signal.
  [AgentComponentKind.Plugin]: false,
  [AgentComponentKind.Mcp]: false,
  [AgentComponentKind.Tool]: false,
  [AgentComponentKind.Orchestration]: false,
  [AgentComponentKind.Workflow]: false,
  [AgentComponentKind.Hook]: false,
  [AgentComponentKind.Config]: false,
};

export const LOC_PER_DOLLAR_VERIFIABLE_KINDS: ReadonlySet<AgentComponentKind> =
  new Set(
    (Object.keys(LOC_PER_DOLLAR_VERIFIABILITY) as AgentComponentKind[]).filter(
      (kind) => LOC_PER_DOLLAR_VERIFIABILITY[kind]
    )
  );

/**
 * FEA-4052 — true when a component kind has reliable per-component LOC/$
 * attribution, so its LOC/$ column + metric card should render. See
 * {@link LOC_PER_DOLLAR_VERIFIABLE_KINDS}.
 */
export function isLocPerDollarVerifiableKind(
  kind: AgentComponentKind
): boolean {
  return LOC_PER_DOLLAR_VERIFIABILITY[kind] === true;
}

/**
 * ISS-5534 — the invocation-carrying child kinds a `plugin` component's usage
 * rolls up from. Plugin-kind components are never invoked directly (they have no
 * own usage rows): their `invocations`/`sessions` are the SUM of their
 * skill/command/subagent/mcp children's usage (FEA-2923).
 *
 * Canonical home is this contract module — NOT the cloud rollup — because four
 * surfaces need the same vocabulary and only one of them can import server code:
 *  - the cloud rollup (`apps/api/app/agent-components/plugin-child-usage.ts`),
 *    which is `server-only`;
 *  - the plugin detail read (`.../service/detail-read.ts`);
 *  - the shared web+desktop Agents list, whose Invocations summary card must not
 *    add a plugin's rolled-up total to the child rows it was rolled up FROM;
 *  - the desktop rollup queries and the `pack_id` backfill that feeds them,
 *    which reach it through the SQL rendering in
 *    `apps/desktop/src/main/database/db-helpers.ts` — the LIST is the contract,
 *    turning it into statement text is that app's persistence detail (ISS-6094).
 * Declaring a second literal copy for any of them would be exactly the
 * SSOT-drift-by-copy this repo bans, so they all import this one.
 */
export const PLUGIN_CHILD_KINDS: readonly AgentComponentKind[] = [
  AgentComponentKind.Skill,
  AgentComponentKind.Command,
  AgentComponentKind.Subagent,
  AgentComponentKind.Mcp,
];

/** Set form of {@link PLUGIN_CHILD_KINDS} for O(1) membership tests. */
export const PLUGIN_CHILD_KIND_SET: ReadonlySet<AgentComponentKind> = new Set(
  PLUGIN_CHILD_KINDS
);
