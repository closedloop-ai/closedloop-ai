/**
 * @file agent-components-test-fixtures.ts
 * @description Shared seed helpers for the desktop-local agent-components
 * suites: insert one `agent_components` inventory row, or one
 * `agent_component_session_usage` row, into a store opened with
 * `openTestPrisma`.
 *
 * Extracted from `shared-agent-components-api.test.ts` when the honest-Source
 * tests (ISS-5009) moved into their own file: both suites need the same two
 * INSERTs, and the repo convention is to extract a shared test fixture rather
 * than copy one. Deliberately NOT named `*.test.ts` — `scripts/run-node-tests.mjs`
 * globs `test/*.test.ts`, so a fixture module must not match that pattern.
 *
 * ISS-5520 (#4716) adds {@link insertInvocations} on the same rule: the
 * invocation-race suite needs the `agent_component_invocations` seed that
 * `shared-agent-components-api.test.ts` had kept private, so it moved here
 * rather than being copied into a second file.
 */

import {
  type AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  type AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
} from "@repo/api/src/types/agent-component-invocation";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";

/** One `agent_components` inventory row. Only `id`/`kind`/`externalId`/`key` are required. */
export type SeedComponentRow = {
  id: string;
  kind: string;
  externalId: string;
  key: string | null;
  name?: string | null;
  harness?: string | null;
  packId?: string | null;
  scope?: string | null;
  projectPath?: string | null;
  installPath?: string | null;
  /**
   * The LEGACY `source` column. Despite the name, NO desktop writer populates
   * it — the scanners all write `source_url` (see {@link SeedComponentRow.sourceUrl}).
   * It is bound rather than hardcoded NULL only so a test can seed the
   * legacy-shaped row that the honest chain's trailing `source` fallback exists
   * to keep honouring. Do not reach for it to mean "this component came from a
   * repo"; that is `sourceUrl`.
   */
  source?: string | null;
  /**
   * ISS-5009: the `source_url` column — the repository/remote the desktop
   * writers ACTUALLY record (`component-scanner.ts:202`/`:466`,
   * `mcp-discovery.ts:354`, `definition-content-collector.ts:770`). This is the
   * desktop twin of the cloud's `sourceUrl`, so it is the column a realistic
   * repo-provenance fixture must set.
   */
  sourceUrl?: string | null;
  description?: string | null;
  uninstalledAt?: string | null;
  // FEA-3982 (Slice 2): the coarse version fingerprint. Two same-named rows
  // with distinct hashes must split into two list rows carrying distinct
  // `versionId`s; a null hash keeps the name-only identity.
  contentHash?: string | null;
};

/** One `agent_component_session_usage` row. */
export type SeedUsageRow = {
  sessionId: string;
  kind: string;
  key: string;
  invocations: number;
  lastInvokedAt?: string;
  firstInvokedAt?: string;
  harness?: string | null;
  versionHash?: string | null;
  /**
   * ISS-6180: the authoritative `agent_component_id` FK — the exact inventory row
   * the writer linked this usage to. Left null by default (the orphan shape most
   * fixtures want); set it to seed the rows whose pack attribution must come from
   * the FK rather than the (kind, key) fallback.
   */
  agentComponentId?: string | null;
};

export async function insertComponent(
  prisma: DesktopPrisma,
  row: SeedComponentRow
): Promise<void> {
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO agent_components
         (id, component_kind, external_id, component_key, name, harness,
          source, source_url, description, install_path, pack_id, scope,
          project_path, content_hash, first_seen_at, last_seen_at, uninstalled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
               '2026-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', $15)`,
      row.id,
      row.kind,
      row.externalId,
      row.key,
      row.name ?? row.key,
      row.harness ?? "claude",
      row.source ?? null,
      row.sourceUrl ?? null,
      row.description ?? null,
      row.installPath ?? null,
      row.packId ?? null,
      row.scope ?? null,
      row.projectPath ?? null,
      row.contentHash ?? null,
      row.uninstalledAt ?? null
    )
  );
}

export async function insertUsage(
  prisma: DesktopPrisma,
  row: SeedUsageRow
): Promise<void> {
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO agent_component_session_usage
         (session_id, component_kind, component_key, agent_component_id,
          invocations, error_count,
          harness, component_version_hash, first_invoked_at, last_invoked_at, started_day)
       VALUES ($1, $2, $3, $9, $4, 0, $5, $6, $7, $8, '2026-06-01')`,
      row.sessionId,
      row.kind,
      row.key,
      row.invocations,
      row.harness ?? null,
      row.versionHash ?? null,
      row.firstInvokedAt ?? row.lastInvokedAt ?? "2026-06-01T00:00:00.000Z",
      row.lastInvokedAt ?? "2026-06-01T00:00:00.000Z",
      row.agentComponentId ?? null
    )
  );
}

