"use client";

import {
  useDisconnectLinear,
  useLinearIntegrationStatus,
} from "@repo/app/linear/hooks/use-linear";
import { Button } from "@repo/design-system/components/ui/button";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { CheckCircleIcon, ExternalLinkIcon, Loader2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { getLinearOAuthUrl } from "@/lib/integration-connect-urls";
import { IntegrationConnectionCard } from "./integration-connection-card";
import { IntegrationDisconnectDialog } from "./integration-disconnect-dialog";

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
  const [disconnectDialogOpen, setDisconnectDialogOpen] = useState(false);
  const { data: status, isLoading: loading } = useLinearIntegrationStatus();
  const disconnectLinear = useDisconnectLinear();
  const searchParams = useSearchParamsValue();

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
    try {
      await disconnectLinear.mutateAsync();
      toast.success("Linear disconnected successfully");
      setDisconnectDialogOpen(false);
    } catch {
      toast.error("Failed to disconnect Linear");
    }
  };

  if (loading) {
    return (
      <IntegrationConnectionCard
        description="Connect Linear to export implementation plans as issues."
        isLoading
        title="Linear Integration"
        titleIcon={
          <ExternalLinkIcon className="h-5 w-5 text-muted-foreground" />
        }
      />
    );
  }

  return (
    <>
      <IntegrationConnectionCard
        actions={
          status?.connected ? (
            <Button
              disabled={disconnectLinear.isPending}
              onClick={() => setDisconnectDialogOpen(true)}
              variant="outline"
            >
              {disconnectLinear.isPending ? (
                <>
                  <Loader2Icon className="h-4 w-4 animate-spin" />
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
                  <Loader2Icon className="h-4 w-4 animate-spin" />
                  Connecting...
                </>
              ) : (
                <>
                  <ExternalLinkIcon className="h-4 w-4" />
                  Connect Linear
                </>
              )}
            </Button>
          )
        }
        description="Connect Linear to export implementation plans as issues."
        statusDescription={
          status?.connected ? (
            <>
              {status.organizationName ? (
                <p>{status.organizationName}</p>
              ) : null}
              {status.teams?.length ? (
                <p>
                  {status.teams.length} team
                  {status.teams.length === 1 ? "" : "s"} available
                </p>
              ) : null}
            </>
          ) : (
            "Connect Linear to export plans as issues"
          )
        }
        statusIcon={
          status?.connected ? (
            <CheckCircleIcon className="h-5 w-5 text-success" />
          ) : undefined
        }
        statusTitle={
          status?.connected ? "Connected to Linear" : "Not connected"
        }
        title="Linear Integration"
        titleIcon={
          <ExternalLinkIcon className="h-5 w-5 text-muted-foreground" />
        }
      />

      <IntegrationDisconnectDialog
        description="Are you sure you want to disconnect Linear? You will need to reconnect before exporting plans as issues again."
        isPending={disconnectLinear.isPending}
        onConfirm={handleDisconnect}
        onOpenChange={setDisconnectDialogOpen}
        open={disconnectDialogOpen}
        title="Disconnect Linear"
      />
    </>
  );
}
