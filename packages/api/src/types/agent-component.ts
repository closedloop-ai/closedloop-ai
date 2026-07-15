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

import type { AgentSessionListItem } from "./agent-session.js";
import type { BranchRow } from "./branch.js";

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

// --- Core inventory enums ---

/**
 * The kind of harness component an inventory entry represents. This is the
 * canonical const-object for the `componentKind` DB column on `AgentComponent`
 * (cloud) and `agent_components` (desktop); the values are the exact string
 * literals persisted to that column. Import this everywhere — do not declare a
 * second discriminator with the same values.
 *
 * 9 values: `Plugin` replaces the deprecated "pack" vocabulary (there is no
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
} as const;
export type AgentComponentKind =
  (typeof AgentComponentKind)[keyof typeof AgentComponentKind];

/**
 * Which AI harness a component targets.
 * Matches the prototype's `Harness` const object.
 */
export const Harness = {
  Claude: "claude",
  Codex: "codex",
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

/**
 * Lifecycle state of a session that used this component.
 * Values are SCREAMING_SNAKE to match the existing `SessionState` convention
 * in the prototype mock — preserved for wire compatibility.
 */
export const SessionState = {
  Active: "ACTIVE",
  Waiting: "WAITING",
  Completed: "COMPLETED",
  Failed: "FAILED",
  Abandoned: "ABANDONED",
} as const;
export type SessionState = (typeof SessionState)[keyof typeof SessionState];

// --- Sort / group / metric enums (list-surface controls) ---

/**
 * Columns by which the inventory table can be sorted.
 */
export const AgentComponentSortKey = {
  Name: "name",
  Type: "type",
  Metric: "metric",
  Owner: "owner",
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
  Owner: "owner",
  Harness: "harness",
} as const;
export type AgentComponentGroupBy =
  (typeof AgentComponentGroupBy)[keyof typeof AgentComponentGroupBy];

/**
 * Which efficiency metric the value column displays.
 * Values match the prototype metric selector options (T-2.3).
 */
export const AgentMetricMode = {
  KlocPerDollar: "kloc-per-dollar",
  DollarPerKloc: "dollar-per-kloc",
  ValueIndex: "value-index",
} as const;
export type AgentMetricMode =
  (typeof AgentMetricMode)[keyof typeof AgentMetricMode];

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
  name: string;
  kind: AgentComponentKind;
  sourceType: SourceType;
  /** Display label for the Source column (pack name, repo, server, or scope). */
  source: string;
  harness: Harness;
  /** Usage metrics — null for configured-only kinds with no reliable logs. */
  invocations: number | null;
  sessions: number | null;
  klocPerDollar: number | null;
  trend: readonly number[];
  /** Attributed owner display name; null when unattributed. */
  owner: string | null;
  /** Display names of collaborators who have used this component. */
  collaborators: readonly string[];
  /**
   * IDs of all compute targets (devices) in the org that have observed this
   * component. Populated by the list endpoint (org-level dedup join); empty
   * array if the component has only been seen by an unregistered target.
   */
  computeTargetIds: string[];
  /** ISO timestamp of when the component was first observed org-wide. */
  firstSeenAt: string;
  /** ISO timestamp of when the component was most recently observed org-wide. */
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
  owner?: string;
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
  /** Definition file metadata (path, format, model, allowedTools, server, …). */
  properties: AgentComponentProperties;
  /**
   * Raw source text of the definition file (the read-only Prompt panel content).
   * Null for configured-only kinds that have no text prompt (Hook, Config when
   * the source is binary or inaccessible).
   */
  prompt: string | null;
  /** Pre-fetched sessions that invoked this component. */
  sessionsTab: readonly AgentSessionListItem[];
  /** Pre-fetched branches that reference this component. */
  branchesTab: readonly BranchRow[];
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
  }[];
};

/**
 * Change event emitted by `AgentComponentsDataSource.subscribe()`.
 * `componentId` is omitted when the entire inventory may have changed
 * (e.g. an install/uninstall event); subscribers should re-fetch the list.
 */
export type AgentComponentsChange = {
  componentId?: string;
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
