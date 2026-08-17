/**
 * @file component-sync-source.ts
 * @description The AGENT-COMPONENT INVENTORY half of the desktop sync source:
 * the keyset cursor query, the row loader, the transport clamp, and the
 * `agent_components` row -> `SyncedComponent` wire mapping for
 * `POST /desktop/components/sync`.
 *
 * Split out of the (grandfathered, over-ceiling) `sync-source.ts` as its own
 * cohesive concern (ISS-4662): component inventory packing is independent of
 * session packing — different tables, different cursor, different endpoint —
 * and this pass adds the retained-variant lane, which belongs beside it.
 *
 * ISS-4662 (item 1): ISS-4564 made the collector RETAIN every distinct content
 * hash of a same-name definition in the local `agent_component_versions` table,
 * but the sync payload was packed from `agent_components` alone — one winning
 * row per identity — so those retained bytes never left the device and the cloud
 * detail panel showed a single revision where Desktop showed several. The
 * variant lane below carries them additively.
 */
import type {
  ComponentResolvedState,
  SyncedComponent,
} from "@repo/api/src/types/agent-session";
import type { SyncedComponentVariant } from "@repo/api/src/types/synced-component-content";
import {
  SYNCED_COMPONENT_CONTENT_MAX_CHARS,
  SYNCED_COMPONENT_CONTENT_MAX_SERIALIZED_BYTES,
  SYNCED_COMPONENT_MAX_SERIALIZED_BYTES,
  SYNCED_COMPONENT_VARIANTS_BUDGET_HEADROOM_BYTES,
  SYNCED_COMPONENT_VARIANTS_MAX,
  SYNCED_COMPONENT_VARIANTS_MAX_SERIALIZED_BYTES,
  SyncedComponentVariantsTruncatedReason,
  serializedJsonUtf8ByteSize,
} from "@repo/api/src/types/synced-component-content";
import { parseJsonObjectText } from "../agent-sync/agent-sync-json-text.js";
import type { DesktopPrisma } from "./prisma-client.js";
import { selectRowsByIds } from "./session-detail-mappers.js";

/**
 * Cursor row for the agent_components inventory sync lane (T-8.6).
 * Ordered by (last_seen_at, id) so new/updated rows are always discovered.
 * Tombstoned rows (uninstalled_at IS NOT NULL) are included so the cloud
 * receives uninstall signals.
 */
export type SqliteAgentComponentCursorRow = {
  id: string;
  last_seen_at: string | null;
};

/** Full inventory row for `POST /desktop/components/sync`. */
type SqliteAgentComponentRow = {
  id: string;
  component_kind: string;
  external_id: string;
  component_key: string | null;
  name: string | null;
  version: string | null;
  harness: string | null;
  description: string | null;
  source_url: string | null;
  install_path: string | null;
  pack_id: string | null;
  scope: string | null;
  project_path: string | null;
  metadata: string | null;
  content: string | null;
  content_hash: string | null;
  resolved_state: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  uninstalled_at: string | null;
};

/** One retained revision row from the local `agent_component_versions` table. */
type SqliteAgentComponentVersionRow = {
  component_kind: string;
  component_key: string;
  content_hash: string;
  content: string;
  format: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
};

/**
 * A retained revision's IDENTITY and metadata, WITHOUT its body.
 *
 * The first load pass selects only these columns so the per-family cap can be
 * applied before any definition text is materialized — `agent_component_versions`
 * is append-only per hash, so a churned definition can accumulate an unbounded
 * number of full bodies and selecting them all just to emit eight would make the
 * DB host read arbitrarily much text (wongk, #4295).
 */
type SqliteAgentComponentVersionIdentityRow = {
  component_kind: string;
  component_key: string;
  content_hash: string;
  format: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
};

// ---------------------------------------------------------------------------
// T-8.6: Agent component inventory cursor queries
// ---------------------------------------------------------------------------

