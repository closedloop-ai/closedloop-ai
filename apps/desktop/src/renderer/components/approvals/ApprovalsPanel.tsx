import { Badge } from "@closedloop-ai/design-system/components/ui/badge";
import { Button } from "@closedloop-ai/design-system/components/ui/button";
import {
  Card,
  CardContent,
} from "@closedloop-ai/design-system/components/ui/card";
import { EmptyState } from "@closedloop-ai/design-system/components/ui/empty-state";
import { ListChecksIcon, ShieldCheckIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { pageTitleForNav } from "../../navigation/nav-config";
import { NavId } from "../../navigation/route-table";
import { PageShell } from "../layout/page-shell";

type Approval = {
  id: string;
  reason: string;
  request?: { path?: string; args?: Record<string, unknown> };
  riskTier?: string;
  createdAt?: string;
};

type AlwaysAllowRule = {
  id: string;
  method?: string;
  path?: string;
  scopePath?: string;
  expiresAt?: string;
};

function formatExpiry(expiresAt?: string): string | null {
  if (!expiresAt) {
    return null;
  }
  const ts = Date.parse(expiresAt);
  if (Number.isNaN(ts)) {
    return null;
  }
  return new Date(ts).toLocaleString();
}

export function ApprovalsPanel() {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [alwaysAllowRules, setAlwaysAllowRules] = useState<AlwaysAllowRule[]>(
    []
  );
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadRules = useCallback(async () => {
    try {
      const settings = (await window.desktopApi.getSettings()) as {
        alwaysAllowRules?: AlwaysAllowRule[];
      } | null;
      setAlwaysAllowRules(settings?.alwaysAllowRules ?? []);
    } catch {
      /* ignore */
    }
  }, []);

  // The BACKGROUND read. Deliberately raises neither flag: `loading` starts true
  // and is only ever cleared here, so the treatment covers the first read and
  // nothing after it. Re-raising it on the 3s poll below swapped the whole
  // pending list out for the loading text and back on every tick, so each queued
  // request's buttons were a new DOM node every 3 seconds — invisible when the
  // read is fast, but a request the user is reaching for is torn out from under
  // the pointer once the read is slow.
  const load = useCallback(async () => {
    try {
      const data = await window.desktopApi.getPendingApprovals();
      setApprovals(data as Approval[]);
    } catch {
      /* ignore */
    }
    await loadRules();
    setLoading(false);
  }, [loadRules]);

  // Every USER-INITIATED path runs through here, and the flag spans the whole
  // action — the mutation AND the reload behind it. An explicit action owes the
  // person who took it a signal, and `loading` can no longer carry one past the
  // first read. Reported on the controls themselves rather than by unmounting
  // the list, so restoring this feedback cannot restore the teardown above.
  //
  // Wrapping only the reload would leave the decision IPC uncovered. Not because
  // that IPC is slow — it is one round trip like the read, resolving a promise the
  // gateway is already parked on — but because it is the call that MUTATES the
  // store. Between it and the redraw behind it every control still reads as idle
  // over a queue that no longer matches, so a mis-clicked Approve could be
  // "corrected" by a Deny that silently resolved an approval already gone.
  const runUserAction = useCallback(async (action: () => Promise<void>) => {
    setRefreshing(true);
    try {
      await action();
    } finally {
      setRefreshing(false);
    }
  }, []);

  const refresh = useCallback(() => runUserAction(load), [load, runUserAction]);

  useEffect(() => {
    load().catch(() => {});
    const interval = setInterval(() => {
      load().catch(() => {});
    }, 3000);
    return () => clearInterval(interval);
  }, [load]);

  const decide = (resolveRequest: () => Promise<unknown>) =>
    runUserAction(async () => {
      try {
        await resolveRequest();
      } catch {
        /* reload will pick up current state */
      }
      await load();
    });

  const handleApprove = (id: string) =>
    decide(() => window.desktopApi.approveApproval(id));
  const handleDeny = (id: string) =>
    decide(() => window.desktopApi.denyApproval(id));
  const handleAlwaysAllow = (id: string) =>
    decide(() => window.desktopApi.alwaysAllowApproval(id));
  const handleClear = () =>
    decide(() => window.desktopApi.clearPendingApprovals());
  const handleRevokeRule = (ruleId: string) =>
    runUserAction(async () => {
      try {
        await window.desktopApi.removeAlwaysAllowRule(ruleId);
      } catch {
        /* reload will pick up current state */
      }
      await loadRules();
    });

  return (
    <PageShell
      actions={
        <div className="flex gap-2">
          <Button
            disabled={refreshing}
            onClick={refresh}
            size="sm"
            variant="outline"
          >
            {refreshing ? "Refreshing..." : "Refresh"}
          </Button>
          <Button
            disabled={refreshing}
            onClick={handleClear}
            size="sm"
            variant="outline"
          >
            Clear Queue
          </Button>
        </div>
      }
      description="Pending requests that need approval"
      title={pageTitleForNav(NavId.Approvals)}
    >
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <p className="text-[var(--muted-foreground)] text-sm">
            Loading approvals...
          </p>
        </div>
      ) : approvals.length === 0 ? (
        <EmptyState
          description="Requests that need your approval will appear here."
          icon={ShieldCheckIcon}
          title="No pending approvals"
        />
      ) : (
        <div className="space-y-3">
          {approvals.map((a) => (
            <Card key={a.id}>
              <CardContent className="pt-4">
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="font-medium text-sm">{a.reason}</p>
                      {a.request?.path && (
                        <p className="break-all font-mono text-[var(--muted-foreground)] text-xs">
                          {a.request.path}
                        </p>
                      )}
                    </div>
                    <Badge variant="outline">{a.riskTier ?? "unknown"}</Badge>
                  </div>
                  {/* Each decision releases or refuses a WAITING gateway
                      request, and the queue only redraws once the reload behind
                      it lands. Left live, the seconds after a click look exactly
                      like the seconds before it, so a second decision on a
                      request already resolved reads as having been taken. */}
                  <div className="flex gap-2 pt-1">
                    <Button
                      disabled={refreshing}
                      onClick={() => handleApprove(a.id)}
                      size="sm"
                    >
                      Approve
                    </Button>
                    <Button
                      disabled={refreshing}
                      onClick={() => handleDeny(a.id)}
                      size="sm"
                      variant="outline"
                    >
                      Deny
                    </Button>
                    <Button
                      disabled={refreshing}
                      onClick={() => handleAlwaysAllow(a.id)}
                      size="sm"
                      variant="secondary"
                    >
                      Always Allow
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <div className="space-y-3">
        <div>
          <h2 className="font-semibold text-[var(--foreground)] text-lg">
            Always Allow Rules
          </h2>
          <p className="text-[var(--muted-foreground)] text-sm">
            Granted "Always Allow" rules that skip interactive approval until
            they expire. Revoke a rule to require approval again.
          </p>
        </div>

        {alwaysAllowRules.length === 0 ? (
          <EmptyState
            description={
              'Rules you grant with "Always Allow" will appear here until they expire.'
            }
            icon={ListChecksIcon}
            title="No always-allow rules"
          />
        ) : (
          <div className="space-y-2">
            {alwaysAllowRules.map((rule) => {
              const expiry = formatExpiry(rule.expiresAt);
              const label = [rule.method, rule.scopePath ?? rule.path]
                .filter(Boolean)
                .join(" ");
              return (
                <Card key={rule.id}>
                  <CardContent className="flex items-center justify-between gap-4 py-3">
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="truncate font-mono text-sm">
                        {label || "Rule"}
                      </p>
                      {expiry && (
                        <p className="text-[var(--muted-foreground)] text-xs">
                          Expires {expiry}
                        </p>
                      )}
                    </div>
                    <Button
                      className="shrink-0 text-[var(--destructive)]"
                      disabled={refreshing}
                      onClick={() => handleRevokeRule(rule.id)}
                      size="sm"
                      variant="ghost"
                    >
                      Revoke
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </PageShell>
  );
}
