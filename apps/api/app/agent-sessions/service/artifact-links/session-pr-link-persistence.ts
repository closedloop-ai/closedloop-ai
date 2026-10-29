import type { SyncedAgentSession } from "@repo/api/src/types/agent-session";
import type { AgentSessionUpsertTx } from "../records";
import { persistSessionPrArtifactLinks } from "./pr-links";
import { withProseDerivedPrRefs } from "./prose-pr-refs";
import {
  resolveSessionPrDetailMap,
  type SessionPullRequestDetailMap,
} from "./pull-request-details";
import {
  isPrRefContinuationPart,
  SessionPrLinkWriteMode,
} from "./session-pr-link-merge";

/**
 * Resolve exact PR detail rows and replace this session's PR identity links.
 */
export async function persistSessionPullRequestArtifactLinks(
  tx: AgentSessionUpsertTx,
  input: {
    organizationId: string;
    sessionArtifactId: string;
    session: SyncedAgentSession;
    pullRequestDetails: SessionPullRequestDetailMap;
    providerLocksHeld?: boolean;
  }
): Promise<void> {
  const sessionPrRefs = withProseDerivedPrRefs(input.session);
  const prLinkDetails = await resolveSessionPrDetailMap(
    tx,
    input.organizationId,
    sessionPrRefs,
    input.pullRequestDetails
  );
  await persistSessionPrArtifactLinks(
    tx,
    input.organizationId,
    input.sessionArtifactId,
    sessionPrRefs,
    prLinkDetails,
    resolveSessionPrLinkWriteMode(input.session),
    input.providerLocksHeld
  );
}

/**
 * ISS-9859: Merge for a continuation part of a paginated PR sequence, Replace
 * for everything else. Which payloads count is {@link isPrRefContinuationPart},
 * the predicate the `pullRequests` blob lane shares.
 */
function resolveSessionPrLinkWriteMode(
  session: SyncedAgentSession
): SessionPrLinkWriteMode {
  return isPrRefContinuationPart(session)
    ? SessionPrLinkWriteMode.Merge
    : SessionPrLinkWriteMode.Replace;
}
