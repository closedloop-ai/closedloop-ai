import {
  Alert,
  AlertDescription,
} from "@closedloop-ai/design-system/components/ui/alert";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@closedloop-ai/design-system/components/ui/alert-dialog";
import { Button } from "@closedloop-ai/design-system/components/ui/button";
import {
  DEFAULT_TAKEOVER_SYNC_LEVEL,
  type SyncConsentLevel,
  SyncLevelOptions,
} from "@repo/app/onboarding/components/sync-consent";
import { AlertCircle, Loader2 } from "lucide-react";
import { useState } from "react";

/** The dialog's own heading — what the user is being asked to settle. */
const TAKEOVER_TITLE = "Sync Permissions";

const SAVE_LABEL = "Save";

/**
 * Names the org when we know it, and stays truthful when we do not.
 *
 * `useDesktopIdentity` resolves the org name over IPC and can settle on `null`
 * (a personal account, a failed identity fetch, or a bridge-less harness). The
 * prototype's copy interpolates the workspace unconditionally; doing that here
 * would render "You're signed in to !" — so the no-name case gets its own
 * sentence rather than a hole in the middle of one.
 */
export function takeoverDescription(organizationName: string | null): string {
  const destination = organizationName
    ? `You're signed in to ${organizationName}!`
    : "You're signed in!";
  return `${destination} Choose what level of data you want to sync to your organization's cloud. You can change this any time in Settings > Data & Sync.`;
}

type SyncConsentTakeoverProps = {
  /** Org name for the context line, or null when it did not resolve. */
  organizationName: string | null;
  /** Persists the answer. The host owns the write and the landing that follows. */
  onSave: (level: SyncConsentLevel) => void;
  /** Host-owned in-flight state: drives the spinner and disables Save. */
  saving: boolean;
  /**
   * A failed write, or null.
   *
   * The dialog reports it and stays open rather than closing on an answer that
   * was never recorded — Save remains live, so the banner is a retry prompt and
   * not a dead end.
   */
  error?: string | null;
};

/**
 * ISS-5489 (PLN-1694 M1) — the blocking post-auth sync-consent takeover.
 *
 * HARD BLOCK by construction, not by configuration. There is no Escape handler
 * to prevent, no overlay-click handler to swallow and no close control to hide:
 * the dialog is rendered `open` with no `onOpenChange`, so Radix has nowhere to
 * route a dismissal even if one were requested. Save is the only exit. That is
 * the point — the whole reason this surface exists is that a returning user who
 * skips it lands in the PRD-542 null-tier state, where nothing syncs and the app
 * silently does less than the user believes it is doing.
 *
 * It composes {@link SyncLevelOptions} rather than the full `SyncConsent` step so
 * the dialog owns its own title and description (which is what makes it
 * accessible as a dialog) while the per-level breakdown stays one implementation
 * shared with onboarding and Settings.
 *
 * Pre-selects {@link DEFAULT_TAKEOVER_SYNC_LEVEL} (Full) — deliberately not the
 * level onboarding starts on. See that constant for why the two surfaces differ,
 * and note the divergence is now the pre-selection ONLY: the chip comes from
 * `dataSyncLevelBadge`, one rule for every surface (ISS-5318).
 */
export function SyncConsentTakeover({
  organizationName,
  onSave,
  saving,
  error = null,
}: SyncConsentTakeoverProps) {
  const [selected, setSelected] = useState<SyncConsentLevel>(
    DEFAULT_TAKEOVER_SYNC_LEVEL
  );

  return (
    <AlertDialog open>
      <AlertDialogContent className="sm:max-w-xl">
        <AlertDialogHeader>
          <AlertDialogTitle>{TAKEOVER_TITLE}</AlertDialogTitle>
          <AlertDialogDescription className="text-pretty leading-relaxed">
            {takeoverDescription(organizationName)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {/* The three cards are tall and the window has no minimum height, so the
            options scroll inside the dialog rather than pushing Save out of
            reach on a short viewport. */}
        <div className="max-h-[55vh] overflow-y-auto">
          <SyncLevelOptions onSelect={setSelected} selected={selected} />
        </div>
        {error ? (
          <Alert variant="error">
            <AlertCircle />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <AlertDialogFooter>
          <Button
            aria-busy={saving}
            disabled={saving}
            onClick={() => onSave(selected)}
            type="button"
          >
            {saving ? <Loader2 className="animate-spin" /> : null}
            {SAVE_LABEL}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
