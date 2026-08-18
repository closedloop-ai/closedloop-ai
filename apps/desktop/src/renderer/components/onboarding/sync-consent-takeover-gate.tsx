import type { SyncConsentLevel } from "@repo/app/onboarding/components/sync-consent";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { DataSyncLevelValue } from "@repo/app/shared/lib/data-sync-copy";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useCallback, useState } from "react";
import type { DataSyncLevel } from "../../../shared/contracts";
import { DesktopAuthStatus } from "../../../shared/contracts";
import { DESKTOP_GUEST_ONBOARDING_FEATURE_FLAG_KEY } from "../../../shared/feature-flags";
import {
  hasRecordedSyncConsent,
  type SyncConsentRecord,
} from "../../../shared/sync-consent";
import { useDesktopFeatureFlagsResolved } from "../../feature-flags/desktop-feature-flag-provider";
import { hrefForNavId, NavId } from "../../navigation/route-table";
import { useDesktopAuth } from "../../shared-agent-sessions/desktop-auth-provider";
import { useDesktopIdentity } from "../../shared-agent-sessions/use-desktop-identity";
import {
  isArrivalForIdentity,
  type SyncConsentArrival,
  SyncConsentArrivalProvider,
} from "./sync-consent-arrival";
import { SyncConsentTakeover } from "./sync-consent-takeover";
import { useSyncConsentRecord } from "./use-sync-consent-record";

/**
 * The org name to show, but ONLY when it demonstrably belongs to the org being
 * consented to.
 *
 * `useDesktopIdentity` is a process-wide stale-while-revalidate cache keyed by
 * user id alone, and it seeds synchronously from that cache before revalidating.
 * This gate stays mounted for the app's lifetime and deliberately re-asks when
 * the org changes — so a same-user org change can hand it the PREVIOUS org's
 * name for the window before the refetch lands. On an ordinary screen that is a
 * cosmetic blip; on a blocking consent dialog it is the UI naming the wrong
 * organization in the sentence asking you to send it your data.
 *
 * Falling back to the unnamed copy ("You're signed in!") is the honest answer
 * while the two disagree. Fixed here rather than by re-keying the shared cache:
 * that hook backs the sidebar, Settings and session detail, and none of them are
 * asking a question this consequential.
 */
function organizationNameForOrg(
  identity: { organizationId?: string; organizationName: string | null } | null,
  organizationId: string | null
): string | null {
  if (!identity || identity.organizationId !== organizationId) {
    return null;
  }
  return identity.organizationName;
}

/** What `desktop:record-sync-consent` resolves with — the answer main actually committed. */
type RecordSyncConsentResult = {
  level: DataSyncLevel;
  organizationId: string | null;
};

/**
 * The level main committed, when it is one this surface can represent.
 *
 * `DataSyncLevel` is the wider set (it carries `redacted`, which the takeover
 * does not offer), so the returned value is adopted only when it lands inside
 * the three. Anything else keeps what the user actually chose rather than being
 * cast into a shape the union forbids — an unreachable branch today, and the
 * honest fallback if the normalization on the other side ever widens.
 */
function committedSyncConsentLevel(
  returned: DataSyncLevel | undefined,
  requested: SyncConsentLevel
): SyncConsentLevel {
  if (
    returned === DataSyncLevelValue.Off ||
    returned === DataSyncLevelValue.Metadata ||
    returned === DataSyncLevelValue.Full
  ) {
    return returned;
  }
  return requested;
}

/** Shown in the dialog when the write failed; Save stays live so it can be retried. */
export const SAVE_FAILED_MESSAGE =
  "We couldn't save your choice. Please try again.";

/** Who a consent answer belongs to — an answer is only ever valid for one. */
export type ConsentIdentity = {
  userId: string | null;
  organizationId: string | null;
};

function isSameConsentIdentity(
  a: ConsentIdentity,
  b: ConsentIdentity
): boolean {
  return a.userId === b.userId && a.organizationId === b.organizationId;
}

/**
 * Whether the post-auth consent takeover should be on screen right now.
 *
 * Pure so the decision is testable without a window, a bridge or a flag
 * snapshot — the component below owns only the reads that feed it. Every arm is
 * a withhold: this mounts a modal the user cannot dismiss, so anything short of
 * a positive, settled "they are signed in and have not answered" must leave the
 * app alone.
 */
