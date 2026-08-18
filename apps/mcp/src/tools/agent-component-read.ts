import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type AgentComponentDetail,
  AgentComponentKind,
  type AgentComponentListResponse,
  AgentComponentSortDir,
  AgentComponentSortKey,
  Harness,
} from "@repo/api/src/types/agent-component.js";
import { resolveLocPerDollar } from "@repo/api/src/utils/loc-per-dollar.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  asRecord,
  buildQuery,
  encodePathSegment,
  MAX_PAGE_LIMIT,
  readNumber,
  readString,
  truncateString,
  withErrorHandling,
} from "./tool-utils.js";

/**
 * Read-only tools that expose the org agent-component registry over MCP — the
 * harness components (subagents, skills, commands, MCP servers, hooks, …)
 * discovered across the org's compute targets and surfaced in the
 * `[orgSlug]/agents` workspace (FEA-2884). Both call the `withAnyAuth`
 * `/agent-components` routes that already accept `sk_live_*` keys.
 *
 * NOTE: `/agent-components` paginates SERVER-side (unlike `/documents`, which
 * returns a bare array the tools slice locally via `buildPaginatedPayload`).
 * `limit`/`offset` are forwarded as query params and the API's own
 * `total`/`hasMore` are echoed back — never re-slice the returned page.
 */
// Derived from the live `Harness` enum so the description cannot drift as new
// harnesses are added (ISS-4386, shafty023): a new value automatically appears
// here instead of the text still claiming only claude/codex/both. Individual
// harnesses are every value except the synthetic `both` collapse.
const HARNESS_FILTER_DESCRIPTION = `Filter to a single target harness: ${Object.values(
  Harness
)
  .filter((h) => h !== Harness.Both)
  .map((h) => `"${h}"`)
  .join(", ")}, or "both" (a component observed across more than one harness).`;

// Derived from the live `AgentComponentSortKey` enum for the same reason
// (ISS-4944): the hand-written list still advertised the `owner` column FEA-4098
// removed from the SSOT, so the enum this tool builds its `sortBy` from rejected
// the very value its own description told callers to send.
const SORT_BY_DESCRIPTION = `Column to sort by: ${Object.values(
  AgentComponentSortKey
)
  .map((key) => `"${key}"`)
  .join(", ")}.`;

const agentComponentListInputSchema = {
  kinds: z
    .array(z.enum(Object.values(AgentComponentKind) as [string, ...string[]]))
    .optional()
    .describe(
      'Filter to one or more component kinds (e.g. ["skill", "subagent"]). Omit for every kind.'
    ),
  collaborator: z
    .string()
    .optional()
    .describe(
      "Filter to a single collaborator (author) display name — matched against the component's authors set (discoverer plus editors), falling back to the observing compute-target owner for rows with no lineage authors."
    ),
  // FEA-4098 (Slice 3) renamed the route filter `owner` → `collaborator`. The
  // route schema is not `.strict()`, so a stale `?owner=` was silently dropped
  // and the filter did nothing (ISS-4942). Kept as a mapped compat alias for
  // clients still passing the old name; `collaborator` wins when both are set.
  owner: z
    .string()
    .optional()
    .describe(
      "Deprecated alias for `collaborator` — prefer `collaborator`, which takes precedence when both are supplied."
    ),
  source: z
    .string()
    .optional()
    .describe(
      "Filter to a single source label (pack name, repo, MCP server, or config scope)."
    ),
  harness: z
    .enum(Object.values(Harness) as [string, ...string[]])
    .optional()
    .describe(HARNESS_FILTER_DESCRIPTION),
  search: z
    .string()
    .optional()
    .describe("Free-text filter over component names."),
  startDate: z
    .string()
    .optional()
    .describe(
      "Only include components invoked on or after this ISO 8601 date or timestamp (e.g. 2026-07-01). This is a USAGE window on lastInvokedAt, not an inventory-observation filter, and it drops components with no in-window usage. Omit for the all-time inventory view."
    ),
  endDate: z
    .string()
    .optional()
    .describe(
      "Only include components invoked on or before this ISO 8601 date or timestamp (e.g. 2026-07-31). Same lastInvokedAt basis as startDate; pair the two to scope to a window."
    ),
  sortBy: z
    .enum(Object.values(AgentComponentSortKey) as [string, ...string[]])
    .optional()
    .describe(SORT_BY_DESCRIPTION),
  sortDir: z
    .enum(Object.values(AgentComponentSortDir) as [string, ...string[]])
    .optional()
    .describe('Sort direction: "asc" or "desc".'),
  // The route allows up to AGENT_COMPONENT_INVENTORY_CAP (5000), but that cap
  // exists for the Agents workspace, which pulls the whole inventory to filter
  // and group it client-side. An MCP caller has no such need and a 5000-row
  // page would swamp its context, so bound this at the shared MCP page limit
  // like every sibling list tool.
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_LIMIT)
    .optional()
    .describe(
      `Maximum components to return (1-${MAX_PAGE_LIMIT}; the API defaults to 50).`
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Starting offset for pagination (default 0)."),
} as const;

