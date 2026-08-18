/**
 * Direct SQLite seeding for the desktop AGENT-COMPONENT detail E2E specs.
 *
 * Sibling of `seed-branches-db.ts` / `seed-loc-per-dollar-db.ts`, and its own
 * module for the same reason ISS-4896 pulled `desktop-seed-core.ts` out of the
 * first of those: a new seeding concern lands beside them rather than growing an
 * already-large file (AGENTS.md "File Size and Organization").
 *
 * Until ISS-5029 the desktop e2e corpus could seed sessions, branches and plans
 * but NOT the component inventory — `agents-loc-per-dollar-display.spec.ts` says
 * so explicitly, and `all-views-smoke-seeded.spec.ts` drives the agent-detail
 * route at a deliberately MISSING slug because "agent detail has no seed". This
 * module supplies the smallest corpus that puts a real component detail page on
 * screen: one `agent_components` row carrying a captured definition body.
 *
 * That single row is enough because `getAgentComponentDetailLocal`
 * (`src/main/dashboard/shared-agent-components-api.ts`) resolves the detail from
 * the live inventory (`INVENTORY_SELECT`, i.e. `uninstalled_at IS NULL`) and
 * lets every usage/session aggregate come back empty; the Definition panel is
 * gated only on the component KIND and its captured `content`.
 *
 * Substrate contract is `desktop-seed-core.ts`'s, unchanged: open a SECOND
 * `@libsql/client` connection on the app's own `agent-dashboard.sqlite` (the
 * same WAL-mode file, which supports multi-process access), apply the app's own
 * PRAGMAs, wait for the db host's asynchronous post-launch migration to finish,
 * write one batch, then checkpoint the WAL so a later launch reads the rows
 * straight from the main db file.
 */

import { createClient } from "@libsql/client";
import {
  applyDesktopBusyTimeout,
  applyDesktopSeedPragmas,
  branchesDbPath,
  SEED_SCHEMA_TIMEOUT_MS,
  waitForMigrationsApplied,
} from "./desktop-seed-core";

/** One local component-inventory row, as the Agents detail route resolves it. */
export type AgentComponentSeed = {
  /** `agent_components.id` — any stable local identity. */
  id: string;
  /** `agent_components.component_kind`, e.g. `subagent`. Drives the slug. */
  kind: string;
  /**
   * `agent_components.component_key`. Seed it already lowercase/trimmed so the
   * org-identity slug (`encodeComponentSlug`, which normalizes the key) is
   * exactly `${kind}::${key}` and the spec can route to it without re-deriving
   * the normalization.
   */
  key: string;
  /** Display name shown in the detail header. */
  name: string;
  /** The captured definition text the Definition panel renders. */
  content: string;
  /** `agent_components.harness`, e.g. `claude`. */
  harness: string;
  /** `agent_components.source` — the repo/pack the component came from. */
  source: string;
};

/**
 * Block until the launched app has FULLY migrated its store.
 *
 * Call while the app is UP, so the caller knows migrations finished before it
 * closes the app to seed — seeding happens with the app DOWN because a running
 * app does not reliably observe a test-process write, while the reverse
 * (reading the app's committed schema across processes) is fine. Mirrors
 * `waitForBranchesSchema`, but holds the COMPLETE migration barrier rather than
 * a table/column proxy that can silently under-wait.
 */
export async function waitForAgentComponentsSchema(
  userDataDir: string,
  timeoutMs = SEED_SCHEMA_TIMEOUT_MS
): Promise<void> {
  const client = createClient({
    url: `file:${branchesDbPath(userDataDir)}`,
    intMode: "number",
  });
  try {
    await applyDesktopBusyTimeout(client);
    await waitForMigrationsApplied(client, timeoutMs);
  } finally {
    client.close();
  }
}

/**
 * Seed ONE live component-inventory row straight into the launched app's real
 * SQLite store, so the app's own local IPC `AgentComponentsDataSource` resolves
 * a genuine detail page for `#/agents/${kind}::${key}`.
 *
 * Deliberately writes NO `agent_component_session_usage` rows: the detail read
 * treats an inventory row with no usage as a real component with zero recorded
 * invocations, which is all the Definition panel needs, and every extra table a
 * seeder touches is another schema it can drift against.
 */