export function shouldShowSyncConsentTakeover({
  flagEnabled,
  flagsResolved,
  authStatus,
  userId,
  organizationId,
  record,
  recordResolved,
  answeredFor,
}: {
  flagEnabled: boolean;
  /** ISS-5037: an unresolved snapshot reads every flag as its default, so it counts as off. */
  flagsResolved: boolean;
  authStatus: DesktopAuthStatus;
  userId: string | null;
  organizationId: string | null;
  /** null = unreadable (no bridge / failed read), which withholds rather than prompts. */
  record: SyncConsentRecord | null;
  recordResolved: boolean;
  /**
   * The identity that answered during THIS session, or null. Keyed to an
   * identity rather than a bare boolean because the gate stays mounted across a
   * sign-out: desktop sign-out and sign-in are both reachable in-session from
   * Settings → Account, so a plain "already answered" flag would carry user A's
   * answer into user B's session and skip the question for B's org entirely.
   */
  answeredFor: ConsentIdentity | null;
}): boolean {
  if (!(flagsResolved && flagEnabled)) {
    return false;
  }
  // Only a SETTLED authenticated device. The states in between (a sign-in in
  // flight, a lapsed session awaiting refresh) are not returning users yet, and
  // walling one of them off behind a consent modal would interrupt a flow that
  // has not finished deciding who the user is.
  if (authStatus !== DesktopAuthStatus.Authenticated) {
    return false;
  }
  if (!recordResolved) {
    return false;
  }
  // Suppress a re-show between Save and the record re-read, but only for the
  // identity that actually answered.
  if (
    answeredFor &&
    isSameConsentIdentity(answeredFor, { userId, organizationId })
  ) {
    return false;
  }
  // An unreadable record is NOT "never consented". Treating it as such would
  // block the app behind a modal whose Save writes through the same broken
  // bridge, leaving no way forward at all.
  if (record === null) {
    return false;
  }
  return !hasRecordedSyncConsent(record, organizationId);
}

/**
 * ISS-5489 (PLN-1694 M1) — the trigger the post-auth flow was missing.
 *
 * Before this, a user who signed in from the landing came back to nothing: the
 * `OnboardingOverlay` that hosts the pre-auth flow unmounts the moment auth
 * settles, and the consent step lives INSIDE that flow's own step machine, so it
 * was only ever reachable by users who signed in from within it. Returning from
 * the browser therefore skipped consent entirely and left the device in the
 * PRD-542 null-tier state.
 *
 * Mounted at the app root rather than inside `DashboardPage`, where PLN-1694
 * originally placed it, because `DEFAULT_NAV_ID` is Sessions — a returning user
 * lands on Sessions, never on Dashboard, so a Dashboard-scoped overlay would
 * have shipped a trigger that still never fired.
 *
 * Renders its children either way: the takeover is a modal layered over the app
 * (Radix owns the focus trap and makes the rest inert), not a replacement for
 * it, so the user can see the app they just signed into behind the one question
 * standing between them and it.
 */
export function SyncConsentTakeoverGate({
  children,
}: {
  children: React.ReactNode;
}) {
  const flagEnabled = useFeatureFlagEnabled(
    DESKTOP_GUEST_ONBOARDING_FEATURE_FLAG_KEY
  );
  const flagsResolved = useDesktopFeatureFlagsResolved();
  // Split from the armed half for a STRUCTURAL reason, not a stylistic one — the
  // same split `GuestLandingGate` makes, for the same reason. Reading auth
  // requires a `DesktopAuthProvider`, which `main.tsx` mounts in the real app but
  // the app-shell suites deliberately do not. Answering "is this launch even a
  // candidate" first lets the flag-off default — every existing user, and every
  // one of those tests — return the shell without ever mounting the hook that
  // would throw.
  if (!(flagsResolved && flagEnabled)) {
    return children;
  }
  return (
    <ArmedSyncConsentTakeoverGate
      flagEnabled={flagEnabled}
      flagsResolved={flagsResolved}
    >
      {children}
    </ArmedSyncConsentTakeoverGate>
  );
}

/**
 * The half that reads auth, identity and the persisted consent record — mounted
 * only once {@link SyncConsentTakeoverGate} has established the flag is on.
 *
 * The flag facts are threaded down and re-checked by the predicate even though
 * they are necessarily true here. That redundancy is deliberate: it keeps
 * {@link shouldShowSyncConsentTakeover} the COMPLETE decision table (testable in
 * isolation, flag-off case included) rather than a partial one whose missing arm
 * lives in a structural short-circuit a reader has to know about, and it means
 * removing that short-circuit degrades a mount site to a thrown provider error
 * rather than silently to an ungated takeover.
 */