type AgentComponentListInput = {
  kinds?: string[];
  collaborator?: string;
  /** Deprecated compat alias for `collaborator` (ISS-4942). */
  owner?: string;
  source?: string;
  harness?: string;
  search?: string;
  startDate?: string;
  endDate?: string;
  sortBy?: string;
  sortDir?: string;
  limit?: number;
  offset?: number;
};

/**
 * Build the API query from the list-tool inputs, dropping undefined filters and
 * stringifying the numeric pagination params (the route's zod schema coerces
 * them back). `kinds` stays an array — the route reads it as a repeated query
 * param and `ApiClient.get` appends one entry per item. Exported for unit
 * testing the filter mapping.
 *
 * The deprecated `owner` input maps onto the route's `collaborator` filter
 * (FEA-4098 renamed it; the route schema is not `.strict()`, so the old
 * `?owner=` was silently dropped and filtered nothing — ISS-4942).
 */
export function buildAgentComponentListQuery(
  input: AgentComponentListInput
): Record<string, string | readonly string[]> {
  // A blank value counts as unset (same treatment as the empty `kinds` array
  // below): `??` alone would let a blank `collaborator` mask a usable `owner`,
  // and the route's `z.string().trim().min(1)` would 400 on the resulting
  // `?collaborator=` instead of filtering.
  const collaborator = [input.collaborator, input.owner].find((value) =>
    value?.trim()
  );
  const query: Record<string, string | readonly string[]> = buildQuery({
    collaborator,
    source: input.source,
    harness: input.harness,
    search: input.search,
    startDate: input.startDate,
    endDate: input.endDate,
    sortBy: input.sortBy,
    sortDir: input.sortDir,
    limit: input.limit === undefined ? undefined : String(input.limit),
    offset: input.offset === undefined ? undefined : String(input.offset),
  });
  // An empty array would serialize to no param at all, so treat it as "unset"
  // rather than emitting a filter the route would read as a zero-kind match.
  if (input.kinds && input.kinds.length > 0) {
    query.kinds = input.kinds;
  }
  return query;
}

/**
 * Shape one API inventory row into a compact projection for the
 * `list-agent-components` response. Keeps `slug` — the org-level identity a
 * follow-up `get-agent-component` call resolves by — plus the core inventory
 * and usage metrics, without echoing the per-row `trend` sparkline the table
 * surface needs but an agent does not.
 */