/**
 * T-8.6 / fix(component-sync-cursor-keyset): Cursor rows for the component
 * inventory sync lane, ordered by (last_seen_at, id) and paged with a proper
 * KEYSET predicate so the lane advances monotonically through ALL rows even
 * when hundreds share one `last_seen_at` (previously a `>=` watermark could
 * not advance past a same-timestamp cluster larger than the batch, so the
 * first batch re-uploaded forever and the rest never synced).
 *
 * The keyset cursor is the `(sinceTs, sinceId)` pair — the same `(last_seen_at,
 * id)` tuple as the sort order, which is unique. `last_seen_at` is nullable, so
 * it is normalized with `COALESCE(last_seen_at, '')`; an empty string sorts
 * before any ISO-8601 timestamp, ordering NULL rows first and consistently.
 * Passing `('', '')` selects every row (full backfill on first run): `'' > ''`
 * is false, but `'' = '' AND id > ''` is true for every non-empty id.
 * Includes tombstoned rows (uninstalled_at IS NOT NULL) so the cloud receives
 * uninstall signals.
 *
 * FEA-3438: the SELECT is bounded by `LIMIT $3` so each keyset page reads only
 * the caller's batch, not the entire remaining unsynced tail. The keyset order
 * is deterministic and unique on `(last_seen_at, id)`, so `LIMIT` returns the
 * exact next page and the caller advances past its last row on the next tick.
 * Per-tick read cost is O(batch) instead of O(remaining), and first-run
 * backfill is O(N) across ticks instead of O(N^2).
 */
export async function listAgentComponentCursorRows(
  prisma: DesktopPrisma,
  sinceTs: string,
  sinceId: string,
  limit: number
): Promise<SqliteAgentComponentCursorRow[]> {
  return await prisma.read((reader) =>
    reader.$queryRawUnsafe<SqliteAgentComponentCursorRow[]>(
      `
      SELECT id, last_seen_at
      FROM agent_components
      WHERE COALESCE(last_seen_at, '') > $1
         OR (COALESCE(last_seen_at, '') = $1 AND id > $2)
      ORDER BY COALESCE(last_seen_at, '') ASC, id ASC
      LIMIT $3
      `,
      sinceTs,
      sinceId,
      limit
    )
  );
}

/**
 * T-8.6: Load full component rows by id for packing into the sync payload.
 * Includes tombstoned rows so uninstall signals are synced.
 */
async function loadAgentComponents(
  prisma: DesktopPrisma,
  ids: string[]
): Promise<SqliteAgentComponentRow[]> {
  if (ids.length === 0) {
    return [];
  }
  return await prisma.read((reader) =>
    selectRowsByIds<SqliteAgentComponentRow>(
      reader,
      `
      SELECT
        id,
        component_kind,
        external_id,
        component_key,
        name,
        version,
        harness,
        description,
        source_url,
        install_path,
        pack_id,
        scope,
        project_path,
        metadata,
        content,
        content_hash,
        resolved_state,
        first_seen_at,
        last_seen_at,
        uninstalled_at
      FROM agent_components
      WHERE id IN (__IDS__)
      ORDER BY last_seen_at ASC, id ASC
      `,
      ids
    )
  );
}

/**
 * T-8.6: Map a raw `agent_components` row to the `SyncedComponent` wire shape
 * for `POST /desktop/components/sync`.
 */
const RESOLVED_STATES: ReadonlySet<string> = new Set<ComponentResolvedState>([
  "resolved",
  "unresolved",
  "inaccessible",
  "missing",
]);

/**
 * F1 (FEA-3290 Slice 4): narrow a raw `resolved_state` column value (which may
 * be NULL on legacy rows, or an unexpected string) to the honest enum. Anything
 * outside the enum — including NULL — falls back to `unresolved` at the call
 * site, never trusted blindly.
 */
function isResolvedState(
  value: string | null
): value is ComponentResolvedState {
  return value != null && RESOLVED_STATES.has(value);
}

