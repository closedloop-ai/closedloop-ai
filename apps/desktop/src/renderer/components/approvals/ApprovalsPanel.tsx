import { Badge } from "@closedloop-ai/design-system/components/ui/badge";
import { Button } from "@closedloop-ai/design-system/components/ui/button";
import {
  Card,
  CardContent,
} from "@closedloop-ai/design-system/components/ui/card";
import { useCallback, useEffect, useState } from "react";

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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await window.desktopApi.getPendingApprovals();
      setApprovals(data as Approval[]);
    } catch {
      /* ignore */
    }
    await loadRules();
    setLoading(false);
  }, [loadRules]);

  useEffect(() => {
    load().catch(() => {});
    const interval = setInterval(() => {
      load().catch(() => {});
    }, 3000);
    return () => clearInterval(interval);
  }, [load]);

  const handleApprove = async (id: string) => {
    try {
      await window.desktopApi.approveApproval(id);
    } catch {
      /* reload will pick up current state */
    }
    await load();
  };
  const handleDeny = async (id: string) => {
    try {
      await window.desktopApi.denyApproval(id);
    } catch {
      /* reload will pick up current state */
    }
    await load();
  };
  const handleAlwaysAllow = async (id: string) => {
    try {
      await window.desktopApi.alwaysAllowApproval(id);
    } catch {
      /* reload will pick up current state */
    }
    await load();
  };
  const handleClear = async () => {
    try {
      await window.desktopApi.clearPendingApprovals();
    } catch {
      /* reload will pick up current state */
    }
    await load();
  };
  const handleRevokeRule = async (ruleId: string) => {
    try {
      await window.desktopApi.removeAlwaysAllowRule(ruleId);
    } catch {
      /* reload will pick up current state */
    }
    await loadRules();
  };

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-[var(--foreground)] text-lg">
            Approvals
          </h2>
          <p className="text-[var(--muted-foreground)] text-sm">
            Pending requests that need approval
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={load} size="sm" variant="outline">
            Refresh
          </Button>
          <Button onClick={handleClear} size="sm" variant="outline">
            Clear Queue
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <p className="text-[var(--muted-foreground)] text-sm">
            Loading approvals...
          </p>
        </div>
      ) : approvals.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-[var(--muted-foreground)] text-sm">
            No pending approvals
          </CardContent>
        </Card>
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
                  <div className="flex gap-2 pt-1">
                    <Button onClick={() => handleApprove(a.id)} size="sm">
                      Approve
                    </Button>
                    <Button
                      onClick={() => handleDeny(a.id)}
                      size="sm"
                      variant="outline"
                    >
                      Deny
                    </Button>
                    <Button
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

      <div className="space-y-3 pt-2">
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
          <Card>
            <CardContent className="py-8 text-center text-[var(--muted-foreground)] text-sm">
              No always-allow rules
            </CardContent>
          </Card>
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
    </div>
  );
}