/** One `agent_component_invocations` row. */
export type InvocationSeed = {
  id: string;
  sessionId: string;
  componentKind: AgentComponentInvocationKind;
  componentKey: string;
  rawName?: string | null;
  normalizedName?: string | null;
  relationship?: AgentComponentInvocationRelationship;
  childSessionId?: string | null;
  invokedAt?: string | null;
  sequence?: number;
  anchorKind: AgentComponentInvocationAnchorKind;
  anchorValue: string;
  providerToolUseId?: string | null;
  status?: AgentComponentInvocationAttributionStatus;
  evidenceClass?: AgentComponentInvocationEvidenceClass;
  evidencePointer?: Record<string, unknown> | null;
  definitionHash?: string | null;
  normalizerContractVersion?: number | null;
  localComponentId?: string | null;
  localComponentVersionId?: string | null;
  gitBranch?: string | null;
  repositoryFullName?: string | null;
};

const INVOCATION_SEED_INSERT = `INSERT INTO agent_component_invocations
   (id, session_id, external_invocation_id, external_source_id,
    child_session_id, agent_id, parent_agent_id, component_kind,
    component_key, raw_name, normalized_name, relationship, invoked_at,
    sequence, anchor_kind, anchor_value, provider_tool_use_id,
    attribution_status, evidence_class, evidence_pointer,
    definition_hash, normalizer_contract_version, definition_content,
    local_component_id, local_component_version_id, git_branch,
    repository_full_name, created_at, updated_at)
 VALUES ($1, $2, $3, NULL, $4, NULL, NULL, $5, $6, $7, $8, $9,
         $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, NULL,
         $20, $21, $22, $23, $24, $24)`;

/**
 * Bind one seed row to {@link INVOCATION_SEED_INSERT}'s positional parameters.
 *
 * Split out from the writer purely so each stays under the cognitive-complexity
 * ceiling: the defaults below are one `??` per optional column, which the rule
 * counts individually and which read as a table, not as branching logic.
 */
function invocationSeedParams(
  row: InvocationSeed
): Array<string | number | null> {
  return [
    row.id,
    row.sessionId,
    row.id,
    row.childSessionId ?? null,
    row.componentKind,
    row.componentKey,
    row.rawName ?? null,
    row.normalizedName ?? null,
    row.relationship ?? AgentComponentInvocationRelationship.Direct,
    row.invokedAt ?? "2026-07-22T07:00:00.000Z",
    row.sequence ?? 0,
    row.anchorKind,
    row.anchorValue,
    row.providerToolUseId ?? null,
    row.status ?? AgentComponentInvocationAttributionStatus.Unresolved,
    row.evidenceClass ?? AgentComponentInvocationEvidenceClass.None,
    row.evidencePointer ? JSON.stringify(row.evidencePointer) : null,
    row.definitionHash ?? null,
    row.normalizerContractVersion ?? null,
    row.localComponentId ?? null,
    row.localComponentVersionId ?? null,
    row.gitBranch ?? null,
    row.repositoryFullName ?? null,
    "2026-07-22T13:00:00.000Z",
  ];
}

/**
 * Seed invocation rows, creating any missing `sessions` parent first so the
 * `session_id` foreign key holds.
 */
export async function insertInvocations(
  prisma: DesktopPrisma,
  rows: InvocationSeed[]
): Promise<void> {
  await prisma.write(async (client) => {
    for (const sessionId of new Set(rows.map((row) => row.sessionId))) {
      await client.$executeRawUnsafe(
        `INSERT OR IGNORE INTO sessions
           (id, name, status, started_at, updated_at, harness, billing_mode)
         VALUES ($1, $1, 'completed', $2, $2, 'claude', 'api')`,
        sessionId,
        "2026-07-22T00:00:00.000Z"
      );
    }
    for (const row of rows) {
      await client.$executeRawUnsafe(
        INVOCATION_SEED_INSERT,
        ...invocationSeedParams(row)
      );
    }
  });
}