function ArmedSyncConsentTakeoverGate({
  children,
  flagEnabled,
  flagsResolved,
}: {
  children: React.ReactNode;
  flagEnabled: boolean;
  flagsResolved: boolean;
}) {
  const { state } = useDesktopAuth();
  const { record, isResolved, refresh } = useSyncConsentRecord(state.userId);
  const { identity } = useDesktopIdentity(state.status, state.userId);
  const { navigate } = useNavigation();
  const [answeredFor, setAnsweredFor] = useState<ConsentIdentity | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /**
   * PLN-1694 M2: the answer this run committed, published to the Sessions
   * landing so it can acknowledge the sync it just authorized. Set only after a
   * write that SUCCEEDED — a banner reporting an upload that was never enabled
   * is the same lie the failed-write branch above exists to avoid.
   */
  const [arrival, setArrival] = useState<SyncConsentArrival | null>(null);
  const organizationName = organizationNameForOrg(
    identity,
    state.organizationId
  );

  const save = useCallback(
    async (level: SyncConsentLevel) => {
      setSaving(true);
      setSaveError(null);
      let committed: RecordSyncConsentResult | undefined;
      try {
        committed = await window.desktopApi?.recordSyncConsent({
          level: level satisfies DataSyncLevel,
          organizationId: state.organizationId,
        });
      } catch {
        // Reported in the dialog, NOT logged — client debug logging is banned
        // repo-wide, and letting the rejection escape would surface as an
        // unhandled renderer rejection instead.
        //
        // The dialog stays open. Dismissing on a failed write told the user their
        // answer was recorded when nothing was written, and then suppressed the
        // question for the rest of the run — the app proceeding with sync silently
        // off, on a screen that said it had been turned on. This cannot trap
        // anyone: an unreachable bridge resolves the record as unreadable, which
        // withholds the takeover entirely, so a dialog that is ON SCREEN got a
        // readable record and its write failing is a transient to retry.
        setSaving(false);
        setSaveError(SAVE_FAILED_MESSAGE);
        return;
      }
      setSaving(false);
      // What main COMMITTED, not what this renderer asked for. Main reads the org
      // from the authenticated session and deliberately ignores the one in the
      // payload (see `applySyncConsent`) — so an identity change while this write
      // was in flight commits consent for B, and echoing back the pre-await
      // snapshot would record and publish it as A's. The arrival is then
      // published only to whoever is signed in NOW, so a consent that landed for
      // an org the user has already left simply never reaches the landing.
      const answeredOrganizationId =
        committed?.organizationId ?? state.organizationId;
      setAnsweredFor({
        organizationId: answeredOrganizationId,
        userId: state.userId,
      });
      setArrival({
        level: committedSyncConsentLevel(committed?.level, level),
        organizationId: answeredOrganizationId,
        userId: state.userId,
        workspaceName: organizationName,
      });
      // Disk moved; the mount-time record did not. See `refresh`.
      refresh();
      navigate(hrefForNavId(NavId.Sessions));
    },
    [navigate, organizationName, refresh, state.organizationId, state.userId]
  );

  // An arrival belongs to the identity that produced it and to no other. Desktop
  // sign-out and sign-in are both reachable in-session from Settings → Account,
  // and this gate stays mounted across both — so an arrival that outlives its
  // author greets user B with user A's organization name and chosen level.
  //
  // DERIVED, not reset in an effect: there is no window in which the wrong value
  // is published and no ordering to get right, and the check lives here rather
  // than at the consumer so the Sessions banner needs no auth read of its own
  // (mounting one in that subtree is what broke the provider-less app-shell
  // suites in M1).
  const publishedArrival = isArrivalForIdentity(arrival, {
    organizationId: state.organizationId,
    userId: state.userId,
  })
    ? arrival
    : null;

  const show = shouldShowSyncConsentTakeover({
    answeredFor,
    authStatus: state.status,
    flagEnabled,
    flagsResolved,
    organizationId: state.organizationId,
    record,
    recordResolved: isResolved,
    userId: state.userId,
  });

  return (
    <SyncConsentArrivalProvider arrival={publishedArrival}>
      {children}
      {show ? (
        <SyncConsentTakeover
          error={saveError}
          onSave={save}
          organizationName={organizationName}
          saving={saving}
        />
      ) : null}
    </SyncConsentArrivalProvider>
  );
}
