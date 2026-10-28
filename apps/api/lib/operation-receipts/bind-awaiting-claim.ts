import "server-only";

/**
 * ISS-12552: bind a receipt to the claim already waiting on
 * it. Covers a write that committed after its session synced (a delayed
 * commit, or an API commit after the MCP request timed out). Same rules as
 * sync reconciliation: the receipt's owner owns the session, the claim is
 * unbound, and the claims that match by call id, else by fingerprint inside
 * the call window, are settled as sync settles them (receipt-claimants.ts):
 * copies of one session yield to the copy with the lowest compute target id
 * (PRD-800), a fork pair keeps the fork rule, and a tie or a
 * fingerprint two sessions match leaves every claim contesting the receipt. A
 * bind can give the session a new target, so once it commits the sessions'
 * evidence links are synced under the organization's flag answer.
 */
import {
  OperationEvidenceOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import { Prisma, type TransactionClient, withDb } from "@repo/database";
import { resolveReceiptClaimants } from "@repo/lib/attribution/receipt-claimants";
import {
  FINGERPRINT_WINDOW_MS,
  storedOperationKind,
} from "@repo/lib/attribution/receipt-outcome";
import {
  applyClaimantResolution,
  claimWindowEnd,
  type SettledClaimant,
} from "@/app/agent-sessions/service/attribution/receipt-holders";
import { syncSessionEvidenceLinks } from "@/app/agent-sessions/service/attribution/session-evidence-links";
import { isAttributionEvidenceEnabledForOrganization } from "@/lib/attribution-evidence-policy-feature";

/** More fingerprint matches than this is read as ambiguous, never trimmed. */
export const FINGERPRINT_CANDIDATE_LIMIT = 50;

const CANDIDATE_SELECT = {
  id: true,
  agentSessionId: true,
  invokedAt: true,
  session: {
    select: {
      harness: true,
      externalSessionId: true,
      computeTargetId: true,
      sessionStartedAt: true,
    },
  },
} as const;

export async function bindAwaitingClaimForReceipt(
  receiptId: string,
  organizationId: string
): Promise<void> {
  // ISS-12552 (PRD-800 "Rollout"): no late bind while the flag is off for
  // the organization. Read before the bind transaction opens.
  if (!(await isAttributionEvidenceEnabledForOrganization(organizationId))) {
    return;
  }
  const touched = await withDb.tx((tx) =>
    bindInTransaction(tx, receiptId, organizationId)
  );
  await syncSessionEvidenceLinks(organizationId, touched);
}

/**
 * Runs the late bind again for receipts the sessions' still-unbound
 * MCP write claims could bind, after the sync that wrote those claims
 * committed. A receipt that committed while the claim's sync transaction was
 * open saw no committed claim at its own late bind, and a late bind that
 * failed left the claim waiting; this binds both. The caller reads the
 * organization's flag before calling, outside any transaction, and syncs the
 * returned sessions' links. Each receipt binds in its own short transaction.
 */
export async function bindWaitingClaimsOfSessions(
  organizationId: string,
  agentSessionIds: readonly string[]
): Promise<string[]> {
  if (agentSessionIds.length === 0) {
    return [];
  }
  const receiptIds = await withDb((db) =>
    receiptsWaitingClaimsCouldBind(db, organizationId, agentSessionIds)
  );
  const touched = new Set<string>();
  for (const receiptId of receiptIds) {
    for (const sessionId of await withDb.tx((tx) =>
      bindInTransaction(tx, receiptId, organizationId)
    )) {
      touched.add(sessionId);
    }
  }
  return [...touched];
}

/** The sessions whose evidence changed, so their links are synced after commit. */
async function bindInTransaction(
  tx: TransactionClient,
  receiptId: string,
  organizationId: string
): Promise<string[]> {
  const receipt = await tx.artifactOperationReceipt.findFirst({
    where: { id: receiptId, organizationId },
  });
  if (!(receipt && (receipt.clientCallId || receipt.requestFingerprint))) {
    return [];
  }
  const alreadyBound = await tx.agentSessionOperationEvidence.findFirst({
    where: { organizationId, receiptId },
    select: { id: true },
  });
  if (alreadyBound) {
    return [];
  }
  // MCP claims only: a shell claim binds only the receipts it printed, at sync.
  const waiting = {
    organizationId: receipt.organizationId,
    source: OperationSource.Mcp,
    outcome: OperationEvidenceOutcome.AwaitingReceipt,
    operationKind: storedOperationKind(receipt.operationKind),
    receiptId: null,
    session: { artifact: { createdById: receipt.principalUserId } },
  };
  const byCallId = receipt.clientCallId
    ? await tx.agentSessionOperationEvidence.findMany({
        where: { ...waiting, providerCallId: receipt.clientCallId },
        select: CANDIDATE_SELECT,
        take: FINGERPRINT_CANDIDATE_LIMIT + 1,
      })
    : [];
  const candidates =
    byCallId.length > 0 ? byCallId : await fingerprintCandidates(tx, receipt);
  // More matches than the limit are ambiguous, never trimmed.
  if (candidates.length > FINGERPRINT_CANDIDATE_LIMIT) {
    return [];
  }
  const resolution = resolveReceiptClaimants(
    candidates.map(
      (row): SettledClaimant => ({
        evidenceId: row.id,
        agentSessionId: row.agentSessionId,
        session: row.session,
        invokedAt: row.invokedAt,
        sessionStartedAt: row.session.sessionStartedAt,
        byIdentity: byCallId.length > 0,
        heldReceipt: false,
      })
    )
  );
  if (!resolution) {
    return [];
  }
  return await applyClaimantResolution(tx, organizationId, receipt, resolution);
}

/**
 * Claims waiting on this fingerprint whose call window holds the receipt, newest
 * first. The window is applied before the limit, so stale claims with the same
 * fingerprint cannot fill the page and make the one real match read as
 * ambiguous. A window ends at the claim's anchored result time, else at its
 * call time; an anchored result time that is not a timestamp matches nothing.
 */
async function fingerprintCandidates(
  tx: TransactionClient,
  receipt: {
    organizationId: string;
    principalUserId: string;
    operationKind: string;
    requestFingerprint: string | null;
    requestedAt: Date;
  }
): Promise<FingerprintCandidate[]> {
  if (!receipt.requestFingerprint) {
    return [];
  }
  const windowEnd = Prisma.sql`CASE
      WHEN jsonb_typeof(e.anchors -> 'resultAt') = 'string' THEN
        CASE WHEN pg_input_is_valid(e.anchors ->> 'resultAt', 'timestamptz')
          THEN (e.anchors ->> 'resultAt')::timestamptz AT TIME ZONE 'UTC'
        END
      ELSE e.invoked_at
    END`;
  const rows = await tx.$queryRaw<FingerprintCandidateRow[]>(Prisma.sql`
    SELECT e.id,
           e.agent_session_id AS "agentSessionId",
           e.invoked_at AS "invokedAt",
           d.harness,
           d.external_session_id AS "externalSessionId",
           d.compute_target_id AS "computeTargetId",
           d.session_started_at AS "sessionStartedAt"
    FROM agent_session_operation_evidence e
    JOIN session_detail d ON d.artifact_id = e.agent_session_id
    JOIN artifacts a ON a.id = e.agent_session_id
    WHERE e.organization_id = ${receipt.organizationId}::uuid
      AND e.source = ${OperationSource.Mcp}
      AND e.outcome = ${OperationEvidenceOutcome.AwaitingReceipt}
      AND e.operation_kind = ${storedOperationKind(receipt.operationKind)}
      AND e.receipt_id IS NULL
      AND a.created_by_id = ${receipt.principalUserId}::uuid
      AND e.request_fingerprint = ${receipt.requestFingerprint}
      AND e.invoked_at <= ${receipt.requestedAt}::timestamp
      AND ${windowEnd} + ${FINGERPRINT_WINDOW_MS}::int * interval '1 millisecond'
        >= ${receipt.requestedAt}::timestamp
    ORDER BY e.invoked_at DESC, e.id DESC
    LIMIT ${FINGERPRINT_CANDIDATE_LIMIT + 1}::int
  `);
  return rows.map(
    ({
      harness,
      externalSessionId,
      computeTargetId,
      sessionStartedAt,
      ...row
    }) => ({
      ...row,
      session: {
        harness,
        externalSessionId,
        computeTargetId,
        sessionStartedAt,
      },
    })
  );
}

type FingerprintCandidateRow = {
  id: string;
  agentSessionId: string;
  invokedAt: Date | null;
  harness: string;
  externalSessionId: string;
  computeTargetId: string;
  sessionStartedAt: Date;
};

type FingerprintCandidate = {
  id: string;
  agentSessionId: string;
  invokedAt: Date | null;
  session: {
    harness: string;
    externalSessionId: string;
    computeTargetId: string;
    sessionStartedAt: Date;
  };
};

/**
 * The owner's unbound receipts that one of the sessions' waiting MCP write
 * claims names by call id, or matches by fingerprint inside the claim's
 * window. The late bind itself applies every other rule.
 */
async function receiptsWaitingClaimsCouldBind(
  db: Pick<
    TransactionClient,
    "agentSessionOperationEvidence" | "artifactOperationReceipt"
  >,
  organizationId: string,
  agentSessionIds: readonly string[]
): Promise<string[]> {
  const waiting = await db.agentSessionOperationEvidence.findMany({
    where: {
      organizationId,
      agentSessionId: { in: [...agentSessionIds] },
      source: OperationSource.Mcp,
      outcome: OperationEvidenceOutcome.AwaitingReceipt,
      receiptId: null,
    },
    select: {
      providerCallId: true,
      requestFingerprint: true,
      invokedAt: true,
      anchors: true,
      session: { select: { artifact: { select: { createdById: true } } } },
    },
  });
  const arms = waiting.flatMap((claim) => {
    const owner = claim.session.artifact.createdById;
    if (!owner) {
      return [];
    }
    const byCallId = claim.providerCallId
      ? [{ principalUserId: owner, clientCallId: claim.providerCallId }]
      : [];
    const end = claimWindowEnd(claim);
    const byFingerprint =
      claim.requestFingerprint && claim.invokedAt && !Number.isNaN(end)
        ? [
            {
              principalUserId: owner,
              requestFingerprint: claim.requestFingerprint,
              requestedAt: {
                gte: claim.invokedAt,
                lte: new Date(end + FINGERPRINT_WINDOW_MS),
              },
            },
          ]
        : [];
    return [...byCallId, ...byFingerprint];
  });
  if (arms.length === 0) {
    return [];
  }
  const receipts = await db.artifactOperationReceipt.findMany({
    where: { organizationId, OR: arms },
    orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  return receipts.map((receipt) => receipt.id);
}
