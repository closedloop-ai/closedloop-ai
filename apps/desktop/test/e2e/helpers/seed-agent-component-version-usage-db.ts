/**
 * ISS-10467: direct SQLite seeding for the desktop per-CONTENT-VERSION usage
 * drill-down spec.
 *
 * Its own module rather than a widening of `seed-agent-component-usage-db.ts`
 * for the reason that module already gives for its own existence: that corpus
 * deliberately writes a NULL `component_version_hash` on every usage row so the
 * whole thing stays on ONE name-level identity bucket, which is exactly the
 * shape this spec must NOT have.
 *
 * TWO DIGEST SPACES, AND SEEDING THEM THE SAME IS THE TRAP. The version selector
 * offers `agent_component_versions.content_hash` — a raw content digest — while
 * `agent_component_session_usage.component_version_hash` is stamped at
 * invocation with `computeDefinitionHash({ frontmatter: "", body, kind })`. They
 * never agree for the same file, so a fixture that put one string in both
 * columns would pass against either scoping and prove nothing about the
 * translation the read exists to perform. {@link usageDigestFor} is therefore
 * the ONLY thing written into the usage column here, and the version rows carry
 * a deliberately unrelated `content_hash`.
 *
 * `computeDefinitionHash` is imported from `@repo/api/src/definition-fingerprint.ts`
 * WITH the extension: Playwright's ESM loader does not resolve the
 * extension-less specifiers the desktop's own shared modules use, and a
 * spec-level import failure aborts the whole desktop-e2e suite at load time.
 */

import { createClient, type InStatement } from "@libsql/client";
import { computeDefinitionHash } from "@repo/api/src/definition-fingerprint.ts";
import type { AgentComponentKind } from "@repo/api/src/types/agent-component.ts";
import {
  applyDesktopSeedPragmas,
  branchesDbPath,
  SEED_SCHEMA_TIMEOUT_MS,
  waitForMigrationsApplied,
} from "./desktop-seed-core";

/** One `agent_component_versions` revision plus the usage recorded against it. */
export type AgentComponentVersionSeed = {
  /** The `content_hash` the version selector offers — deliberately NOT a digest. */
  contentHash: string;
  /** The captured definition body. Its digest is what the usage rows carry. */
  content: string;
  /** Per-session invocation counts recorded against THIS revision. */
  usage: readonly { sessionId: string; invocations: number }[];
};

/** A component whose local history carries more than one revision. */
export type AgentComponentVersionUsageSeed = {
  /** `agent_components.id`, and the FK every usage row below is linked to. */
  id: string;
  kind: AgentComponentKind;
  /** Already lowercase/trimmed — the slug and the SQL fold must agree. */
  key: string;
  name: string;
  harness: string;
  revisions: readonly AgentComponentVersionSeed[];
};

/** The usage-space digest one revision's rows are stamped with. */
export function usageDigestFor(
  content: string,
  kind: AgentComponentKind
): string {
  return computeDefinitionHash({ frontmatter: "", body: content, kind })
    .definitionHash;
}

/**
 * Seed one component, its revision history, and version-scoped usage.
 *
 * The app must be DOWN: a running app does not reliably observe a test-process
 * write, while reading its committed schema across processes is fine (the
 * substrate contract `desktop-seed-core.ts` states).
 */
export async function seedAgentComponentVersionUsage(
  userDataDir: string,
  seed: AgentComponentVersionUsageSeed,
  options: { schemaTimeoutMs?: number } = {}
): Promise<void> {
  const client = createClient({
    intMode: "number",
    url: `file:${branchesDbPath(userDataDir)}`,
  });
  try {
    await applyDesktopSeedPragmas(client);
    await waitForMigrationsApplied(
      client,
      options.schemaTimeoutMs ?? SEED_SCHEMA_TIMEOUT_MS
    );
    const observedAt = new Date().toISOString();
    await client.batch(versionUsageStatements(seed, observedAt), "write");
    await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    client.close();
  }
}

function versionUsageStatements(
  seed: AgentComponentVersionUsageSeed,
  observedAt: string
): InStatement[] {
  const current = seed.revisions.at(-1);
  const statements: InStatement[] = [
    {
      // `content_hash` is the CURRENT revision's, so the detail's inventory row
      // and its history agree about which revision is live.
      sql: `INSERT INTO agent_components
              (id, component_kind, external_id, component_key, name, harness,
               source, description, content, content_hash, resolved_state,
               first_seen_at, last_seen_at)
            VALUES (?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, 'resolved', ?, ?)`,
      args: [
        seed.id,
        seed.kind,
        `${seed.kind}:${seed.key}`,
        seed.key,
        seed.name,
        seed.harness,
        "acme/app",
        seed.name,
        current?.content ?? "",
        current?.contentHash ?? "",
        observedAt,
        observedAt,
      ],
    },
  ];
  for (const revision of seed.revisions) {
    statements.push({
      sql: `INSERT INTO agent_component_versions
              (id, component_kind, component_key, source, content_hash, content,
               format, first_seen_at, last_seen_at)
            VALUES (?, ?, ?, '', ?, ?, 'md', ?, ?)`,
      args: [
        `v-${revision.contentHash}`,
        seed.kind,
        seed.key,
        revision.contentHash,
        revision.content,
        observedAt,
        observedAt,
      ],
    });
    for (const usage of revision.usage) {
      statements.push({
        sql: `INSERT INTO agent_component_session_usage
                (session_id, component_kind, component_key, git_branch,
                 agent_component_id, harness, invocations, error_count,
                 component_version_hash, first_invoked_at, last_invoked_at,
                 started_day)
              VALUES (?, ?, ?, '',
                      ?, ?, ?, 0,
                      ?, ?, ?, ?)`,
        args: [
          usage.sessionId,
          seed.kind,
          seed.key,
          seed.id,
          seed.harness,
          usage.invocations,
          usageDigestFor(revision.content, seed.kind),
          observedAt,
          observedAt,
          observedAt.slice(0, 10),
        ],
      });
    }
  }
  return statements;
}
