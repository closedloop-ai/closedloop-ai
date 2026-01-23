"use client";

import type { LinearIntegrationStatus } from "@repo/api/src/types/linear";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { toast } from "@repo/design-system/components/ui/sonner";
import { CheckCircleIcon, ExternalLinkIcon, Loader2Icon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  disconnectLinear,
  getLinearIntegrationStatus,
  getLinearOAuthUrl,
} from "@/app/actions/linear";

export function LinearIntegrationCard() {
  const [status, setStatus] = useState<LinearIntegrationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    const result = await getLinearIntegrationStatus();
    if (result.success) {
      setStatus(result.data);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const handleConnect = async () => {
    setConnecting(true);
    try {
      // Get OAuth URL with signed auth token (needed for cross-domain auth)
      const url = await getLinearOAuthUrl();
      if (url) {
        window.location.href = url;
      } else {
        toast.error("Not authenticated. Please sign in again.");
        setConnecting(false);
      }
    } catch {
      toast.error("Failed to initiate Linear connection");
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    // biome-ignore lint/suspicious/noAlert: Simple confirmation for destructive action
    if (!confirm("Are you sure you want to disconnect Linear?")) {
      return;
    }

    setDisconnecting(true);
    const result = await disconnectLinear();
    if (result.success) {
      toast.success("Linear disconnected successfully");
      setStatus({ connected: false });
    } else {
      toast.error("Failed to disconnect Linear");
    }
    setDisconnecting(false);
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Linear Integration</CardTitle>
          <CardDescription>
            Connect Linear to export implementation plans as issues.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-4">
            <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Linear Integration</CardTitle>
        <CardDescription>
          Connect Linear to export implementation plans as issues.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {status?.connected ? (
              <>
                <CheckCircleIcon className="h-5 w-5 text-green-600" />
                <div>
                  <p className="font-medium">Connected to Linear</p>
                  {status.organizationName ? (
                    <p className="text-muted-foreground text-sm">
                      {status.organizationName}
                    </p>
                  ) : null}
                  {status.teams?.length ? (
                    <p className="text-muted-foreground text-sm">
                      {status.teams.length} team
                      {status.teams.length === 1 ? "" : "s"} available
                    </p>
                  ) : null}
                </div>
              </>
            ) : (
              <div>
                <p className="font-medium">Not connected</p>
                <p className="text-muted-foreground text-sm">
                  Connect Linear to export plans as issues
                </p>
              </div>
            )}
          </div>

          {status?.connected ? (
            <Button
              disabled={disconnecting}
              onClick={handleDisconnect}
              variant="outline"
            >
              {disconnecting ? (
                <>
                  <Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
                  Disconnecting...
                </>
              ) : (
                "Disconnect"
              )}
            </Button>
          ) : (
            <Button disabled={connecting} onClick={handleConnect}>
              {connecting ? (
                <>
                  <Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
                  Connecting...
                </>
              ) : (
                <>
                  <ExternalLinkIcon className="mr-2 h-4 w-4" />
                  Connect Linear
                </>
              )}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
