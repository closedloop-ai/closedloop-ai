"use client";

import { PenseroRouteErrorCode } from "@repo/api/src/types/pensero-integration";
import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { toast } from "@repo/design-system/components/ui/sonner";
import { CheckCircleIcon, GaugeIcon, Loader2Icon } from "lucide-react";
import { useState } from "react";
import {
  usePenseroIntegrationInfo,
  useRemovePenseroCredential,
  useSetPenseroCredential,
} from "../../../../pensero/hooks/use-pensero-integration";
import { ApiError } from "../../../../shared/api/api-error";
import { useFeatureFlagEnabledOptional } from "../../../../shared/feature-flags/use-feature-flag-enabled";
import { formatDateTime } from "../../../../shared/lib/date-utils";
import { PENSERO_TEAM_IDENTIFIERS_FEATURE_FLAG_KEY } from "../../../../shared/lib/feature-flags";
import { IntegrationConnectionCard } from "../../components/integration-connection-card";
import { IntegrationDisconnectDialog } from "../../components/integration-disconnect-dialog";
import { SettingsPanelDataStateView } from "../../components/settings-panel-data-state-view";
import { SettingsWriteOutcomeAlert } from "../../components/settings-write-outcome-alert";
import {
  classifySettingsPanelError,
  classifySettingsPanelRead,
  resolveGatedSettingsPanelState,
  SettingsPanelDataState,
} from "../../lib/settings-panel-data-state";

/**
 * Per-org Pensero credential card (ISS-8007, layer 2).
 *
 * SECURITY: the token field is write-only and is NEVER prefilled. The server
 * does not return the stored token, so there is nothing to prefill with — the
 * card shows presence, a last-four fingerprint, and when it was set. Replacing
 * a credential means typing a new one, which is the point: a masked value a
 * client could read back is a recoverable secret with extra steps.
 *
 * No logging of any kind here. This is a browser-bundled module, and a
 * `console.*` on the failure path is exactly where a submitted credential would
 * end up.
 */

const CARD_TITLE = "Pensero";
const CARD_DESCRIPTION = "Store this organization's Pensero API credential.";
const PENSERO_SUBJECT = "your Pensero credentials";
const PENSERO_FORBIDDEN_MESSAGE =
  "That change needs an organization admin. The Pensero credential is unchanged.";

/**
 * The status words are deliberately about STORAGE, not about being "connected".
 *
 * ISS-8761 gave the credential its first reader — the daily
 * `/cron/backfill-pensero-delivery` sweep — so it is no longer true that
 * nothing uses it. The wording still does not promise "connected", because this
 * card cannot see whether the last sweep actually authenticated: it knows a
 * credential is stored, and that is what it says. Reporting a live connection
 * from the presence of a row would be the card asserting a fact it has no
 * evidence for.
 */
const STORED_TITLE = "Credential stored";
const NOT_STORED_TITLE = "No credential stored";

const TOKEN_FIELD_ID = "pensero-api-token";
const BASE_URL_FIELD_ID = "pensero-base-url";
const TEAM_IDENTIFIERS_FIELD_ID = "pensero-team-identifiers";

/**
 * Parse the comma-separated field into the wire list.
 *
 * Blank entries are dropped rather than sent, so a trailing comma cannot store
 * an empty identifier that would be joined into the provider query as `,,` and
 * narrow the poll to a team that does not exist. The route applies the same
 * rule, because this is one client of that contract and not its owner.
 */
function parseTeamIdentifiers(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * A refusal or an unreachable service gets the shared Settings alert, returned
 * here for the caller to show. Any other failure keeps the server's own
 * message as a toast, which is the actionable sentence for a malformed token
 * or endpoint, and returns `null`.
 */
function reportWriteFailure(
  error: unknown,
  fallback: string
): SettingsPanelDataState | null {
  // A rollout refusal reaches real admins too, so the admin sentence would be
  // false there. The server's own message is the true one.
  const state = isRolloutRefusal(error)
    ? SettingsPanelDataState.Failed
    : classifySettingsPanelError(error);
  if (state === SettingsPanelDataState.Failed) {
    toast.error(toErrorMessage(error, fallback));
    return null;
  }
  return state;
}

/**
 * Fall back to a generic sentence only when the server gave us nothing usable.
 * Where it DID explain the rejection (a malformed token, a non-https base URL),
 * that message is what the admin needs, so it is shown verbatim rather than
 * replaced with a vaguer one.
 */
function isRolloutRefusal(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.code === PenseroRouteErrorCode.RolloutDisabled
  );
}

function toErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message.trim() : "";
  return message.length > 0 ? message : fallback;
}

type PenseroCredentialCardProps = {
  isAdmin: boolean;
  /**
   * The admin question's own read (ISS-10316). Anything but `Ready` replaces
   * the card body, so the form and Disconnect are never drawn while it is
   * unknown whether this actor is an admin. Omitted by the legacy page, which
   * already holds a settled `isAdmin`.
   */
  accessState?: SettingsPanelDataState;
  onAccessRetry?: () => void;
};

export function PenseroCredentialCard({
  isAdmin,
  accessState = SettingsPanelDataState.Ready,
  onAccessRetry,
}: Readonly<PenseroCredentialCardProps>) {
  const infoQuery = usePenseroIntegrationInfo();
  const info = infoQuery.data;
  const setCredential = useSetPenseroCredential();
  const removeCredential = useRemovePenseroCredential();

  const [token, setToken] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  /**
   * `null` means UNTOUCHED, and is not the same as an empty string (whitlockk,
   * #6492). The field previously started blank and never hydrated, so an admin
   * who opened the card to rotate a token and submitted without going near this
   * input sent `[]` and cleared a narrowing they never saw — the same silent
   * widening the server-side omission rule closes from the other side.
   *
   * A draft-or-stored pair rather than an effect that copies `info` into state:
   * an effect has to decide when NOT to overwrite what the admin is typing, and
   * that decision is exactly this `null`.
   */
  const [teamIdentifiersDraft, setTeamIdentifiersDraft] = useState<
    string | null
  >(null);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [writeOutcome, setWriteOutcome] =
    useState<SettingsPanelDataState | null>(null);
  // The OPTIONAL variant: this card is mounted in test and story contexts that
  // do not wrap a `FeatureFlagAdapterProvider`, and a purely-additive gated
  // field must resolve closed there rather than crash the subtree. Real product
  // surfaces mount the provider and resolve the flag normally.
  const isTeamIdentifiersEnabled = useFeatureFlagEnabledOptional(
    PENSERO_TEAM_IDENTIFIERS_FEATURE_FLAG_KEY
  );

  const isConnected = info?.isSet ?? false;
  // `?? []` because the field is optional across the deploy boundary — an older
  // API omits it entirely, which reads as "not narrowed" exactly like an empty
  // list does.
  const storedTeamIdentifiers = (info?.teamIdentifiers ?? []).join(", ");
  const teamIdentifiers = teamIdentifiersDraft ?? storedTeamIdentifiers;

  /**
   * Save and Disconnect write the SAME row in opposite directions, so both are
   * blocked while either is in flight (#6030, tamsinb).
   *
   * Disabling each on only its own `isPending` let the two overlap: with a slow
   * KMS encrypt on the PUT, an admin could open the disconnect dialog and
   * confirm it, the DELETE could win the race, and the delayed upsert would then
   * recreate the credential the admin had just revoked — leaving a live
   * credential behind a screen that said it was gone. Last-write-wins is not a
   * safe ordering when one of the writes is a revocation.
   */
  const isMutating = setCredential.isPending || removeCredential.isPending;

  const handleSave = async () => {
    setWriteOutcome(null);
    try {
      await setCredential.mutateAsync({
        token,
        // `type="url"` inputs are whitespace-sanitized by the platform, so this
        // is only distinguishing empty from set. The route trims and validates
        // whatever actually arrives, for this client and any other.
        baseUrl: baseUrl === "" ? null : baseUrl,
        // OMITTED, not sent as an empty array, while the field is gated off:
        // with the input hidden the admin stated no intent about narrowing, and
        // sending `[]` would silently clear a list they configured earlier and
        // cannot currently see.
        ...(isTeamIdentifiersEnabled
          ? { teamIdentifiers: parseTeamIdentifiers(teamIdentifiers) }
          : {}),
      });
      setToken("");
      setBaseUrl("");
      // Back to UNTOUCHED, not to blank: the refetched `info` is now the truth,
      // and blanking would re-arm the very clear-on-rotate this draft closes.
      setTeamIdentifiersDraft(null);
      toast.success("Pensero credential saved");
    } catch (error) {
      setWriteOutcome(
        reportWriteFailure(error, "Failed to save the Pensero credential.")
      );
    }
  };

  const handleDisconnect = async () => {
    setWriteOutcome(null);
    try {
      await removeCredential.mutateAsync();
      setDisconnectOpen(false);
      toast.success("Pensero disconnected");
    } catch (error) {
      const outcome = reportWriteFailure(
        error,
        "Failed to disconnect Pensero."
      );
      setWriteOutcome(outcome);
      // Closed so the alert is not hidden behind the dialog it came from.
      if (outcome !== null) {
        setDisconnectOpen(false);
      }
    }
  };

  const readState = classifySettingsPanelRead({
    error: infoQuery.error,
    hasData: info !== undefined,
    isEmpty: false,
    isPending: infoQuery.isPending,
  });
  const accessSettled = accessState === SettingsPanelDataState.Ready;
  const dataState = resolveGatedSettingsPanelState(accessState, readState);
  const retryRead = accessSettled ? () => infoQuery.refetch() : onAccessRetry;

  // An unreadable status is its own state, and so is an unknown admin rung.
  // Rendering either as "no credential" would tell an admin whose org HAS one
  // that none is stored, and would hide Disconnect — leaving a live credential
  // they cannot revoke.
  if (dataState !== SettingsPanelDataState.Ready) {
    return <PenseroUnreadCard onRetry={retryRead} state={dataState} />;
  }

  return (
    <>
      <IntegrationConnectionCard
        actions={
          isConnected && isAdmin ? (
            <Button
              disabled={isMutating}
              onClick={() => setDisconnectOpen(true)}
              variant="outline"
            >
              {removeCredential.isPending ? (
                <>
                  <Loader2Icon className="h-4 w-4 animate-spin" />
                  Disconnecting...
                </>
              ) : (
                "Disconnect"
              )}
            </Button>
          ) : undefined
        }
        description={CARD_DESCRIPTION}
        statusDescription={
          isConnected ? (
            <PenseroConnectedStatus
              baseUrl={info?.baseUrl ?? null}
              lastFour={info?.lastFour ?? null}
              setAt={info?.setAt ?? null}
              teamIdentifiers={
                isTeamIdentifiersEnabled ? (info?.teamIdentifiers ?? []) : null
              }
            />
          ) : (
            "Add a Pensero API token for this organization."
          )
        }
        statusIcon={
          isConnected ? (
            <CheckCircleIcon className="h-5 w-5 text-success" />
          ) : undefined
        }
        statusTitle={isConnected ? STORED_TITLE : NOT_STORED_TITLE}
        title={CARD_TITLE}
        titleIcon={<GaugeIcon className="h-5 w-5 text-muted-foreground" />}
      >
        <SettingsWriteOutcomeAlert
          forbiddenMessage={PENSERO_FORBIDDEN_MESSAGE}
          state={writeOutcome}
        />
        {isAdmin ? (
          <PenseroCredentialForm
            baseUrl={baseUrl}
            isBlocked={isMutating}
            isConnected={isConnected}
            isSaving={setCredential.isPending}
            onBaseUrlChange={setBaseUrl}
            onSave={handleSave}
            onTeamIdentifiersChange={setTeamIdentifiersDraft}
            onTokenChange={setToken}
            showTeamIdentifiers={isTeamIdentifiersEnabled}
            teamIdentifiers={teamIdentifiers}
            token={token}
          />
        ) : (
          <p className="text-muted-foreground text-sm">
            Only organization admins can change the Pensero credential.
          </p>
        )}
      </IntegrationConnectionCard>

      <IntegrationDisconnectDialog
        description="Are you sure you want to remove the Pensero credential? It will be deleted and you will need to enter it again."
        isPending={removeCredential.isPending}
        onConfirm={handleDisconnect}
        onOpenChange={setDisconnectOpen}
        open={disconnectOpen}
        title="Disconnect Pensero"
      />
    </>
  );
}