/**
 * FEA-3692: clamp a component's `content` by its **serialized (JSON-escaped)
 * UTF-8 byte size** — the size the transport chunker (`desktop-components-client`)
 * actually enforces on the wire — so a single component always fits a sub-cap
 * request no matter how escape-heavy its body is.
 *
 * The prior FEA-3626 clamp bounded the RAW UTF-8 byte size
 * (`SYNCED_COMPONENT_CONTENT_MAX_BYTES`, 96 KiB). But JSON string-escaping inflates
 * the wire size: a control char escapes to the 6-byte `\uXXXX` form, so a 512 KiB
 * NUL-filled definition clamped to 98 304 raw bytes still serialized to ~576 KiB
 * — the chunker classified it oversized, emitted zero chunks + one oversized
 * entry, and the component silently vanished (its name/kind/hash/installPath never
 * reached the cloud) while the sync cursor advanced past it. Measuring the
 * SERIALIZED size ({@link serializedJsonUtf8ByteSize}, which counts a lone
 * surrogate as the 6-byte `\uXXXX` escape exactly like `JSON.stringify`, not the
 * 3 bytes of its U+FFFD replacement) and clamping to {@link
 * SYNCED_COMPONENT_CONTENT_MAX_SERIALIZED_BYTES} (128 KiB, ~120 KiB under the
 * ~248 KiB chunk budget) guarantees the clamped body — plus the envelope and every
 * sibling field — always fits a sub-cap request. A body clamped to <= 128 KiB
 * serialized is also always <= the {@link SYNCED_COMPONENT_CONTENT_MAX_CHARS} char
 * cap (serialized bytes >= chars), so the cloud ingest Zod `.max(...)` still
 * accepts it; that char cap is retained as a belt-and-suspenders upper bound.
 *
 * The truncation is codepoint-safe (it cuts only on code-point boundaries, never
 * mid-surrogate-pair or mid-multibyte-scalar) and bounded-allocation: we scan
 * `content` code point by code point, accumulating serialized bytes, and STOP as
 * soon as adding the next code point would exceed the budget — so the walk reads
 * at most ~budget worth of the (possibly enormous) source string and allocates no
 * whole-string encode buffer. Content already within budget is returned unchanged.
 */
export function clampSyncedComponentContent(content: string): string {
  // Cheap length pre-check short-circuits the O(n) serialized scan for bodies too
  // long to possibly fit: JSON escaping never SHRINKS a string, so its serialized
  // byte size is >= its code-unit length, and a body longer than the serialized
  // budget must exceed it. When `length` DOES fit, a body short in code units can
  // still serialize large (escape-heavy), so we confirm the true serialized size
  // before returning it unchanged (`&&` keeps the expensive scan lazy).
  if (
    content.length <= SYNCED_COMPONENT_CONTENT_MAX_SERIALIZED_BYTES &&
    serializedJsonUtf8ByteSize(content) <=
      SYNCED_COMPONENT_CONTENT_MAX_SERIALIZED_BYTES
  ) {
    return content;
  }
  // Walk code points, accumulating serialized bytes, and cut just before the
  // first code point that would push the running total over the budget. Cutting
  // on a code-point boundary keeps surrogate pairs and multibyte scalars intact,
  // and a lone surrogate is charged its true 6 serialized bytes (never
  // undercounted), so the returned prefix's serialized size is provably <= budget.
  let serialized = 0;
  let cut = 0;
  for (const codePoint of content) {
    const cost = serializedJsonUtf8ByteSize(codePoint);
    if (serialized + cost > SYNCED_COMPONENT_CONTENT_MAX_SERIALIZED_BYTES) {
      break;
    }
    serialized += cost;
    cut += codePoint.length; // 1 for BMP, 2 for an astral surrogate pair
  }
  const truncated = content.slice(0, cut);
  return truncated.length > SYNCED_COMPONENT_CONTENT_MAX_CHARS
    ? truncated.slice(0, SYNCED_COMPONENT_CONTENT_MAX_CHARS)
    : truncated;
}

function mapAgentComponentToSynced(
  row: SqliteAgentComponentRow
): SyncedComponent {
  return {
    externalId: row.external_id,
    componentKind: row.component_kind,
    harness: row.harness ?? null,
    name: row.name ?? null,
    componentKey: row.component_key ?? null,
    version: row.version ?? null,
    description: row.description ?? null,
    sourceUrl: row.source_url ?? null,
    installPath: row.install_path ?? null,
    packId: row.pack_id ?? null,
    scope: row.scope ?? null,
    projectPath: row.project_path ?? null,
    metadata: row.metadata ? (parseJsonObjectText(row.metadata) ?? null) : null,
    // Cap the synced body by a transport BYTE budget (FEA-3626), not just a
    // char count: a component whose serialized JSON exceeds the chunker's
    // per-request byte budget is dead-lettered wholesale, so a char-only clamp
    // above the byte ceiling made large-content components vanish from the
    // cloud. The untruncated sha256 stays in `contentHash` so the cloud can
    // still dedup/version by the true file identity.
    content:
      row.content == null ? null : clampSyncedComponentContent(row.content),
    contentHash: row.content_hash ?? null,
    // F1 (FEA-3290 / PRD-527 Slice 4 / AC-007): ship the honest resolution
    // state so the cloud never surfaces a label-minted (`unresolved`) row as a
    // configured component. Coalesce a legacy NULL (rows predating the column)
    // to `unresolved` — the same conservative default as the mint gate.
    resolvedState: isResolvedState(row.resolved_state)
      ? row.resolved_state
      : "unresolved",
    firstSeenAt: row.first_seen_at ?? null,
    lastSeenAt: row.last_seen_at ?? null,
    uninstalledAt: row.uninstalled_at ?? null,
  };
}

