/**
 * Canonicalize a catalog member's raw `targetKind` string to the
 * {@link AgentComponentKind} the F1 definition fingerprint + registry key on
 * (FEA-3909 / PRD-527 F4).
 *
 * The catalog stores a subagent's kind as the literal `"agent"`, whereas the
 * device-sync path (and the F1 registry it feeds) stores the canonical
 * `"subagent"` — see `materializeCloudAgentComponent`'s `component_kind =
 * 'subagent'` mapping in `apps/api/app/catalog/service.ts`. Every other catalog
 * kind (`skill`/`command`/`hook`/`mcp`) already equals its `AgentComponentKind`
 * value.
 *
 * This mapping lives in `@repo/api/src` — NOT in the app — so BOTH the live
 * pack-import writer (`linkPackMemberDefinition` in `apps/api`) and the
 * conservative backfill (`upsertMemberVersion` in `packages/database/scripts`)
 * fold the SAME canonical kind into `computeDefinitionHash`. Without one shared
 * helper the two paths could drift and produce different `definitionHash` values
 * for byte-identical content — defeating F1 dedup.
 *
 * Client-safe and dependency-light (only the `AgentComponentKind` const), so it
 * resolves identically in the browser, the desktop renderer, the server, and a
 * Node database script.
 */

import { AgentComponentKind } from "./types/agent-component";

const CATALOG_KIND_ALIASES: Record<string, AgentComponentKind> = Object.assign(
  Object.create(null) as Record<string, AgentComponentKind>,
  {
    agent: AgentComponentKind.Subagent,
  }
);

/**
 * Map a catalog member's raw `targetKind` string to its canonical
 * {@link AgentComponentKind}. `"agent"` canonicalizes to
 * `AgentComponentKind.Subagent`; every other kind passes through unchanged
 * (already a canonical value). An unrecognized kind is folded under its own
 * literal — the pre-fix behavior for every non-`agent` kind — so an unexpected
 * catalog kind never crashes an import or backfill.
 */
export function catalogTargetKindToComponentKind(
  targetKind: string
): AgentComponentKind {
  return CATALOG_KIND_ALIASES[targetKind] ?? (targetKind as AgentComponentKind);
}
