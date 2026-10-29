import {
  POSTGRES_INT4_MAX,
  POSTGRES_INT4_MIN,
} from "@closedloop-ai/loops-api/column-limits";
import { SYNCED_COMPONENT_IDENTITY_MAX_CHARS } from "@repo/api/src/types/agent-session";
import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type { PromoteResponse } from "@repo/api/src/types/distribution";
import { z } from "zod";
import { requireOrgAdmin } from "@/lib/auth/org-admin";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import {
  recordNoOpUnlessRecorded,
  recordOrganizationWrite,
} from "@/lib/organization-write-receipt";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { promoteAgentComponent } from "./service";

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

/**
 * `catalog_items.target_kind` is a key column of
 * `@@index([organizationId, targetKind])`, a btree, so a multi-kilobyte value
 * raises SQLSTATE 54000 at INSERT and surfaces as a 500. That is the defect —
 * an unbounded string, not a wrong one.
 *
 * Bounded rather than enumerated, deliberately. Three facts make a closed enum
 * the wrong shape here:
 *   1. `promoteAgentComponent` resolves `input.targetKind ?? component.componentKind`
 *      and writes it verbatim, so the column's live domain already includes
 *      every `AgentComponentKind`, not just the seven catalog kinds.
 *   2. The shipped Promote button sends the component's own kind, so a catalog
 *      enum would 400 `subagent` and `workflow` outright.
 *   3. `agent_components.component_kind` is a free-form `String` whose cloud
 *      ingest bounds only its LENGTH, and the read path casts it to
 *      `AgentComponentKind`. A desktop shipping a kind this repo does not list
 *      yet lands it in the column and the UI forwards it here — so even a union
 *      of both const objects is a closed set over a column a peer can widen,
 *      which is exactly the version skew AGENTS.md forbids breaking on.
 *
 * The bound is `SYNCED_COMPONENT_IDENTITY_MAX_CHARS`, NOT a number chosen here.
 * That matters because the Promote button forwards `component.componentKind`
 * verbatim, so any bound below what the column can actually hold would 400 a
 * component the desktop legitimately synced and stored — a valid-input refusal,
 * which this ticket forbids.
 *
 * ISS-8201 removed the sync ingest's own `.max()` on this column, so the two
 * ends no longer agree by sharing a parser rule; they agree because of what the
 * ingest STORES. `toComponentIndexKeys` projects `componentKind` to
 * `INDEX_KEY_MAX_BYTES` (512 BYTES) before the write, and a 512-byte UTF-8
 * string is at most 512 characters, so every kind reachable in the column is
 * inside this cap. Do not re-derive this bound from the ingest's parser — that
 * parser no longer has one. It is still four decimal orders below the btree key
 * limit, so the 54000 hazard is closed either way.
 *
 * `.max()` ONLY — no `.trim()`, no `.min()`. `body.targetKind` flows unchanged
 * into `catalogItem.create`, so a `.trim()` here would be a TRANSFORM rewriting
 * a persisted index-key value, and a `.min(1)` would refuse the empty string
 * that today's bare `z.string()` accepts. Both are valid-input changes; this
 * ticket bounds the btree hazard and nothing else.
 */
const promoteSchema = z.object({
  agentComponentId: z.string().uuid(),
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
  targetKind: z.string().max(SYNCED_COMPONENT_IDENTITY_MAX_CHARS).optional(),
  // `CatalogItem.sortOrder` is a Prisma `Int`; unbounded, an out-of-range value
  // reached Prisma and surfaced as a 500.
  //
  // The floor is the COLUMN's, not the catalog route's `.min(0)`. `-1` is a
  // legal int4 this endpoint stores today, so refusing it would change
  // behaviour on valid input — the one thing ISS-8880 forbids. `-1e21` still
  // has to be refused (`Number.isInteger` says `true`, and it raises 22003 at
  // the driver), and the column floor is what refuses it.
  sortOrder: z
    .number()
    .int()
    .min(POSTGRES_INT4_MIN)
    .max(POSTGRES_INT4_MAX)
    .optional(),
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * POST /agent-components/promote
 *
 * Admin-only best-of-breed promotion: takes a discovered `AgentComponent`
 * (identified by its cloud UUID) and promotes it to a `CatalogItem` +
 * `Distribution` targeting ALL compute targets in the org.
 *
 * - Creates `CatalogItem` (source=org_custom, scope=org) + an initial
 *   `CatalogItemVersion` snapshotting the discovered component so the item is
 *   installable (not an empty payload).
 * - Creates `Distribution` (mode=auto_install, targetingType=all).
 * - Returns `{ catalogItemId, distributionId }`.
 *
 * Authentication: `withAnyAuth`.
 * Authorization: `requireOrgAdmin` (Clerk org admin or owner role).
 */
export const POST = withAnyAuth<PromoteResponse, "/agent-components/promote">(
  withOperationReceipts(
    OperationKind.OrganizationWrite,
    async ({ user, clerkOrgId, clerkUserId }, request, _params, receipts) => {
      const denial = await requireOrgAdmin(clerkOrgId, clerkUserId);
      if (denial) {
        return denial;
      }

      const { body, errorResponse: parseErr } = await parseBody(
        request,
        promoteSchema
      );
      if (parseErr) {
        return parseErr;
      }

      try {
        const result = await promoteAgentComponent(
          {
            organizationId: user.organizationId,
            userId: user.id,
            agentComponentId: body.agentComponentId,
            name: body.name,
            description: body.description,
            targetKind: body.targetKind,
            sortOrder: body.sortOrder,
          },
          recordOrganizationWrite(receipts)
        );

        if (!result.ok) {
          if (result.reason === "not_promotable") {
            // Observable-only kinds (built-in Tool/Config) are inventory signals,
            // not distributable components (FEA-3048).
            return badRequestResponse(
              `A "${result.kind}" component is observable-only and cannot be promoted.`
            );
          }
          return notFoundResponse("AgentComponent");
        }

        // ISS-12552: re-promoting a component whose promotion is intact opens
        // no write transaction, so it is recorded as a no-op on its own.
        await recordNoOpUnlessRecorded(receipts);
        return successResponse(withOperationReceipt(result.response, receipts));
      } catch (error) {
        return errorResponse("Failed to promote agent component", error);
      }
    }
  ),
  { requiredScopes: ["write"] }
);
