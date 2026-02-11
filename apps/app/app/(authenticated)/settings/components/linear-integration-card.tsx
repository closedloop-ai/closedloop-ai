"use client";

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
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  getLinearOAuthUrl,
  useDisconnectLinear,
  useLinearIntegrationStatus,
} from "@/hooks/queries/use-linear";

/**
 * Error code to user-friendly message mapping.
 * Must match LINEAR_ERROR_CODES from linear-utils.ts
 */
const ERROR_MESSAGES: Record<string, string> = {
  not_authenticated: "Please sign in to connect Linear.",
  not_configured: "Linear integration is not configured.",
  missing_params: "Invalid authorization request. Please try again.",
  invalid_state: "Security validation failed. Please try again.",
  invalid_request: "Invalid authorization request. Please try again.",
  connection_failed: "Failed to connect to Linear. Please try again.",
  oauth_failed: "Authorization failed. Please try again.",
};

export function LinearIntegrationCard() {
  const [connecting, setConnecting] = useState(false);
  const { data: status, isLoading: loading } = useLinearIntegrationStatus();
  const disconnectLinear = useDisconnectLinear();
  const searchParams = useSearchParams();

  // Handle OAuth callback results from URL params
  useEffect(() => {
    const linearStatus = searchParams.get("linear");
    const errorCode = searchParams.get("code");

    if (linearStatus === "connected") {
      toast.success("Linear connected successfully!");
      // Clean up URL params
      window.history.replaceState({}, "", window.location.pathname);
    } else if (linearStatus === "error" && errorCode) {
      const message = ERROR_MESSAGES[errorCode] ?? "An error occurred.";
      toast.error(message);
      // Clean up URL params
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [searchParams]);

  const handleConnect = () => {
    setConnecting(true);
    // Redirect to app's OAuth route (Clerk auth works natively there)
    window.location.href = getLinearOAuthUrl();
  };

  const handleDisconnect = async () => {
    // biome-ignore lint/suspicious/noAlert: Simple confirmation for destructive action
    if (!confirm("Are you sure you want to disconnect Linear?")) {
      return;
    }

    try {
      await disconnectLinear.mutateAsync();
      toast.success("Linear disconnected successfully");
    } catch {
      toast.error("Failed to disconnect Linear");
    }
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
              disabled={disconnectLinear.isPending}
              onClick={handleDisconnect}
              variant="outline"
            >
              {disconnectLinear.isPending ? (
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