function PenseroUnreadCard({
  state,
  onRetry,
}: Readonly<{ state: SettingsPanelDataState; onRetry?: () => void }>) {
  return (
    <IntegrationConnectionCard
      description={CARD_DESCRIPTION}
      title={CARD_TITLE}
      titleIcon={<GaugeIcon className="h-5 w-5 text-muted-foreground" />}
    >
      <SettingsPanelDataStateView
        onRetry={onRetry}
        state={state}
        subject={PENSERO_SUBJECT}
      />
    </IntegrationConnectionCard>
  );
}

/**
 * What the client is allowed to know about a stored credential: that it exists,
 * a fingerprint to tell it apart from another, where it points, and when it was
 * set. Never the token.
 */
function PenseroConnectedStatus({
  lastFour,
  baseUrl,
  setAt,
  teamIdentifiers,
}: Readonly<{
  lastFour: string | null;
  baseUrl: string | null;
  setAt: string | null;
  /** `null` while the field is gated off — not the same as a configured empty list. */
  teamIdentifiers: readonly string[] | null;
}>) {
  return (
    <>
      {lastFour ? (
        <p>
          Token ending in{" "}
          <span className="font-mono text-xs">****{lastFour}</span>
        </p>
      ) : null}
      <p>{baseUrl ?? "Using the default Pensero API endpoint"}</p>
      {teamIdentifiers ? (
        <p>
          {teamIdentifiers.length > 0
            ? `Teams: ${teamIdentifiers.join(", ")}`
            : "All teams"}
        </p>
      ) : null}
      {setAt ? <p>Set {formatDateTime(setAt)}</p> : null}
    </>
  );
}

