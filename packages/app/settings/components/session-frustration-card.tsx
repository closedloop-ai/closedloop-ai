"use client";

import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { Label } from "@repo/design-system/components/ui/label";
import { Switch } from "@repo/design-system/components/ui/switch";
import { Loader2Icon } from "lucide-react";

const TOGGLE_ID = "calculate-session-frustration";
const TOGGLE_DESCRIPTION_ID = "calculate-session-frustration-description";
const SAVE_ALERT_ID = "calculate-session-frustration-save-alert";

/**
 * Presentational half of the admin-only opt-in for the session-frustration
 * signal (FEA-4022 / PLN-1481, lifted here by ISS-4668).
 *
 * Prop-driven and hook-free so the loading, error and save-error states are
 * reachable from a story. The `apps/app` container owns the query and mutation
 * and picks which of these to render.
 */
export function SessionFrustrationToggleCard({
  checked,
  isSaving,
  hasSaveError,
  onToggle,
}: Readonly<{
  checked: boolean;
  isSaving: boolean;
  hasSaveError: boolean;
  /** Called with the requested value; the container owns the write. */
  onToggle: (nextChecked: boolean) => void;
}>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Frustration Over Time</CardTitle>
        <CardDescription>
          Control whether sessions are scored for frustration signals and shown
          as a trend on the Insights dashboard.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor={TOGGLE_ID}>Score sessions for frustration</Label>
            <p
              className="text-muted-foreground text-sm"
              id={TOGGLE_DESCRIPTION_ID}
            >
              When on, each session is scored for frustration signals (repeated
              corrections and error spikes) and the Insights dashboard shows a
              normalized Frustration Over Time trend. The score is derived from
              prompt content, so it is off by default.
            </p>
          </div>
          <Switch
            aria-describedby={
              hasSaveError
                ? `${TOGGLE_DESCRIPTION_ID} ${SAVE_ALERT_ID}`
                : TOGGLE_DESCRIPTION_ID
            }
            checked={checked}
            disabled={isSaving}
            id={TOGGLE_ID}
            onCheckedChange={onToggle}
          />
        </div>
        {hasSaveError ? (
          <Alert id={SAVE_ALERT_ID} variant="error">
            <AlertDescription>
              Couldn't save that change. Try again.
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function SessionFrustrationLoadingState() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Session frustration insights</CardTitle>
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

export function SessionFrustrationErrorState({
  message,
}: Readonly<{ message: string }>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Session frustration insights</CardTitle>
        <CardDescription>{message}</CardDescription>
      </CardHeader>
    </Card>
  );
}
