import { formatTimeOrFallback } from "@repo/app/shared/lib/date-utils";
import { Badge } from "@closedloop-ai/design-system/components/ui/badge";
import { Button } from "@closedloop-ai/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@closedloop-ai/design-system/components/ui/card";
import { Checkbox } from "@closedloop-ai/design-system/components/ui/checkbox";
import { useCallback, useEffect, useState } from "react";

type ActivityEvent = {
  id: string;
  type?: string;
  summary?: string;
  timestamp?: string;
};

type Job = {
  id: string;
  description?: string;
  status?: string;
  startedAt?: string;
};

export function ActivityPanel() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [runningJobs, setRunningJobs] = useState<Job[]>([]);
  const [completedJobs, setCompletedJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [showRegular, setShowRegular] = useState(true);
  const [showSecurity, setShowSecurity] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [evts, running, completed] = await Promise.all([
        window.desktopApi.getActivityEvents(),
        window.desktopApi.listRunningJobs(),
        window.desktopApi.listCompletedJobs(),
      ]);
      setEvents((evts as ActivityEvent[]) ?? []);
      setRunningJobs((running as Job[]) ?? []);
      setCompletedJobs((completed as Job[]) ?? []);
    } catch {
      /* ignore */
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  const handleClear = async () => {
    try {
      await window.desktopApi.clearActivityEvents();
    } catch {
      /* reload will pick up current state */
    }
    await load();
  };

  const filtered = events.filter((e) => {
    const type = e.type ?? "";
    if (type.includes("security") || type.includes("auth")) {
      return showSecurity;
    }
    return showRegular;
  });

  const jobStatusVariant = (status?: string) => {
    if (status === "running" || status === "active") {
      return "default";
    }
    if (status === "completed" || status === "success") {
      return "secondary";
    }
    return "outline";
  };

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-[var(--foreground)] text-lg">
          Activity
        </h2>
        <div className="flex gap-2">
          <Button onClick={load} size="sm" variant="outline">
            Refresh
          </Button>
          <Button onClick={handleClear} size="sm" variant="outline">
            Clear Activity
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Running Jobs</CardTitle>
        </CardHeader>
        <CardContent>
          {runningJobs.length === 0 ? (
            <p className="py-4 text-center text-[var(--muted-foreground)] text-sm">
              No running jobs
            </p>
          ) : (
            <div className="space-y-2">
              {runningJobs.map((j) => (
                <div
                  className="flex items-center justify-between rounded border p-3 text-sm"
                  key={j.id}
                >
                  <span className="truncate">{j.description ?? j.id}</span>
                  <Badge variant={jobStatusVariant(j.status)}>
                    {j.status ?? "running"}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <details className="group">
        <summary className="mb-2 cursor-pointer font-medium text-[var(--foreground)] text-sm">
          Completed Jobs ({completedJobs.length})
        </summary>
        <Card className="mt-2">
          <CardContent>
            {completedJobs.length === 0 ? (
              <p className="py-4 text-center text-[var(--muted-foreground)] text-sm">
                No completed jobs
              </p>
            ) : (
              <div className="max-h-48 space-y-2 overflow-y-auto">
                {completedJobs.map((j) => (
                  <div
                    className="flex items-center justify-between rounded border p-3 text-sm"
                    key={j.id}
                  >
                    <span className="truncate">{j.description ?? j.id}</span>
                    <Badge variant={jobStatusVariant(j.status)}>
                      {j.status ?? "completed"}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </details>

      <Card>
        <CardHeader>
          <CardTitle>Gateway Request Log</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-4 text-sm">
            <label
              className="flex cursor-pointer items-center gap-2"
              htmlFor="show-regular-events"
            >
              <Checkbox
                checked={showRegular}
                id="show-regular-events"
                onCheckedChange={(checked) => setShowRegular(checked === true)}
              />
              Show Regular Events
            </label>
            <label
              className="flex cursor-pointer items-center gap-2"
              htmlFor="show-security-events"
            >
              <Checkbox
                checked={showSecurity}
                id="show-security-events"
                onCheckedChange={(checked) => setShowSecurity(checked === true)}
              />
              Show Security Events
            </label>
          </div>
          {loading ? (
            <p className="py-4 text-center text-[var(--muted-foreground)] text-sm">
              Loading...
            </p>
          ) : filtered.length === 0 ? (
            <p className="py-4 text-center text-[var(--muted-foreground)] text-sm">
              No events
            </p>
          ) : (
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {filtered.map((e) => (
                <div
                  className="flex items-start gap-2 border-b p-1.5 text-xs last:border-0"
                  key={e.id}
                >
                  <span className="w-16 shrink-0 text-[var(--muted-foreground)]">
                    {formatActivityTimestamp(e.timestamp)}
                  </span>
                  <span className="font-medium">{e.type}</span>
                  <span className="truncate text-[var(--muted-foreground)]">
                    {e.summary}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function formatActivityTimestamp(timestamp: string | undefined): string {
  return timestamp
    ? formatTimeOrFallback(timestamp, { includeSeconds: true })
    : "";
}