export async function seedAgentComponent(
  userDataDir: string,
  seed: AgentComponentSeed,
  options: { schemaTimeoutMs?: number } = {}
): Promise<void> {
  const dbPath = branchesDbPath(userDataDir);
  const client = createClient({ url: `file:${dbPath}`, intMode: "number" });
  try {
    await applyDesktopSeedPragmas(client);
    // The whole migration history, not a table/column proxy: `content` and
    // `resolved_state` arrive in migrations well after `agent_components`
    // itself, and a proxy wait silently under-waits (see the docstring on
    // `waitForMigrationsApplied`).
    await waitForMigrationsApplied(
      client,
      options.schemaTimeoutMs ?? SEED_SCHEMA_TIMEOUT_MS
    );

    const observedAt = new Date().toISOString();
    await client.batch(
      [
        {
          sql: `INSERT INTO agent_components
                  (id, component_kind, external_id, component_key, name,
                   harness, source, description, content, content_hash,
                   resolved_state, first_seen_at, last_seen_at)
                VALUES (?, ?, ?, ?, ?,
                        ?, ?, ?, ?, ?,
                        'resolved', ?, ?)`,
          args: [
            seed.id,
            seed.kind,
            `${seed.kind}:${seed.key}`,
            seed.key,
            seed.name,
            seed.harness,
            seed.source,
            seed.name,
            seed.content,
            contentHashFor(seed),
            observedAt,
            observedAt,
          ],
        },
      ],
      "write"
    );

    // Fold the committed row out of the -wal into the main db file so a later
    // launch reads it straight from the main db (same convention as every other
    // desktop seeder).
    await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    client.close();
  }
}

/**
 * A stable, deliberately NON-64-hex content fingerprint.
 *
 * `resolveDetailInventoryScope` treats a 64-hex slug segment as a possible
 * content-hash route; keeping the seeded hash short guarantees the spec's
 * `${kind}::${key}` slug takes the plain name-level path instead.
 */
function contentHashFor(seed: AgentComponentSeed): string {
  return `seedhash-${seed.kind}-${seed.key}`;
}

/**
 * One inventory row shaped for the ISS-5009 Source-provenance specs.
 *
 * Distinct from {@link AgentComponentSeed}, which exists to put a captured
 * DEFINITION on screen and therefore requires `content`. This shape instead
 * makes every provenance column addressable and OPTIONAL, because the whole
 * point of the spec is the row that has none of them: `external_id` is the
 * terminal of the legacy `displaySource` chain, so a row with no `pack_id`,
 * `source_url` or `scope` is exactly the one that echoes its own identifier
 * into the Source column today.
 */
export type AgentComponentProvenanceSeed = {
  /** `agent_components.id` — stable row identity. */
  id: string;
  /** `agent_components.component_kind`, e.g. `subagent`. */
  componentKind: string;
  /** The collector-native identity, and the legacy echo terminal. */
  externalId: string;
  /** Normalized org-identity key. Defaults to `externalId`. */
  componentKey?: string;
  /** Display name. Defaults to `externalId`, i.e. Source echoes the name. */
  name?: string;
  /** `agent_components.harness`, e.g. `claude`. */
  harness?: string;
  /** Legacy display column. No desktop writer populates it; kept for coverage. */
  source?: string | null;
  /** The repository/remote the scanners actually record — real provenance. */
  sourceUrl?: string | null;
  /** Local filesystem location. NOT provenance (see `agent-component-honest-source.ts`). */
  installPath?: string | null;
  packId?: string | null;
  scope?: string | null;
  projectPath?: string | null;
};

/**
 * Seed several live inventory rows carrying explicit provenance columns.
 *
 * Same substrate and same call position as {@link seedAgentComponent} — app
 * DOWN, between two `launchDesktopApp` calls against one `userDataDir` — and it
 * holds the same COMPLETE migration barrier rather than a table/column proxy
 * that can silently under-wait.
 */
