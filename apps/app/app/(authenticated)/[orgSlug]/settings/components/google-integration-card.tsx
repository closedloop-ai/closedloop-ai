"use client";

import {
  useDisconnectGoogle,
  useGoogleIntegrationStatus,
} from "@repo/app/google/hooks/use-google-integration";
import { Button } from "@repo/design-system/components/ui/button";
import { toast } from "@repo/design-system/components/ui/sonner";
import {
  AlertCircleIcon,
  CheckCircleIcon,
  ExternalLinkIcon,
  Loader2Icon,
} from "lucide-react";
import { useState } from "react";
import { getGoogleOAuthUrl } from "@/lib/integration-connect-urls";
import { GoogleImportModal } from "./google-import-modal";
import { IntegrationConnectionCard } from "./integration-connection-card";
import { IntegrationDisconnectDialog } from "./integration-disconnect-dialog";

export function GoogleIntegrationCard() {
  const [connecting, setConnecting] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [disconnectDialogOpen, setDisconnectDialogOpen] = useState(false);
  const { data: status, isLoading: loading } = useGoogleIntegrationStatus();
  const disconnectMutation = useDisconnectGoogle();

  const handleConnect = () => {
    setConnecting(true);
    // Redirect to app's OAuth route (Clerk auth works natively there)
    window.location.href = getGoogleOAuthUrl();
  };

  const handleDisconnect = async () => {
    try {
      await disconnectMutation.mutateAsync();
      toast.success("Google Drive disconnected successfully");
      setDisconnectDialogOpen(false);
    } catch {
      toast.error("Failed to disconnect Google Drive");
    }
  };

  if (loading) {
    return (
      <IntegrationConnectionCard
        description="Import Google Docs as PRD artifacts."
        isLoading
        title="Google Drive"
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
            <>
              <Button
                onClick={() => setImportModalOpen(true)}
                variant="outline"
              >
                Import from Folder
              </Button>
              <Button
                onClick={() => setDisconnectDialogOpen(true)}
                variant="outline"
              >
                Disconnect
              </Button>
            </>
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
                  Connect Google Drive
                </>
              )}
            </Button>
          )
        }
        banner={
          <div className="flex items-start gap-2 rounded-lg bg-warning/12 p-3">
            <AlertCircleIcon className="mt-0.5 h-4 w-4 flex-shrink-0 text-warning" />
            <p className="text-sm text-warning-foreground">
              This integration will have read access to all files in your Google
              Drive.
            </p>
          </div>
        }
        description="Import Google Docs as PRD artifacts."
        statusDescription={
          status?.connected
            ? status.email
            : "Connect Google Drive to import documents"
        }
        statusIcon={
          status?.connected ? (
            <CheckCircleIcon className="h-5 w-5 text-success" />
          ) : undefined
        }
        statusTitle={
          status?.connected ? "Connected to Google Drive" : "Not connected"
        }
        title="Google Drive"
        titleIcon={
          <ExternalLinkIcon className="h-5 w-5 text-muted-foreground" />
        }
      />

      <GoogleImportModal
        onOpenChange={setImportModalOpen}
        open={importModalOpen}
      />

      <IntegrationDisconnectDialog
        confirmLabel="Disconnect"
        description="Are you sure you want to disconnect Google Drive? You will need to reconnect to import documents."
        isPending={disconnectMutation.isPending}
        onConfirm={handleDisconnect}
        onOpenChange={setDisconnectDialogOpen}
        open={disconnectDialogOpen}
        title="Disconnect Google Drive"
      />
    </>
  );
}