/** Composite identity of one retained revision family: `kind\u0000key`. */
function versionFamilyKey(componentKind: string, componentKey: string): string {
  return `${componentKind}\u0000${componentKey}`;
}

/**
 * The per-family candidate cap applied IN SQL, before any body is read.
 *
 * `SYNCED_COMPONENT_VARIANTS_MAX + 1` because the PRIMARY revision (the hash the
 * `agent_components` display row already carries) is usually the newest and is
 * filtered out of `variants` by hash — so the cap has to admit one extra row for
 * the primary to occupy, or a component with exactly `MAX` extra revisions would
 * ship only `MAX - 1` of them.
 */
const VERSION_CANDIDATES_PER_FAMILY = SYNCED_COMPONENT_VARIANTS_MAX + 1;

/**
 * ISS-4662: load the retained `agent_component_versions` revisions for the
 * component families present in this batch.
 *
 * The desktop writes those rows keyed by `(component_kind, component_key,
 * source, content_hash)` where `component_key` is the definition's `externalId`
 * — the SAME value `agent_components` stores in BOTH `external_id` and
 * `component_key` (they are inserted from one `$3` placeholder), so the families
 * join cleanly. `source` is the collector's `DEFINITION_SOURCE` ("" sentinel),
 * which is also the sentinel the cloud version row uses, so no source dimension
 * has to cross the wire.
 *
 * TWO PASSES, deliberately (wongk, #4295). `agent_component_versions` is
 * append-only per content hash, so a definition that churns accumulates a row per
 * revision forever — and the transport caps downstream only decide what to SEND,
 * long after a single-pass query would have made the DB host materialize every
 * historical body for every family on the page. So:
 *
 *   1. rank identities per family in SQL and take only the top
 *      {@link VERSION_CANDIDATES_PER_FAMILY} — no `content` column selected, so
 *      the scan reads hashes and dates, not text;
 *   2. fetch bodies for exactly that bounded hash set.
 *
 * Newest-first so a budget-truncated set keeps the most recently observed
 * revisions; `content_hash` breaks ties for a deterministic payload. The ordering
 * is identical in both passes, and the second pass re-sorts in memory so the
 * caller still sees strict newest-first regardless of row return order.
 */
async function loadAgentComponentVersions(
  prisma: DesktopPrisma,
  families: readonly { componentKind: string; componentKey: string }[]
): Promise<LoadedAgentComponentVersions> {
  const grouped = new Map<string, SqliteAgentComponentVersionRow[]>();
  const cappedFamilies = new Set<string>();
  if (families.length === 0) {
    return { grouped, cappedFamilies };
  }
  const probed = await loadVersionIdentities(prisma, families);
  const identities = partitionCappedFamilies(probed, cappedFamilies);
  if (identities.length === 0) {
    return { grouped, cappedFamilies };
  }
  const bodyByKey = await loadVersionBodies(prisma, identities);
  for (const identity of identities) {
    const rowKey = versionRowKey(identity);
    const content = bodyByKey.get(rowKey);
    if (content === undefined) {
      // The revision vanished between the two passes (a retention prune raced
      // us). Skipping is correct: shipping a hollow row would write a cloud
      // version with no body.
      continue;
    }
    const key = versionFamilyKey(
      identity.component_kind,
      identity.component_key
    );
    const row: SqliteAgentComponentVersionRow = { ...identity, content };
    const bucket = grouped.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      grouped.set(key, [row]);
    }
  }
  return { grouped, cappedFamilies };
}

/** Identity of one version row, for joining the two load passes. */
function versionRowKey(row: {
  component_kind: string;
  component_key: string;
  content_hash: string;
}): string {
  return `${row.component_kind}\u0000${row.component_key}\u0000${row.content_hash}`;
}

/**
 * ISS-5029: pass 1 ranks one row PAST {@link VERSION_CANDIDATES_PER_FAMILY} so
 * the packer can tell "this family has exactly the candidates we take" from
 * "this family has more and we stopped".
 *
 * That sentinel row is the read that actually hits the cap — the only honest
 * source for the marker. Inferring truncation from how many variants came out
 * the other end would be wrong the moment the primary-hash skip, a NULL body, or
 * a byte budget changes the count (the ISS-4797/4799 lesson, PR #4354). The
 * sentinel is DISCARDED before pass 2, so no extra body is ever read: the cost
 * is one more hash/date row per family in a query that already reads no text.
 */
