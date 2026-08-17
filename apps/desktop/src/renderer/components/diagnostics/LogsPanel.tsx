import { Button } from "@closedloop-ai/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@closedloop-ai/design-system/components/ui/card";
import { formatTime } from "@repo/app/shared/lib/date-utils";
import { useCallback, useEffect, useMemo, useState } from "react";
import { isRecord } from "../../../shared/type-guards";

type LogEntry = {
  timestamp?: string;
  level?: "info" | "warn" | "error" | string;
  tag?: string;
  message?: string;
  session?: "current" | "previous" | string;
};

function toLogEntries(value: unknown): LogEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isRecord).map((entry) => ({
    timestamp:
      typeof entry.timestamp === "string" ? entry.timestamp : undefined,
    level: typeof entry.level === "string" ? entry.level : "info",
    tag: typeof entry.tag === "string" ? entry.tag : "desktop",
    message: typeof entry.message === "string" ? entry.message : "",
    session: typeof entry.session === "string" ? entry.session : "current",
  }));
}

function resultError(value: unknown): string | null {
  if (!isRecord(value) || value.ok !== false) {
    return null;
  }

  return typeof value.error === "string" ? value.error : "unknown error";
}

function formatTimestamp(timestamp: string | undefined): string {
  if (!timestamp) {
    return "";
  }

  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return timestamp;
  }

  return formatTime(parsed, { includeSeconds: true });
}

function levelClassName(level: string | undefined): string {
  if (level === "error") {
    return "border-red-200 bg-red-50 text-red-700";
  }

  if (level === "warn") {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }

  return "border-slate-200 bg-slate-50 text-slate-700";
}

/** Displays recent desktop gateway logs from the main-process diagnostics IPC. */
export function LogsPanel() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logFilePath, setLogFilePath] = useState<string>("");

  const load = useCallback(
    async (force = false) => {
      if (paused && !force) {
        return;
      }

      setLoading(true);
      try {
        const logs = await window.desktopApi.getLogs();
        setEntries(toLogEntries(logs));
        setError(null);
      } catch (loadError) {
        setError(
          loadError instanceof Error ? loadError.message : "Failed to load logs"
        );
      } finally {
        setLoading(false);
      }
    },
    [paused]
  );

  useEffect(() => {
    void load(true);
    const interval = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(interval);
  }, [load]);

  useEffect(() => {
    window.desktopApi
      .getLogFilePath()
      .then((path) => setLogFilePath(path))
      .catch(() => setLogFilePath(""));
  }, []);

  const visibleEntries = useMemo(() => entries.slice(-500), [entries]);

  const handleRefresh = () => {
    void load(true);
  };

  const handleClear = async () => {
    try {
      await window.desktopApi.clearLogs();
      setEntries([]);
      setError(null);
    } catch (clearError) {
      setError(
        clearError instanceof Error
          ? clearError.message
          : "Failed to clear logs"
      );
    }
  };

  const handleOpenLogFile = async () => {
    try {
      const result = await window.desktopApi.openLogFile();
      setError(resultError(result));
    } catch (openError) {
      setError(
        openError instanceof Error
          ? openError.message
          : "Failed to open log file"
      );
    }
  };

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-semibold text-[var(--foreground)] text-lg">
            Diagnostics
          </h2>
          <p
            className="truncate text-[var(--muted-foreground)] text-sm"
            title={logFilePath || undefined}
          >
            {logFilePath || "Desktop gateway logs"}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button onClick={handleRefresh} size="sm" variant="outline">
            Refresh
          </Button>
          <Button
            onClick={() => setPaused((current) => !current)}
            size="sm"
            variant="outline"
          >
            {paused ? "Resume" : "Pause"}
          </Button>
          <Button onClick={handleOpenLogFile} size="sm" variant="outline">
            Open File
          </Button>
          <Button onClick={handleClear} size="sm" variant="outline">
            Clear
          </Button>
        </div>
      </div>

      {error && (
        <div
          className="rounded border border-red-200 bg-red-50 px-3 py-2 text-red-700 text-sm"
          role="alert"
        >
          {error}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Gateway Log</CardTitle>
        </CardHeader>
        <CardContent>
          {loading && visibleEntries.length === 0 ? (
            <p className="py-12 text-center text-[var(--muted-foreground)] text-sm">
              Loading logs...
            </p>
          ) : visibleEntries.length === 0 ? (
            <p className="py-12 text-center text-[var(--muted-foreground)] text-sm">
              No log entries yet
            </p>
          ) : (
            <div className="max-h-[65vh] overflow-y-auto rounded border bg-white font-mono text-xs">
              {visibleEntries.map((entry, index) => (
                <div
                  className="grid grid-cols-[88px_72px_120px_minmax(0,1fr)] gap-3 border-b px-3 py-2 last:border-b-0"
                  key={`${entry.timestamp ?? ""}-${entry.level ?? ""}-${
                    entry.tag ?? ""
                  }-${index}`}
                >
                  <span className="text-[var(--muted-foreground)]">
                    {formatTimestamp(entry.timestamp)}
                  </span>
                  <span
                    className={`rounded border px-1.5 py-0.5 text-center uppercase ${levelClassName(
                      entry.level
                    )}`}
                  >
                    {entry.level ?? "info"}
                  </span>
                  <span className="truncate text-[var(--muted-foreground)]">
                    {entry.session === "previous"
                      ? `${entry.tag ?? "desktop"} previous`
                      : (entry.tag ?? "desktop")}
                  </span>
                  <span className="break-words">{entry.message}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