export function shapeAgentComponentListItem(value: unknown) {
  const row = asRecord(value);
  return {
    // DB UUID — opaque row identity. Pass `slug`, NOT this, to
    // get-agent-component.
    id: readString(row.id),
    // Org-level identity (`kind::key`) — the detail route's selector.
    slug: readString(row.slug),
    name: readString(row.name),
    kind: readString(row.kind),
    sourceType: readString(row.sourceType),
    source: readString(row.source),
    harness: readString(row.harness),
    invocations: readNumber(row.invocations),
    sessions: readNumber(row.sessions),
    // ISS-4667: LOC/$ (lines per dollar). A cloud response that predates
    // ISS-4667 omits the canonical field and sends the KLOC-unit
    // `klocPerDollar`; resolve through the shared skew reader so an agent never
    // reads a figure a thousand times too small.
    locPerDollar: resolveLocPerDollar(
      row.locPerDollar === undefined ? undefined : readNumber(row.locPerDollar),
      readNumber(row.klocPerDollar)
    ),
    owner: readString(row.owner),
    collaborators: Array.isArray(row.collaborators) ? row.collaborators : [],
    computeTargetIds: Array.isArray(row.computeTargetIds)
      ? row.computeTargetIds
      : [],
    firstSeenAt: readString(row.firstSeenAt),
    lastSeenAt: readString(row.lastSeenAt),
    // Real usage recency. `lastSeenAt` is refreshed to now() by every inventory
    // sync for still-installed components, so it is NOT a usage signal — key
    // "recently active" off this field (FEA-3179 / FEA-3160).
    lastInvokedAt: readString(row.lastInvokedAt),
  };
}

export function registerListAgentComponents(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "list-agent-components",
    {
      description:
        "List agent components — the org's registry of harness components (subagents, skills, commands, MCP servers, hooks, plugins, workflows, config, and built-in/orchestration tools) discovered across its compute targets, with usage metrics, ownership, and provenance. Read-only; server-side pagination and sorting. Use a returned `slug` with get-agent-component to pull one component's definition, prompt, and version history.",
      inputSchema: agentComponentListInputSchema,
    },
    (input) =>
      withErrorHandling(async () => {
        const response = await apiClient.get<AgentComponentListResponse>(
          "/agent-components",
          buildAgentComponentListQuery(input)
        );
        const record = asRecord(response);
        const items = Array.isArray(record.items) ? record.items : [];
        const payload = {
          items: items.map(shapeAgentComponentListItem),
          returned: items.length,
          total: readNumber(record.total) ?? items.length,
          hasMore: record.hasMore === true,
        };
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(payload, null, 2) },
          ],
        };
      })
  );
}

const DEFAULT_PROMPT_MAX_CHARS = 4000;
const MAX_PROMPT_MAX_CHARS = 120_000;

type GetAgentComponentInput = {
  slug: string;
  includePrompt?: boolean;
  promptMaxChars?: number;
  versionHash?: string;
};

/**
 * Shape the detail payload for the `get-agent-component` response.
 *
 * The API bounds the detail to 20 revisions, but each `versions[].content` body
 * can be up to the 256 KiB per-component sync cap — a worst case of ~5 MB of
 * definition text in one payload. The web Prompt panel tolerates that because it
 * renders one revision at a time; an MCP client would have to swallow all of it.
 * So `versions` is projected to metadata plus `contentLength`, and definition
 * text is returned only for the ONE selected revision, opt-in and truncated —
 * mirroring the `includeContent`/`contentMaxChars` convention `get-document`
 * already establishes for large bodies.
 *
 * `sessionsTab`/`branchesTab` are dropped: they are pre-fetched render data for
 * the detail page's tabs, and `usageSessions` already carries the same
 * session→branch attribution in a compact form.
 *
 * ISS-5029: `versionsTruncated` is forwarded only when the API sent exactly
 * `true`, preserving the true-only/omitted contract — absent means "the history
 * is complete". It is never recomputed from `versions.length`: only the read
 * whose bound actually bound knows it.
 */