const VERSION_CANDIDATE_PROBE_PER_FAMILY = VERSION_CANDIDATES_PER_FAMILY + 1;

/**
 * Pass 1: the newest {@link VERSION_CANDIDATE_PROBE_PER_FAMILY} revision
 * identities per family, ranked in SQL so no more than that many rows per family
 * are ever considered — and no body is read. The extra probe row is the
 * ISS-5029 truncation sentinel and never survives
 * {@link partitionCappedFamilies}.
 *
 * ISS-5029 (closedloop-ai-stage, #4391): the ranked population is narrowed to
 * rows that could ACTUALLY SHIP — a hash-bearing row with a non-NULL body — the
 * same eligibility {@link selectSyncedVariants} applies. Without it a NULL-body
 * row could occupy the probe rank and mark the family capped even though nothing
 * shippable was dropped, which is the opposite verdict the packing loop reaches
 * for that same row one rank earlier ("a trailing NULL-body row is not a dropped
 * revision"). These are PREDICATES, not projections: `content IS NOT NULL` reads
 * the record header, so the pass still transfers no text.
 *
 * The primary-hash half of that eligibility cannot be expressed here (the
 * primary is per-component, not per-family-row) and does not need to be: if the
 * primary sorted all the way down to the probe rank, then all
 * {@link VERSION_CANDIDATES_PER_FAMILY} admitted rows are eligible non-primary
 * revisions, so the packing loop's entry cap binds on its own and the two
 * signals agree.
 */
async function loadVersionIdentities(
  prisma: DesktopPrisma,
  families: readonly { componentKind: string; componentKey: string }[]
): Promise<SqliteAgentComponentVersionIdentityRow[]> {
  const params: (string | number)[] = [];
  const predicates: string[] = [];
  for (const family of families) {
    predicates.push(
      `(component_kind = $${params.length + 1} AND component_key = $${params.length + 2})`
    );
    params.push(family.componentKind, family.componentKey);
  }
  params.push(VERSION_CANDIDATE_PROBE_PER_FAMILY);
  return await prisma.read((reader) =>
    reader.$queryRawUnsafe<SqliteAgentComponentVersionIdentityRow[]>(
      `
      SELECT component_kind, component_key, content_hash, format,
             first_seen_at, last_seen_at
      FROM (
        SELECT component_kind, component_key, content_hash, format,
               first_seen_at, last_seen_at,
               ROW_NUMBER() OVER (
                 PARTITION BY component_kind, component_key
                 ORDER BY COALESCE(last_seen_at, '') DESC, content_hash ASC
               ) AS family_rank
        FROM agent_component_versions
        WHERE (${predicates.join(" OR ")})
          AND content IS NOT NULL
          AND content_hash IS NOT NULL
          AND content_hash <> ''
      )
      WHERE family_rank <= $${params.length}
      ORDER BY component_kind ASC, component_key ASC,
               COALESCE(last_seen_at, '') DESC, content_hash ASC
      `,
      ...params
    )
  );
}

/**
 * ISS-5029: split pass 1's probed identities into the bounded set pass 2 will
 * fetch bodies for, recording every family whose SQL rank cap BOUND.
 *
 * A family that came back with more than {@link VERSION_CANDIDATES_PER_FAMILY}
 * identities has at least one retained revision the packer will never consider,
 * so its component's variant set is partial by construction — independent of
 * whatever the byte budget does later. The surplus identities are dropped here,
 * before any body is read, so the "no text past the budget" property of the two
 * passes is unchanged.
 *
 * This counts IDENTITIES, with no view of bodies — which is sound only because
 * {@link loadVersionIdentities} already restricted the ranked population to rows
 * that could ship. A row that the packing loop would skip anyway must never
 * reach the probe rank, or this reports a drop that did not happen.
 *
 * Rows arrive already grouped and ordered per family by pass 1's `ORDER BY`, but
 * this counts per family rather than assuming contiguity, so a future ordering
 * change cannot silently turn the cap into a no-op.
 */