export async function seedAgentComponents(
  userDataDir: string,
  components: AgentComponentProvenanceSeed[],
  options: { schemaTimeoutMs?: number } = {}
): Promise<void> {
  const dbPath = branchesDbPath(userDataDir);
  const client = createClient({ url: `file:${dbPath}`, intMode: "number" });
  try {
    await applyDesktopSeedPragmas(client);
    await waitForMigrationsApplied(
      client,
      options.schemaTimeoutMs ?? SEED_SCHEMA_TIMEOUT_MS
    );

    const observedAt = new Date().toISOString();
    await client.batch(
      components.map((component) => ({
        sql: `INSERT INTO agent_components
                (id, component_kind, external_id, component_key, name, harness,
                 source, source_url, install_path, pack_id, scope, project_path,
                 resolved_state, first_seen_at, last_seen_at, uninstalled_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'resolved', ?, ?, NULL)`,
        args: [
          component.id,
          component.componentKind,
          component.externalId,
          component.componentKey ?? component.externalId,
          component.name ?? component.externalId,
          component.harness ?? "claude",
          component.source ?? null,
          component.sourceUrl ?? null,
          component.installPath ?? null,
          component.packId ?? null,
          component.scope ?? null,
          component.projectPath ?? null,
          observedAt,
          observedAt,
        ],
      })),
      "write"
    );

    await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    client.close();
  }
}

/**
 * One inventory row with NO captured definition body, for the ISS-5500
 * absence-reason spec.
 *
 * Distinct from {@link AgentComponentSeed}, which exists to put a captured
 * definition ON screen and therefore requires `content`. This shape is the
 * opposite case, and it has to control two columns that seeder hard-codes:
 *
 *  - `content` AND `description` are both NULL. `getAgentComponentDetailLocal`
 *    emits `prompt: content ?? description` for prompt-kinds, so seeding a null
 *    `content` alone is not enough — the row's `description` would arrive as the
 *    panel body and the empty state would never render at all.
 *  - `resolved_state` is the input under test. The other seeder pins
 *    `'resolved'`; this spec's whole point is that two different states must
 *    produce two different panels.
 *
 * `content_hash` is NULL too: a row with no captured body has nothing to
 * fingerprint, and a hash-less row is the legacy/event-minted shape the detail
 * read already handles.
 */
export type BodylessAgentComponentSeed = {
  /** `agent_components.id` — any stable local identity. */
  id: string;
  /** `agent_components.component_kind`, e.g. `subagent`. Drives the slug. */
  kind: string;
  /** `agent_components.component_key`, already lowercase/trimmed. */
  key: string;
  /** Display name shown in the detail header. */
  name: string;
  /** `agent_components.harness`, e.g. `claude`. */
  harness: string;
  /** `agent_components.source` — the repo/pack the component came from. */
  source: string;
  /** `agent_components.resolved_state` — the column this spec varies. */
  resolvedState: string;
};

/**
 * Seed one component that has NO definition body, at a chosen resolution state.
 *
 * Same substrate contract as {@link seedAgentComponent}: wait for the COMPLETE
 * migration history (both `content` and `resolved_state` arrive well after
 * `agent_components` itself), write one batch, checkpoint the WAL.
 */
export async function seedBodylessAgentComponent(
  userDataDir: string,
  seed: BodylessAgentComponentSeed,
  options: { schemaTimeoutMs?: number } = {}
): Promise<void> {
  const dbPath = branchesDbPath(userDataDir);
  const client = createClient({ url: `file:${dbPath}`, intMode: "number" });
  try {
    await applyDesktopSeedPragmas(client);
    await waitForMigrationsApplied(
      client,
      options.schemaTimeoutMs ?? SEED_SCHEMA_TIMEOUT_MS
    );

    const observedAt = new Date().toISOString();
    await client.batch(
      [
        {
          sql: `INSERT INTO agent_components
                  (id, component_kind, external_id, component_key, name,
                   harness, source, description, content, content_hash,
                   resolved_state, first_seen_at, last_seen_at)
                VALUES (?, ?, ?, ?, ?,
                        ?, ?, NULL, NULL, NULL,
                        ?, ?, ?)`,
          args: [
            seed.id,
            seed.kind,
            `${seed.kind}:${seed.key}`,
            seed.key,
            seed.name,
            seed.harness,
            seed.source,
            seed.resolvedState,
            observedAt,
            observedAt,
          ],
        },
      ],
      "write"
    );

    await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    client.close();
  }
}