function PenseroCredentialForm({
  token,
  baseUrl,
  teamIdentifiers,
  isConnected,
  isBlocked,
  isSaving,
  showTeamIdentifiers,
  onTokenChange,
  onBaseUrlChange,
  onTeamIdentifiersChange,
  onSave,
}: Readonly<{
  token: string;
  baseUrl: string;
  teamIdentifiers: string;
  isConnected: boolean;
  /** Any write is in flight — including the sibling disconnect. */
  isBlocked: boolean;
  /** THIS write is in flight, which is what the button's label reports. */
  isSaving: boolean;
  /** ISS-8761 rollout gate, closed by default. */
  showTeamIdentifiers: boolean;
  onTokenChange: (value: string) => void;
  onBaseUrlChange: (value: string) => void;
  onTeamIdentifiersChange: (value: string) => void;
  onSave: () => void;
}>) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={TOKEN_FIELD_ID}>
          {isConnected ? "Replace API token" : "API token"}
        </Label>
        <Input
          autoComplete="off"
          id={TOKEN_FIELD_ID}
          onChange={(event) => onTokenChange(event.target.value)}
          placeholder="tk_...:sk_..."
          type="password"
          value={token}
        />
        <p className="text-muted-foreground text-xs">
          {isConnected
            ? "Entering a new token replaces the stored one. The current token is never shown."
            : "Stored encrypted and never shown again after you save it."}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor={BASE_URL_FIELD_ID}>API endpoint (optional)</Label>
        <Input
          autoComplete="off"
          id={BASE_URL_FIELD_ID}
          onChange={(event) => onBaseUrlChange(event.target.value)}
          placeholder="https://pensero.ai/api"
          type="url"
          value={baseUrl}
        />
        <p className="text-muted-foreground text-xs">
          Must be an https:// URL. Leave empty to use this deployment's default.
        </p>
      </div>

      {showTeamIdentifiers ? (
        <div className="space-y-2">
          <Label htmlFor={TEAM_IDENTIFIERS_FIELD_ID}>
            Pensero teams (optional)
          </Label>
          <Input
            autoComplete="off"
            id={TEAM_IDENTIFIERS_FIELD_ID}
            onChange={(event) => onTeamIdentifiersChange(event.target.value)}
            placeholder="Engineering, Platform"
            type="text"
            value={teamIdentifiers}
          />
          <p className="text-muted-foreground text-xs">
            Comma-separated Pensero team identifiers. Leave empty to include
            every team.
          </p>
        </div>
      ) : null}

      <Button disabled={token.trim() === "" || isBlocked} onClick={onSave}>
        {isSaving ? (
          <>
            <Loader2Icon className="h-4 w-4 animate-spin" />
            Saving...
          </>
        ) : (
          "Save"
        )}
      </Button>
    </div>
  );
}
