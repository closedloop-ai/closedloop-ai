"use client";

import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@repo/design-system/components/ui/alert-dialog";
import { Button } from "@repo/design-system/components/ui/button";
import { CheckIcon } from "lucide-react";
import { useEffect, useState } from "react";
import {
  type AuthMethod as AuthMethodType,
  DataSyncLevel,
  DEFAULT_SYNC_TAKEOVER_LEVEL,
} from "../mock";
import { DataSyncPanel } from "./data-sync-panel";
import { SessionsPage } from "./sessions-page";

// How long the save confirmation is held before the takeover auto-advances to
// the Sessions page. A Continue button lets the user leave immediately (the
// footer always keeps an action); the timer is the hands-off fallback.
const SAVE_CONFIRM_HOLD_MS = 3000;

// Per-level save confirmation copy. Each names what the chosen level does with
// the user's data, except Off which has nothing to sync and instead points back
// to where the setting lives.
const SAVED_MESSAGE: Record<DataSyncLevel, string> = {
  [DataSyncLevel.Full]: "Saved. Full transcripts syncing...",
  [DataSyncLevel.Metadata]: "Saved. Session metadata syncing...",
  [DataSyncLevel.Off]:
    "Saved. You can change this setting any time in Settings > Data & Sync",
};

// Steps 2-4 — a blocking, focus-trapping consent modal the returning
// authenticated user cannot skip past. It reuses the Settings → Data & Sync
// control (DataSyncPanel) to ask how much data should sync, pre-selecting Full
// transcripts per ISS-5249. Built on the catalog AlertDialog so focus moves into
// it on open, is trapped, and returns on close; the dimmed Sessions page behind
// it is `inert`, so keyboard focus and screen readers can't reach it.
type SyncTakeoverProps = {
  authMethod: AuthMethodType;
  // Receives the committed level so the Sessions page can acknowledge the sync
  // it just authorized (and stay honest when the choice was Off).
  onFinish: (level: DataSyncLevel) => void;
  workspaceName: string;
};

export const SyncTakeover = ({
  authMethod,
  onFinish,
  workspaceName,
}: SyncTakeoverProps) => {
  const [selected, setSelected] = useState<DataSyncLevel>(
    DEFAULT_SYNC_TAKEOVER_LEVEL
  );
  const [savedLevel, setSavedLevel] = useState<DataSyncLevel | null>(null);

  // Hold the confirmation for a beat, then auto-advance to Sessions. Changing
  // the selection clears savedLevel, which cancels this pending dismissal.
  useEffect(() => {
    if (savedLevel === null) {
      return;
    }
    const timer = setTimeout(() => onFinish(savedLevel), SAVE_CONFIRM_HOLD_MS);
    return () => clearTimeout(timer);
  }, [savedLevel, onFinish]);

  return (
    <div className="relative min-h-svh">
      {/* The Sessions page the user is about to land on sits behind the modal so
          the app never feels like it went away. `inert` takes it fully out of
          tab order and the accessibility tree (pointer-events-none alone would
          not), and the AlertDialog's own overlay provides the single dimming
          layer — no extra opacity/blur stack. */}
      <div className="absolute inset-0 overflow-hidden" inert>
        <SessionsPage
          authMethod={authMethod}
          onAuthMethodChange={() => {
            // no-op: the backdrop is inert
          }}
          onRestart={() => {
            // no-op: the backdrop is inert
          }}
          preview
          workspaceName={workspaceName}
        />
      </div>

      <AlertDialog open>
        <AlertDialogContent
          className="sm:max-w-xl"
          // Blocking consent: not dismissible by Escape.
          onEscapeKeyDown={(event) => event.preventDefault()}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Sync Permissions</AlertDialogTitle>
            <AlertDialogDescription className="text-pretty leading-relaxed">
              You're signed in to {workspaceName}! Choose what level of data you
              want to sync to your organization's cloud. You can change this any
              time in Settings &gt; Data &amp; Sync.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="max-h-[55vh] space-y-4 overflow-y-auto">
            <DataSyncPanel
              defaultLevel={DEFAULT_SYNC_TAKEOVER_LEVEL}
              onSelect={(level) => {
                setSelected(level);
                setSavedLevel(null);
              }}
              selected={selected}
            />
            {savedLevel ? (
              <Alert variant="success">
                <CheckIcon />
                <AlertDescription>{SAVED_MESSAGE[savedLevel]}</AlertDescription>
              </Alert>
            ) : null}
          </div>
          <AlertDialogFooter className="items-center">
            {savedLevel ? (
              <>
                <span className="mr-auto text-muted-foreground text-xs">
                  Taking you to your sessions...
                </span>
                <Button onClick={() => onFinish(savedLevel)}>
                  Continue to Sessions
                </Button>
              </>
            ) : (
              <Button onClick={() => setSavedLevel(selected)}>Save</Button>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
