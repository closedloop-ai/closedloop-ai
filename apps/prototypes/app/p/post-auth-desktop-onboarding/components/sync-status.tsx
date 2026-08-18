"use client";

import { Card } from "@repo/design-system/components/ui/card";
import { Progress } from "@repo/design-system/components/ui/progress";
import { CheckIcon, EyeOffIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { DataSyncLevel, dataSyncLevelOptions } from "../mock";

// Acknowledges the sync the user just authorized in the takeover, using the same
// Progress bar the desktop import-splash ships in prod
// (apps/desktop/.../import-splash/harness-progress-list.tsx). For a syncing
// level it advances a bar to completion; for Off it stays honest — nothing is
// uploading — instead of pretending to sync.
type SyncStatusProps = {
  level: DataSyncLevel;
  workspaceName: string;
};

const TOTAL_SESSIONS = 248;
const TICK_MS = 450;
const STEP_PCT = 11;
const INITIAL_PCT = 7;

export const SyncStatus = ({ level, workspaceName }: SyncStatusProps) => {
  if (level === DataSyncLevel.Off) {
    return (
      <Card className="flex-row items-center gap-3 p-4">
        <EyeOffIcon className="size-4 shrink-0 text-muted-foreground" />
        <p className="text-muted-foreground text-sm">
          Cloud sync is off. Your sessions stay on this Mac — change this any
          time in Settings &gt; Data &amp; Sync.
        </p>
      </Card>
    );
  }
  return <SyncingCard level={level} workspaceName={workspaceName} />;
};

const SyncingCard = ({ level, workspaceName }: SyncStatusProps) => {
  const [pct, setPct] = useState(INITIAL_PCT);

  useEffect(() => {
    if (pct >= 100) {
      return;
    }
    const timer = setTimeout(
      () => setPct((current) => Math.min(100, current + STEP_PCT)),
      TICK_MS
    );
    return () => clearTimeout(timer);
  }, [pct]);

  const done = pct >= 100;
  const processed = Math.round((pct / 100) * TOTAL_SESSIONS);
  const detail = findLevelDetail(level);

  return (
    <Card className="gap-0 p-4">
      <div className="flex items-center gap-3">
        {done ? (
          <CheckIcon className="size-4 shrink-0 text-success" />
        ) : (
          <span
            aria-hidden
            className="size-2 shrink-0 animate-pulse rounded-full bg-primary"
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="font-medium text-sm">
            {done ? "Sessions synced to" : "Syncing your sessions to"}{" "}
            {workspaceName}
          </p>
          <p className="text-muted-foreground text-xs">{detail}</p>
        </div>
        <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
          {processed.toLocaleString()} / {TOTAL_SESSIONS.toLocaleString()}
        </span>
      </div>
      <Progress aria-label="Sync progress" className="mt-3 h-1.5" value={pct} />
    </Card>
  );
};

// The per-level detail line, derived from the same option copy the takeover
// shows so the two never disagree about what is being uploaded.
function findLevelDetail(level: DataSyncLevel): string {
  const option = dataSyncLevelOptions.find((o) => o.level === level);
  if (level === DataSyncLevel.Full) {
    return "Uploading full transcripts";
  }
  return `Uploading ${(option?.badgeLabel ?? "session").toLowerCase()}`;
}
