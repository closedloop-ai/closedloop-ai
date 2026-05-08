"use client";

import { useMemo } from "react";
import { decodeText } from "@/lib/engineer/run-viewer-utils";

type StateData = {
  phase?: string;
  status?: string;
  timestamp?: string;
  [key: string]: unknown;
};

type StateViewerProps = {
  data: Uint8Array;
};

function getStatusColor(status: string): string {
  const s = status.toLowerCase();
  if (s === "completed" || s === "done" || s === "success") {
    return "bg-emerald-500";
  }
  if (s === "running" || s === "in_progress" || s === "active") {
    return "bg-blue-500";
  }
  if (s === "failed" || s === "error") {
    return "bg-red-500";
  }
  if (s === "pending" || s === "waiting") {
    return "bg-amber-500";
  }
  return "bg-muted-foreground";
}

export function StateViewer({ data }: Readonly<StateViewerProps>) {
  const state = useMemo((): StateData | null => {
    try {
      return JSON.parse(decodeText(data)) as StateData;
    } catch {
      return null;
    }
  }, [data]);

  if (!state) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        Invalid state.json
      </div>
    );
  }

  const entries = Object.entries(state).filter(
    ([key]) => key !== "phase" && key !== "status" && key !== "timestamp"
  );

  return (
    <div className="h-full space-y-6 overflow-auto p-6">
      <div className="space-y-4 rounded-lg border p-6">
        <h3 className="font-medium text-muted-foreground text-sm uppercase tracking-wider">
          Session State
        </h3>

        <div className="flex items-center gap-4">
          {state.phase && (
            <div>
              <div className="mb-1 text-muted-foreground text-xs">Phase</div>
              <div className="font-semibold text-lg">{state.phase}</div>
            </div>
          )}
          {state.status && (
            <div>
              <div className="mb-1 text-muted-foreground text-xs">Status</div>
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium text-white text-xs ${getStatusColor(state.status)}`}
              >
                <span className="size-1.5 rounded-full bg-white/50" />
                {state.status}
              </span>
            </div>
          )}
          {state.timestamp && (
            <div>
              <div className="mb-1 text-muted-foreground text-xs">
                Timestamp
              </div>
              <div className="font-mono text-sm">{state.timestamp}</div>
            </div>
          )}
        </div>
      </div>

      {entries.length > 0 && (
        <div className="rounded-lg border p-6">
          <h3 className="mb-4 font-medium text-muted-foreground text-sm uppercase tracking-wider">
            Additional Fields
          </h3>
          <div className="space-y-2">
            {entries.map(([key, value]) => (
              <div className="flex gap-4 text-sm" key={key}>
                <span className="min-w-[140px] shrink-0 font-mono text-muted-foreground">
                  {key}
                </span>
                <span className="break-all font-mono">
                  {JSON.stringify(value)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
