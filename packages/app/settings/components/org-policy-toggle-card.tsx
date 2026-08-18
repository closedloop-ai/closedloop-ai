"use client";

import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import { Badge } from "@repo/design-system/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { Label } from "@repo/design-system/components/ui/label";
import { Switch } from "@repo/design-system/components/ui/switch";
import { Loader2Icon } from "lucide-react";
import {
  ORG_POLICY_ERROR_EXPLANATION,
  ORG_POLICY_FIELD_STATE_BADGES,
  ORG_POLICY_UNAVAILABLE_EXPLANATION,
  OrgPolicyFieldState,
  type OrgPolicySaveAlert,
  type OrgPolicySaveState,
} from "../lib/org-policy-toggle-state";

/**
 * Presentational half of the org privacy toggles that ride the optional
 * session-sync/search policy contract (ISS-4624, lifted here by ISS-4668).
 *
 * Every component in this file is prop-driven and calls no data hook, so each
 * of the correctness-sensitive states — loading, error, the "Status unknown"
 * unavailable card, saving, save-error and not-confirmed — is reachable from a
 * story. The `apps/app` container owns the queries and picks which of these to
 * render; see `org-policy-toggle-card.tsx` under the settings route.
 *
 * The states exist because the policy fields are OPTIONAL on the wire: a new
 * app can be live against a previous API that strips them, so "unknown" is
 * first-class and distinct from both "still loading" and a server-reported
 * `false`. Rendering an unreadable privacy gate as OFF would be a lie.
 */
export function OrgPolicyEditableCard({
  description,
  saveState,
  state,
  title,
  toggleHelpText,
  toggleId,
  toggleLabel,
  onToggle,
}: Readonly<{
  description: string;
  saveState: OrgPolicySaveState;
  state: OrgPolicyFieldState;
  title: string;
  toggleHelpText: string;
  toggleId: string;
  toggleLabel: string;
  /** Called with the requested value; the container owns the write. */
  onToggle: (nextChecked: boolean) => void;
}>) {
  const toggleDescriptionId = `${toggleId}-description`;
  const alertId = `${toggleId}-save-alert`;
  const { requested, isSaving, saveAlert } = saveState;

  // Hold the switch at what the admin just asked for, and keep it disabled,
  // for the whole window the org read hasn't caught up — not just while the PUT
  // is pending. `isSaving` is true while a save is in flight OR a refetch is
  // still running and the live org read does not yet reflect the request; see
  // computeOrgPolicySaveState in the container. Once `current` catches up (or
  // the refetch ends), the switch follows the server and unlocks again.
  const checked =
    isSaving && requested !== undefined
      ? requested
      : state === OrgPolicyFieldState.Enabled;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor={toggleId}>{toggleLabel}</Label>
            <p
              className="text-muted-foreground text-sm"
              id={toggleDescriptionId}
            >
              {toggleHelpText}
            </p>
          </div>
          <Switch
            aria-describedby={
              saveAlert
                ? `${toggleDescriptionId} ${alertId}`
                : toggleDescriptionId
            }
            checked={checked}
            disabled={isSaving}
            id={toggleId}
            onCheckedChange={onToggle}
          />
        </div>
        {saveAlert ? (
          <Alert id={alertId} variant={saveAlert.variant}>
            <AlertDescription>{saveAlert.message}</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function OrgPolicyLoadingState({ title }: Readonly<{ title: string }>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2Icon aria-hidden="true" className="h-4 w-4 animate-spin" />
          Loading settings…
        </div>
      </CardContent>
    </Card>
  );
}

export function OrgPolicyErrorState({
  description,
  message,
  title,
  toggleHelpText,
}: Readonly<{
  description: string;
  message: string;
  title: string;
  toggleHelpText: string;
}>) {
  const badge = ORG_POLICY_FIELD_STATE_BADGES[OrgPolicyFieldState.Unavailable];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {/* The setting explains itself in the description slot — the raw server
            error goes below as detail, never here. A 500 or dropped connection
            leaves the admin in the same spot as deploy skew: a privacy control
            they can't verify, so this state gets the same shape and reassurance
            as the unavailable state rather than a bare error string. */}
        <CardDescription>{description}</CardDescription>
        {badge ? (
          <CardAction>
            <Badge variant={badge.variant}>{badge.label}</Badge>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-sm">{ORG_POLICY_ERROR_EXPLANATION}</p>
        <p className="text-muted-foreground text-sm">{toggleHelpText}</p>
        <p className="text-muted-foreground text-xs">{message}</p>
      </CardContent>
    </Card>
  );
}

export function OrgPolicyUnavailableState({
  description,
  title,
  toggleHelpText,
  saveAlert,
}: Readonly<{
  description: string;
  title: string;
  toggleHelpText: string;
  saveAlert?: OrgPolicySaveAlert | null;
}>) {
  const badge = ORG_POLICY_FIELD_STATE_BADGES[OrgPolicyFieldState.Unavailable];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
        {badge ? (
          <CardAction>
            <Badge variant={badge.variant}>{badge.label}</Badge>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-2">
        {/* Reading order is hierarchy: the whole point of this card is that we
            can't read the value, so the can't-read explanation leads at normal
            weight and the help text (what the setting would control) sits muted
            underneath. Keeping the help text at all still matters — this is the
            one state where the admin cannot read the value, so dropping the
            explanation too would leave the least informative card the least
            text. */}
        <p className="text-sm">{ORG_POLICY_UNAVAILABLE_EXPLANATION}</p>
        <p className="text-muted-foreground text-sm">{toggleHelpText}</p>
        {saveAlert ? (
          <Alert variant={saveAlert.variant}>
            <AlertDescription>{saveAlert.message}</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}
