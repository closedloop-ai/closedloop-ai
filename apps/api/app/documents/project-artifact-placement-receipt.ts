import type { ProjectArtifactPlacementResponse } from "@repo/api/src/types/project-artifact-placement";
import { projectArtifactPlacementResponseValidator } from "@repo/api/src/types/project-artifact-placement";
import type { TransactionClient } from "@repo/database";
import { z } from "zod";
import {
  type PlacementReceiptSnapshot,
  parseReceiptSnapshot,
} from "@/app/documents/project-artifact-placement-service-support";

const placementActivityReceiptSchema = z.object({
  version: z.literal(1),
  routeProjectId: z.uuid(),
  idempotencyKey: z.string(),
  requestHash: z.string(),
  affectedProjectIds: z.array(z.uuid()),
  sourceArtifactIds: z.array(z.uuid()),
  beforeState: z.unknown(),
  afterState: z.unknown(),
  response: z.unknown(),
});

const placementActivityAfterSchema = z.object({
  field: z.literal("placement"),
  receipt: placementActivityReceiptSchema.optional(),
});

export type PlacementActivityReceipt = {
  version: 1;
  routeProjectId: string;
  idempotencyKey: string;
  requestHash: string;
  affectedProjectIds: string[];
  sourceArtifactIds: string[];
  beforeState: PlacementReceiptSnapshot;
  afterState: PlacementReceiptSnapshot;
  response: ProjectArtifactPlacementResponse;
};

/** Serialize one tenant-scoped idempotency key inside the placement transaction. */
export async function lockPlacementReceipt(
  tx: TransactionClient,
  organizationId: string,
  idempotencyKey: string
): Promise<void> {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`project-artifact-placement:${organizationId}:${idempotencyKey}`}, 0::bigint)
    )
  `;
}

/** Read the durable placement summary stored on the first activity receipt. */
export async function readPlacementReceipt(
  tx: TransactionClient,
  organizationId: string,
  selector: { transactionId: string } | { idempotencyKey: string }
): Promise<PlacementActivityReceipt | null> {
  const event = await tx.artifactActivityEvent.findFirst({
    where: {
      organizationId,
      ...("transactionId" in selector
        ? { transactionId: selector.transactionId }
        : {
            after: {
              path: ["receipt", "idempotencyKey"],
              equals: selector.idempotencyKey,
            },
          }),
    },
    orderBy: { id: "asc" },
    select: { after: true },
  });
  const parsedAfter = placementActivityAfterSchema.safeParse(event?.after);
  if (!(parsedAfter.success && parsedAfter.data.receipt)) {
    return null;
  }
  const receipt = parsedAfter.data.receipt;
  const response = projectArtifactPlacementResponseValidator.safeParse(
    receipt.response
  );
  const beforeState = parseReceiptSnapshot(
    receipt.beforeState,
    receipt.sourceArtifactIds
  );
  const afterState = parseReceiptSnapshot(
    receipt.afterState,
    receipt.sourceArtifactIds
  );
  if (!(response.success && beforeState && afterState)) {
    return null;
  }
  return {
    ...receipt,
    beforeState,
    afterState,
    response: response.data,
  };
}