function partitionCappedFamilies(
  probed: readonly SqliteAgentComponentVersionIdentityRow[],
  cappedFamilies: Set<string>
): SqliteAgentComponentVersionIdentityRow[] {
  const kept: SqliteAgentComponentVersionIdentityRow[] = [];
  const seenPerFamily = new Map<string, number>();
  for (const identity of probed) {
    const key = versionFamilyKey(
      identity.component_kind,
      identity.component_key
    );
    const seen = seenPerFamily.get(key) ?? 0;
    seenPerFamily.set(key, seen + 1);
    if (seen >= VERSION_CANDIDATES_PER_FAMILY) {
      cappedFamilies.add(key);
      continue;
    }
    kept.push(identity);
  }
  return kept;
}

/** Pass 2: bodies for exactly the bounded identity set pass 1 selected. */
async function loadVersionBodies(
  prisma: DesktopPrisma,
  identities: readonly SqliteAgentComponentVersionIdentityRow[]
): Promise<Map<string, string>> {
  const params: string[] = [];
  const predicates: string[] = [];
  for (const identity of identities) {
    predicates.push(
      `(component_kind = $${params.length + 1} AND component_key = $${params.length + 2} AND content_hash = $${params.length + 3})`
    );
    params.push(
      identity.component_kind,
      identity.component_key,
      identity.content_hash
    );
  }
  const rows = await prisma.read((reader) =>
    reader.$queryRawUnsafe<
      {
        component_kind: string;
        component_key: string;
        content_hash: string;
        content: string | null;
      }[]
    >(
      `
      SELECT component_kind, component_key, content_hash, content
      FROM agent_component_versions
      WHERE ${predicates.join(" OR ")}
      `,
      ...params
    )
  );
  const bodyByKey = new Map<string, string>();
  for (const row of rows) {
    // An EMPTY body is a real retained revision, not a missing one — the
    // collector hashes and persists an empty definition as a valid version row,
    // so only a NULL column means "no body" (wongk, #4295).
    if (row.content !== null && row.content !== undefined) {
      bodyByKey.set(versionRowKey(row), row.content);
    }
  }
  return bodyByKey;
}

/**
 * ISS-4662: select the retained variants that fit this component's remaining
 * transport budget.
 *
 * Excludes the PRIMARY revision (the one whose hash the `agent_components`
 * display row already carries) — those bytes ship as `content`/`contentHash`,
 * and re-sending them would both double the payload and re-upsert the identical
 * cloud version row. A revision with no hash is skipped; an EMPTY body is NOT —
 * the collector hashes and persists an empty definition as a valid retained
 * revision, and dropping it here would silently withhold a real hash from the
 * cloud (wongk, #4295).
 *
 * The budget is the load-bearing guard: the transport chunker DEAD-LETTERS any
 * single component whose serialized JSON exceeds ~248 KiB, dropping its existence
 * row from the cloud entirely. Filling variants unbudgeted would push exactly the
 * components this lane targets over that ceiling — a strict regression on the
 * rows it means to enrich.
 *
 * `budgetBytes` is therefore what the CALLER measured is actually left for this
 * component after its own serialized size, not a flat constant: summing
 * `content` + `contentHash` alone undercounts the wire cost, because the emitted
 * variant also carries `format`, both dates, and the JSON object keys themselves
 * (wongk, #4295). Each candidate is costed by serializing the variant object it
 * would emit.
 *
 * STOPS at the first over-budget revision (`break`, not `continue`). That is the
 * documented contract and the reason `loadAgentComponentVersions` orders
 * newest-first: the shipped set is the N most RECENT that fit, contiguously.
 * Skipping past an over-budget revision to pick up an older smaller one would
 * make the set a greedy subset instead — non-contiguous in the web version panel,
 * and unstable between syncs as bodies grow (closedloop-ai-stage, #4295).
 */
