import { SESSION_TRANSCRIPT_NEVER_EXPECTED_FLAG_KEY } from "@repo/api/src/types/session-transcript-never-expected-flag";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useSyncConsentRecord } from "../components/onboarding/use-sync-consent-record";
import { useDesktopAuth } from "../shared-agent-sessions/desktop-auth-provider";
import { resolveTranscriptNeverExpected } from "../shared-agent-sessions/transcript-never-expected";
import { useTranscriptSyncStatus } from "./use-transcript-sync-status";

/**
 * ISS-7516 — the desktop's answer to "is this session's missing transcript
 * never coming, because of THIS machine's data-sync level?"
 *
 * Thin by design: {@link resolveTranscriptNeverExpected} owns the decision and
 * is graded on its own; this hook only gathers the three live inputs and hands
 * them over.
 *
 * The flag does double duty and that is deliberate. It gates the ANSWER, which
 * the panel gates again on the shared surface — belt and braces across two
 * codebases — and it gates the archive-lane STATUS POLL that supplies this
 * machine's identity. With the flag off (the shipped default) this hook makes
 * no IPC at all, so a closed-by-default disclosure costs a session-detail mount
 * exactly nothing. `useTranscriptSyncStatus` already owns the poll cadence,
 * the failure ladder, and teardown.
 *
 * Returns `undefined` — not `false` — when the flag is off, matching
 * `SessionTranscriptPanel`'s prop contract: "we did not ask" is not the same
 * claim as "we asked and the answer is no", and the panel's doc explains why
 * that distinction is worth carrying even while both render identically.
 */
export function useTranscriptNeverExpected(
  sessionComputeTargetId: string | null
): boolean | undefined {
  const enabled = useFeatureFlagEnabledOptional(
    SESSION_TRANSCRIPT_NEVER_EXPECTED_FLAG_KEY
  );
  const { state } = useDesktopAuth();
  const consent = useSyncConsentRecord(state.userId);
  const statusRead = useTranscriptSyncStatus(enabled);
  if (!enabled) {
    return undefined;
  }
  return resolveTranscriptNeverExpected({
    consentResolved: consent.isResolved,
    consentRecord: consent.record,
    organizationId: state.organizationId,
    deviceComputeTargetId:
      statusRead.state === "ready" ? statusRead.snapshot.computeTargetId : null,
    sessionComputeTargetId,
  });
}
