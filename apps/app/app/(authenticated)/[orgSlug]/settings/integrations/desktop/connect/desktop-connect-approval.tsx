"use client";

import { DesktopDeviceSessionStatus } from "@repo/api/src/types/onboarding";
import { DesktopConnectPageShell } from "@repo/app/onboarding/components/desktop-connect-page-shell";
import {
  type DesktopDeviceSessionDetails,
  useDesktopDeviceSession,
  useDesktopDeviceSessionAction,
} from "@repo/app/onboarding/hooks/use-desktop-onboarding";
import {
  actionErrorRendersState,
  type DesktopConnectActionOutcome,
  DesktopConnectStateKind,
  deriveDesktopConnectState,
  getDesktopConnectStateCopy,
} from "@repo/app/onboarding/lib/desktop-connect-state";
import { buildDesktopReturnUrl } from "@repo/app/onboarding/lib/desktop-return";
import { ApiError } from "@repo/app/shared/api/api-error";
import { formatDateTimeOrFallback } from "@repo/app/shared/lib/date-utils";
import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { toast } from "@repo/design-system/components/ui/sonner";
import { Loader2 } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

export function DesktopConnectApproval({
  initialCode,
  requestedOrgSlug,
}: {
  initialCode: string;
  requestedOrgSlug: string;
}) {
  const [code, setCode] = useState(initialCode.toUpperCase());
  const [submitting, setSubmitting] = useState<"approve" | "deny" | null>(null);
  const [actionOutcome, setActionOutcome] =
    useState<DesktopConnectActionOutcome>(null);

  const normalizedCode = useMemo(() => code.trim().toUpperCase(), [code]);
  const {
    data: detail,
    isLoading,
    isError,
    error,
  } = useDesktopDeviceSession(normalizedCode);
  const updateSession = useDesktopDeviceSessionAction();

  const state = deriveDesktopConnectState({
    hasCode: normalizedCode.length > 0,
    isLoading,
    detail,
    detailError: isError
      ? { status: error instanceof ApiError ? error.status : undefined }
      : null,
    actionOutcome,
  });
  const copy = getDesktopConnectStateCopy(state.kind);

  const onCodeChange = (next: string) => {
    setCode(next.toUpperCase());
    // A new code invalidates any terminal outcome from the previous one.
    setActionOutcome(null);
  };

  const submit = (action: "approve" | "deny") => {
    if (!normalizedCode) {
      return;
    }
    setSubmitting(action);
    // This mutation opts out of the shared global error toast
    // (`meta.suppressDefaultErrorToast` in `useDesktopDeviceSessionAction`), so
    // the handlers below own all approve/deny feedback.
    updateSession.mutate(
      { userCode: normalizedCode, action },
      {
        onError: (mutationError) => {
          setSubmitting(null);
          if (
            mutationError instanceof ApiError &&
            actionErrorRendersState(mutationError.status)
          ) {
            // 403/404 map to a dedicated failure state (forbidden / expired /
            // already used) rendered below.
            setActionOutcome({
              kind: "error",
              status: mutationError.status,
              code: mutationError.code,
            });
            return;
          }
          // Transient/unexpected errors (e.g. 401, 5xx, network) leave the
          // request approvable; the shared default-error toast is suppressed
          // for this mutation, so surface explicit feedback here.
          toast.error("Couldn't update the Desktop connection request.", {
            description: "Please try again.",
          });
        },
        onSuccess: () => {
          setSubmitting(null);
          setActionOutcome({
            kind: action === "approve" ? "approved" : "denied",
          });
        },
      }
    );
  };

  // Hide the code entry only once the user has settled this request via an
  // approve/deny action — NOT merely because the queried session is already
  // denied/approved/expired, so a user who arrives with a stale or wrong code
  // can still enter a different one.
  const settledByAction =
    actionOutcome?.kind === "approved" || actionOutcome?.kind === "denied";

  return (
    <DesktopConnectPageShell title={copy.title}>
      <p className="text-muted-foreground text-sm">{copy.description}</p>

      {!settledByAction && (
        <Input
          aria-label="Verification code"
          autoCapitalize="characters"
          // Lock the code while a decision is in flight so a resolving
          // approve/deny can't apply its outcome to a different code.
          disabled={submitting !== null}
          onChange={(event) => onCodeChange(event.target.value)}
          placeholder="Code"
          value={code}
        />
      )}

      <DesktopConnectStateBody
        detail={detail}
        normalizedCode={normalizedCode}
        onApprove={() => submit("approve")}
        onDeny={() => submit("deny")}
        requestedOrgSlug={requestedOrgSlug}
        stateKind={state.kind}
        submitting={submitting}
      />
    </DesktopConnectPageShell>
  );
}