function selectSyncedVariants(
  rows: readonly SqliteAgentComponentVersionRow[],
  primaryContentHash: string | null,
  budgetBytes: number
): SelectedSyncedVariants {
  const variants: SyncedComponentVariant[] = [];
  let budget = 0;
  for (const row of rows) {
    // ISS-5029: the ELIGIBILITY filters run BEFORE the cap checks so a cap can
    // only be reported as bound by a revision that would otherwise have shipped.
    // With the entry-cap check first (as it was), a trailing primary-hash or
    // NULL-body row — neither of which is ever emitted — would have made the
    // marker claim a drop that never happened. Emitted output is unchanged: the
    // filters skip the same rows either way, and a family is bounded at
    // `VERSION_CANDIDATES_PER_FAMILY` rows, so this scans a handful more at most.
    if (!row.content_hash || row.content_hash === primaryContentHash) {
      continue;
    }
    if (row.content === null || row.content === undefined) {
      continue;
    }
    if (variants.length >= SYNCED_COMPONENT_VARIANTS_MAX) {
      // ISS-5029 (wongk, #4391): the ENTRY cap, reported as a family cap. Like
      // the SQL rank cap it only binds when the family holds more revisions than
      // one sync can carry, so it carries the same lower bound on this device's
      // holdings and the cloud can reconcile it into a proof.
      return {
        variants,
        truncatedBy: SyncedComponentVariantsTruncatedReason.FamilyCap,
      };
    }
    const variant: SyncedComponentVariant = {
      contentHash: row.content_hash,
      content: clampSyncedComponentContent(row.content),
      format: row.format ?? null,
      firstSeenAt: row.first_seen_at ?? null,
      lastSeenAt: row.last_seen_at ?? null,
    };
    const cost = serializedVariantByteSize(variant);
    if (budget + cost > budgetBytes) {
      // ISS-5029 (wongk, #4391): the BYTE budget, which is a materially weaker
      // signal than either family cap — it can bind at two shipped revisions on
      // a component with large bodies, and says nothing about how many revisions
      // this device holds. Reported distinctly so the cloud does not mistake it
      // for evidence that it is missing something.
      return {
        variants,
        truncatedBy: SyncedComponentVariantsTruncatedReason.ByteBudget,
      };
    }
    budget += cost;
    variants.push(variant);
  }
  // Every eligible revision the loader handed us shipped: nothing was dropped
  // HERE. The SQL rank cap is reported separately by `partitionCappedFamilies`.
  return { variants, truncatedBy: null };
}

/**
 * The wire cost of one emitted variant: its ACTUAL serialized JSON size,
 * including every key and delimiter, plus one byte for the array comma.
 *
 * `JSON.stringify` is used directly rather than summing
 * {@link serializedJsonUtf8ByteSize} over the value strings, because the
 * undercount that motivated this was precisely the non-body fields
 * (wongk, #4295). `Buffer.byteLength` measures the already-escaped string, so no
 * escape-inflation correction is needed on top.
 */
function serializedVariantByteSize(variant: SyncedComponentVariant): number {
  return Buffer.byteLength(JSON.stringify(variant), "utf8") + 1;
}

/**
 * The serialized bytes still available to this component's `variants[]` after
 * its own fields are accounted for.
 *
 * Measured against the real per-component ceiling the chunker enforces, less a
 * headroom margin, and additionally capped by
 * {@link SYNCED_COMPONENT_VARIANTS_MAX_SERIALIZED_BYTES} so one fat component
 * cannot spend the entire request on revision history. Returns 0 when the
 * component is already at or over the ceiling on its own — in which case it ships
 * exactly as it does today, without variants, rather than being dead-lettered.
 */
function remainingVariantBudgetBytes(component: SyncedComponent): number {
  const ownBytes = Buffer.byteLength(JSON.stringify(component), "utf8");
  const remaining =
    SYNCED_COMPONENT_MAX_SERIALIZED_BYTES -
    SYNCED_COMPONENT_VARIANTS_BUDGET_HEADROOM_BYTES -
    ownBytes;
  if (remaining <= 0) {
    return 0;
  }
  return Math.min(remaining, SYNCED_COMPONENT_VARIANTS_MAX_SERIALIZED_BYTES);
}

/**
 * Load and pack the `SyncedComponent` rows for one component-sync batch,
 * including any ISS-4662 retained variants.
 *
 * `variants` is OMITTED (never `[]`, never `null`) when a component has no extra
 * revisions — the overwhelmingly common case — so the payload stays byte-for-byte
 * identical to today's for every unaffected component and the field costs
 * nothing on the wire.
 */