export function shapeAgentComponentDetail(
  value: unknown,
  options: {
    includePrompt?: boolean;
    promptMaxChars?: number;
    versionHash?: string;
  } = {}
) {
  const row = asRecord(value);
  const versions = Array.isArray(row.versions) ? row.versions : [];
  const resolvedMaxChars = options.promptMaxChars ?? DEFAULT_PROMPT_MAX_CHARS;

  // Select the requested revision, else the current one, else the component's
  // top-level prompt (which is the live definition text).
  const selected = options.versionHash
    ? versions.find(
        (version) => readString(asRecord(version).hash) === options.versionHash
      )
    : versions.find((version) => asRecord(version).isCurrent === true);
  const selectedText = selected
    ? readString(asRecord(selected).content)
    : readString(row.prompt);

  return {
    ...shapeAgentComponentListItem(row),
    properties: row.properties ?? null,
    // Length of the selected revision's text, always present so a caller can
    // size a follow-up read before asking for the body.
    promptLength: selectedText?.length ?? 0,
    ...(options.includePrompt === true
      ? {
          prompt:
            selectedText === null
              ? null
              : truncateString(selectedText, resolvedMaxChars),
          promptVersionHash: selected
            ? readString(asRecord(selected).hash)
            : null,
        }
      : {}),
    // Metadata only — request one revision's text via versionHash + includePrompt.
    versions: versions.map((version) => {
      const entry = asRecord(version);
      return {
        hash: readString(entry.hash),
        source: readString(entry.source),
        format: readString(entry.format),
        createdAt: readString(entry.createdAt),
        isCurrent: entry.isCurrent === true,
        contentLength: readString(entry.content)?.length ?? 0,
      };
    }),
    // True-only marker that `versions` above is PARTIAL — emitted only when the
    // API said so, and omitted otherwise so an unaware caller sees today's shape.
    ...(row.versionsTruncated === true ? { versionsTruncated: true } : {}),
    provenance: Array.isArray(row.provenance) ? row.provenance : [],
    usageSessions: Array.isArray(row.usageSessions) ? row.usageSessions : [],
  };
}

export function registerGetAgentComponent(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "get-agent-component",
    {
      description:
        "Get one agent component by its org-level slug — the list row plus definition metadata (path, format, model, allowed tools), content-hash version history, per-device provenance, and the sessions that invoked it. `versionsTruncated: true` appears only when that version history is partial; its absence means complete. Set includePrompt to read the definition text itself. Read-only.",
      inputSchema: {
        slug: z
          .string()
          .describe(
            'Agent-component slug — the `slug` field returned by list-agent-components, formed as `kind::key` (e.g. "skill::code-review"). Pass it verbatim; it is URL-encoded for you. The `id` UUID is not accepted here.'
          ),
        includePrompt: z
          .boolean()
          .optional()
          .describe(
            "Include the definition text of the selected revision. Definition bodies can reach 256 KiB, so this is off by default; `promptLength` and per-revision `contentLength` are always returned so you can size the read first. Default false."
          ),
        promptMaxChars: z
          .number()
          .int()
          .min(200)
          .max(MAX_PROMPT_MAX_CHARS)
          .optional()
          .describe(
            `Maximum definition characters when includePrompt=true (default ${DEFAULT_PROMPT_MAX_CHARS}, max ${MAX_PROMPT_MAX_CHARS}).`
          ),
        versionHash: z
          .string()
          .optional()
          .describe(
            "Read a specific historical revision instead of the current one — pass a `hash` from `versions`. Only that revision's text is returned, and only when includePrompt=true. Defaults to the current revision."
          ),
      },
    },
    (input: GetAgentComponentInput) =>
      withErrorHandling(async () => {
        const detail = await apiClient.get<AgentComponentDetail>(
          `/agent-components/${encodePathSegment(input.slug)}`
        );
        const payload = shapeAgentComponentDetail(detail, {
          includePrompt: input.includePrompt,
          promptMaxChars: input.promptMaxChars,
          versionHash: input.versionHash,
        });
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(payload, null, 2) },
          ],
        };
      })
  );
}
