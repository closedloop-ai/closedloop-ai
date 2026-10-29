import type { CustomFieldQueryRejection } from "@repo/api/src/types/custom-field-list-query";
import type {
  DocumentCostsRequest,
  DocumentCostsResponse,
} from "@repo/api/src/types/document-costs";
import {
  type Result,
  Result as ResultHelpers,
} from "@repo/api/src/types/result";
import { Prisma, withDb } from "@repo/database";
import {
  documentCostService,
  readDocumentCostPopulation,
} from "./document-cost-service";
import { buildDocumentListWhere } from "./document-list-query";
import {
  DOCUMENT_COST_DEFAULT_TYPES,
  resolveDocumentMetricScope,
} from "./document-metric-scope";
import { DOCUMENT_SUMMARY_SNAPSHOT_TX_TIMEOUT_MS } from "./document-summary-service";

/**
 * ISS-12600: `POST /documents/costs` for a caller. A scoped request resolves the
 * caller's favorites and its custom-field facets first — the same resolution
 * the summary card uses — so Est. Total and Median read the population the list
 * and the other cards describe. A facet the list read would refuse is refused.
 *
 * The facets and the population they select are read in one `RepeatableRead`
 * snapshot, as the list and summary reads do: resolved separately, a document
 * edited between two facet reads could match an intersection it never matched.
 * Costs are then read for that fixed population outside the snapshot.
 */
export const documentCostScopeService = {
  async read(
    organizationId: string,
    userId: string,
    request: DocumentCostsRequest
  ): Promise<Result<DocumentCostsResponse, CustomFieldQueryRejection>> {
    const { scope, ...unscoped } = request;
    if (!scope) {
      return ResultHelpers.ok(
        await documentCostService.read(organizationId, unscoped)
      );
    }
    const now = new Date();
    const population = await withDb.tx(
      async (): Promise<Result<string[], CustomFieldQueryRejection>> => {
        const resolved = await resolveDocumentMetricScope(
          {
            ...scope,
            types: scope.types ?? [...DOCUMENT_COST_DEFAULT_TYPES],
            organizationId,
          },
          userId,
          now
        );
        if (!resolved.ok) {
          return resolved;
        }
        return ResultHelpers.ok(
          await readDocumentCostPopulation(
            buildDocumentListWhere({ ...resolved.value, organizationId }, now)
          )
        );
      },
      COST_SCOPE_SNAPSHOT_TX_OPTIONS
    );
    if (!population.ok) {
      return population;
    }
    return ResultHelpers.ok(
      await documentCostService.readPopulation(
        organizationId,
        request,
        population.value,
        now
      )
    );
  },
};

const COST_SCOPE_SNAPSHOT_TX_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  timeout: DOCUMENT_SUMMARY_SNAPSHOT_TX_TIMEOUT_MS,
};