export async function loadSyncedComponentRows(
  prisma: DesktopPrisma,
  ids: string[]
): Promise<SyncedComponent[]> {
  const rows = await loadAgentComponents(prisma, ids);
  const components = rows.map(mapAgentComponentToSynced);
  const { grouped: versionsByFamily, cappedFamilies } =
    await loadAgentComponentVersions(
      prisma,
      components.map((component) => ({
        componentKind: component.componentKind,
        componentKey: component.componentKey ?? component.externalId,
      }))
    );
  for (const component of components) {
    const familyKey = versionFamilyKey(
      component.componentKind,
      component.componentKey ?? component.externalId
    );
    // ISS-5029: the SQL rank cap is recorded from pass 1 alone, so it is known
    // even when pass 2 came back with no bodies for this family — a retention
    // prune racing between the two passes empties the grouped bucket, and
    // evaluating the marker AFTER the `!family` guard below would then report
    // that identity as untruncated. That is exactly the "capped set presented as
    // complete" failure this ticket exists to remove, so it is set first
    // (closedloop-ai review, ISS-5029).
    //
    // Written for EVERY component, `false` included (wongk, #4391): this packer
    // knows the answer, so it states it, and the cloud writer treats an explicit
    // `false` as "clear any stored claim" while treating ABSENCE as "a desktop
    // with no opinion — leave the stored value alone". Emitting nothing here
    // would make those two indistinguishable and strand a `true` forever.
    applyVariantsTruncation(
      component,
      cappedFamilies.has(familyKey)
        ? SyncedComponentVariantsTruncatedReason.FamilyCap
        : null
    );
    const family = versionsByFamily.get(familyKey);
    if (!family) {
      continue;
    }
    // ISS-4662: forward the PRIMARY revision's own local first-observation, so
    // the cloud seeds its version row with the same meaning the variants carry
    // instead of stamping it with the sync time (closedloop-ai-stage, #4295).
    const primary = component.contentHash
      ? family.find((row) => row.content_hash === component.contentHash)
      : undefined;
    if (primary?.first_seen_at) {
      component.contentFirstSeenAt = primary.first_seen_at;
    }
    const selected = selectSyncedVariants(
      family,
      component.contentHash ?? null,
      remainingVariantBudgetBytes(component)
    );
    if (selected.variants.length > 0) {
      component.variants = selected.variants;
    }
    // ISS-5029: the packing loop's own caps (entry cap / byte budget); the SQL
    // rank cap was applied above. `applyVariantsTruncation` keeps the stronger
    // reason, so a family that ALSO rank-capped is not downgraded to
    // `byte_budget` by a budget stop on the rows it did load.
    applyVariantsTruncation(component, selected.truncatedBy);
  }
  return components;
}

/**
 * ISS-4662 + ISS-5029: the retained revisions for one sync batch, grouped by
 * family, plus the families whose SQL rank cap bound (so at least one retained
 * revision was never even considered for packing).
 */
type LoadedAgentComponentVersions = {
  grouped: Map<string, SqliteAgentComponentVersionRow[]>;
  cappedFamilies: Set<string>;
};

/**
 * ISS-5029: the variants one component will ship, plus WHICH cap dropped an
 * eligible retained revision while packing them, if any.
 *
 * `truncatedBy: null` is a real claim, not a default: it means every eligible
 * revision the loader supplied shipped.
 */
type SelectedSyncedVariants = {
  variants: SyncedComponentVariant[];
  truncatedBy: SyncedComponentVariantsTruncatedReason | null;
};

/**
 * ISS-5029 (wongk, #4391): fold one cap verdict into the component's wire
 * marker.
 *
 * Two caps are evaluated per component — the SQL rank cap from pass 1 and the
 * packing loop's entry-cap/byte-budget stop — and they must combine without
 * either losing information:
 *
 *  - `variantsTruncated` is MONOTONIC across the two calls: once a cap has bound
 *    for this component, a later `null` verdict cannot clear it. Only the FIRST
 *    call (which always runs, for every component) can write `false`.
 *  - the REASON keeps the stronger of the two.
 *    {@link SyncedComponentVariantsTruncatedReason.FamilyCap} is stronger
 *    because it bounds how many revisions this device holds and is therefore the
 *    only reason the cloud can turn into a proof; `byte_budget` bounds nothing.
 *    Letting a later budget stop overwrite a family cap would silently downgrade
 *    provable partiality to unprovable.
 *
 * The reason rides only with `true` — it is meaningless otherwise, and omitting
 * it keeps the untruncated payload one boolean wider than before rather than two
 * fields wider.
 */
function applyVariantsTruncation(
  component: SyncedComponent,
  reason: SyncedComponentVariantsTruncatedReason | null
): void {
  if (reason === null) {
    component.variantsTruncated = component.variantsTruncated === true;
    return;
  }
  const keepsFamilyCap =
    component.variantsTruncatedReason ===
    SyncedComponentVariantsTruncatedReason.FamilyCap;
  component.variantsTruncated = true;
  component.variantsTruncatedReason = keepsFamilyCap
    ? SyncedComponentVariantsTruncatedReason.FamilyCap
    : reason;
}