function DesktopConnectStateBody({
  detail,
  normalizedCode,
  requestedOrgSlug,
  stateKind,
  submitting,
  onApprove,
  onDeny,
}: {
  detail: DesktopDeviceSessionDetails | undefined;
  normalizedCode: string;
  requestedOrgSlug: string;
  stateKind: DesktopConnectStateKind;
  submitting: "approve" | "deny" | null;
  onApprove: () => void;
  onDeny: () => void;
}): ReactNode {
  if (stateKind === DesktopConnectStateKind.ApprovedComplete) {
    return <DesktopConnectCompletion userCode={normalizedCode} />;
  }

  if (stateKind === DesktopConnectStateKind.Pending && detail) {
    return (
      <DesktopConnectPending
        detail={detail}
        onApprove={onApprove}
        onDeny={onDeny}
        requestedOrgSlug={requestedOrgSlug}
        submitting={submitting}
      />
    );
  }

  return null;
}

function DesktopConnectPending({
  detail,
  requestedOrgSlug,
  submitting,
  onApprove,
  onDeny,
}: {
  detail: DesktopDeviceSessionDetails;
  requestedOrgSlug: string;
  submitting: "approve" | "deny" | null;
  onApprove: () => void;
  onDeny: () => void;
}): ReactNode {
  return (
    <>
      <dl className="grid grid-cols-[140px_1fr] gap-2 rounded-lg border p-4 text-sm">
        <DetailRow label="Application" value="Closedloop Desktop" />
        <DetailRow label="Device" value={detail.machineName} />
        <DetailRow label="Platform" value={detail.platform} />
        <DetailRow
          label="Requested"
          value={formatDateTimeOrFallback(detail.createdAt)}
        />
        <DetailRow label="Approving into" value={requestedOrgSlug} />
        <DetailRow breakAll label="Origin" value={detail.webAppOrigin} />
      </dl>

      <div className="flex justify-end gap-2">
        <Button
          disabled={submitting !== null}
          onClick={onDeny}
          variant="outline"
        >
          {submitting === "deny" && <Loader2 className="size-4 animate-spin" />}
          Deny
        </Button>
        <Button disabled={submitting !== null} onClick={onApprove}>
          {submitting === "approve" && (
            <Loader2 className="size-4 animate-spin" />
          )}
          Approve
        </Button>
      </div>
    </>
  );
}

function DesktopConnectCompletion({
  userCode,
}: {
  userCode: string;
}): ReactNode {
  // Best-effort deep link back to the desktop app. It carries only the
  // non-secret completion signal; the desktop completes credential exchange
  // out-of-band and continues polling regardless, so this is purely a
  // convenience and the visible instruction below is the reliable path.
  const returnUrl = buildDesktopReturnUrl({
    userCode,
    status: DesktopDeviceSessionStatus.Approved,
  });

  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border p-4 text-sm">
      <p className="text-muted-foreground">
        It's safe to close this tab. If the desktop app doesn't return
        automatically, use the button below.
      </p>
      <Button asChild variant="outline">
        <a href={returnUrl}>Return to desktop</a>
      </Button>
    </div>
  );
}

function DetailRow({
  label,
  value,
  breakAll,
}: {
  label: string;
  value: string;
  breakAll?: boolean;
}): ReactNode {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={breakAll ? "break-all" : undefined}>{value}</dd>
    </>
  );
}
