/**
 * curated-catalog.ts — seeds ClosedLoop-managed global CatalogItem rows.
 *
 * Curated items have `source='curated'` and `organizationId IS NULL` (global
 * scope, visible to all orgs). They are NEVER reset by `resetOrgData` and NEVER
 * included in org-specific seed modules. This function is idempotent — it upserts
 * on the stable deterministic UUID so re-runs produce no duplicate rows.
 *
 * T-22.4: register the bundled Token Coach as a curated CatalogItem so the
 * distribution platform can reference it without a DB lookup against the desktop
 * resource files. The `coachingConfig.signals[]` payload is inlined verbatim from
 * `apps/desktop/resources/coaching-packs/claude-code-token-coach/coaching-pack.json`.
 */

import type { PrismaClient } from "../../generated/client";
import type { TransactionClient } from "../../generated/internal/prismaNamespace";
import {
  createUpsertCounts,
  deterministicUuid,
  logUpsertSummary,
  seedLog,
  upsertRow,
} from "./helpers";

// ---------------------------------------------------------------------------
// Token Coach signals (verbatim from coaching-pack.json — T-22.4)
// ---------------------------------------------------------------------------
const TOKEN_COACH_SIGNALS: string[] = [
  "Cache efficiency is the single biggest lever: a cache read costs ~10% of a normal input token and a cache write ~25% more, so keep the stable prefix (system prompt, CLAUDE.md, tool defs, earlier turns) put. Churning it — swapping MCP servers mid-session, editing CLAUDE.md mid-task, frequent restarts — forces expensive full re-writes. Coach toward a steady prefix and quantify cache-read share.",
  "Targeted reads beat whole-file reads: prefer ranged/offset Reads and Grep-to-locate over re-scanning entire large files. Quantify how many input tokens repeated full reads cost and recommend reading only the needed span.",
  "Output-size discipline matters because generated tokens are the most expensive: ask for diffs or specific functions instead of whole files echoed back, and flag turns that emit large unnecessary output.",
  "Context discipline is the most user-controlled lever: /clear between unrelated tasks resets context to near zero, and /compact <focus note> before forced auto-compaction avoids a lossy, token-heavy compaction. Coach on peak per-session input and compaction count.",
  "Model right-sizing: top-tier models cost ~5x a mid-tier model on input, output, and cache. Default to the mid tier, escalate only for genuinely hard reasoning, and use the smallest tier for trivial edits. Present as 'consider', estimate the savings for structurally trivial top-tier turns, never a verdict.",
  "Tool error rate: every failed tool call re-sends context for the call, the error, and the retry. Reduce malformed edits and stale references; prefer one correct call over speculative ones.",
  "Native search over shell: Grep/Glob/Read are scoped and cache-friendlier than unbounded cat/grep/find/ls via Bash. Suggest a CLAUDE.md steering line when shell search is frequent.",
  "Avoid redundant reads: a second Read of the same path with no intervening edit re-sends the file for no new information. Trust the prior read unless the file changed on disk.",
  "Parallel batching: independent tool calls issued in one message share a single round-trip; serializing them re-bills the context per call. Coach toward batching independent calls.",
  "Subagent offloading: a subagent's noisy exploration stays in its own context and only the conclusion returns. For broad multi-file exploration, delegate and return only conclusions.",
];

// Stable deterministic ID for the curated Token Coach CatalogItem.
// This key must never change — the desktop uses the slug to reconcile
// an existing active.json pointing at 'claude-code-token-coach'.
const TOKEN_COACH_CATALOG_ITEM_ID = deterministicUuid(
  "curated:catalog-item:token-coach:claude-code-token-coach"
);

type SeedClient = PrismaClient | TransactionClient;

/**
 * Upserts all ClosedLoop-managed curated CatalogItem rows.
 *
 * Safe to call outside an org transaction — curated items have a null
 * organizationId and are org-scoping–exempt. Idempotent.
 */
export async function seedCuratedCatalogItems(
  prisma: SeedClient
): Promise<void> {
  const counts = createUpsertCounts();

  seedLog("Seeding curated CatalogItem rows (Token Coach)…");

  // -------------------------------------------------------------------------
  // Token Coach — curated, coaching=true, global scope (T-22.4)
  // -------------------------------------------------------------------------
  await upsertRow({
    model: "CatalogItem",
    id: TOKEN_COACH_CATALOG_ITEM_ID,
    upsert: () =>
      (prisma as PrismaClient).catalogItem.upsert({
        where: { id: TOKEN_COACH_CATALOG_ITEM_ID },
        create: {
          id: TOKEN_COACH_CATALOG_ITEM_ID,
          // organizationId IS NULL → global/curated; never org-scoped.
          organizationId: null,
          targetKind: "plugin",
          source: "curated",
          scope: "global",
          name: "Token Coach",
          description:
            "Token-optimization coaching pack. Replaces the built-in agentic-development signals with the Token Coach rubric (cache efficiency, targeted reads, output discipline, context hygiene, model right-sizing, and tool-error reduction) so coaching tips push concrete, quantified token savings.",
          version: "1.0.0",
          enabled: true,
          coaching: true,
          coachingConfig: { signals: TOKEN_COACH_SIGNALS },
          // No S3 assets yet; ClosedLoop provides the zip asset separately.
          zipAssetBucket: null,
          zipAssetKey: null,
          logoAssetBucket: null,
          logoAssetKey: null,
        },
        update: {
          // Keep name/description/version/signals current on re-runs.
          name: "Token Coach",
          description:
            "Token-optimization coaching pack. Replaces the built-in agentic-development signals with the Token Coach rubric (cache efficiency, targeted reads, output discipline, context hygiene, model right-sizing, and tool-error reduction) so coaching tips push concrete, quantified token savings.",
          version: "1.0.0",
          enabled: true,
          coaching: true,
          coachingConfig: { signals: TOKEN_COACH_SIGNALS },
        },
      }),
    counts,
  });

  logUpsertSummary(counts);
  seedLog("Curated catalog seed complete.");
}

export { TOKEN_COACH_CATALOG_ITEM_ID };
