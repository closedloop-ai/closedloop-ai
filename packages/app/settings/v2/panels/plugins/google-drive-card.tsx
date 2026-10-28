"use client";

import { GOOGLE_OAUTH_CONNECT_PATH } from "@repo/api/src/types/integration-connect-routes";
import { Button } from "@repo/design-system/components/ui/button";
import { toast } from "@repo/design-system/components/ui/sonner";
import {
  AlertCircleIcon,
  CheckCircleIcon,
  ExternalLinkIcon,
  Loader2Icon,
} from "lucide-react";
import { useState } from "react";
import { GoogleImportModal } from "../../../../google/components/google-import-modal";
import {
  useDisconnectGoogle,
  useGoogleIntegrationStatus,
} from "../../../../google/hooks/use-google-integration";
import { IntegrationConnectionCard } from "../../components/integration-connection-card";
import { IntegrationDisconnectDialog } from "../../components/integration-disconnect-dialog";
import { SettingsPanelDataStateView } from "../../components/settings-panel-data-state-view";
import {
  classifySettingsPanelRead,
  SettingsPanelDataState,
} from "../../lib/settings-panel-data-state";

const CARD_TITLE = "Google Drive";
const CARD_DESCRIPTION = "Import Google Docs as PRD artifacts.";
const GOOGLE_DRIVE_SUBJECT = "your Google Drive connection details";

/**
 * The Google Drive connection (ISS-10316). Mounted on the Settings v2 Plugins
 * panel and, until ISS-10246 deletes it, on the legacy Integrations tab.
 */
export function GoogleDriveCard() {
  const [connecting, setConnecting] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [disconnectDialogOpen, setDisconnectDialogOpen] = useState(false);
  const statusQuery = useGoogleIntegrationStatus();
  const status = statusQuery.data;
  const disconnectMutation = useDisconnectGoogle({
    onError: () => toast.error("Failed to disconnect Google Drive"),
  });

  const handleDisconnect = async () => {
    try {
      await disconnectMutation.mutateAsync();
      toast.success("Google Drive disconnected successfully");
      setDisconnectDialogOpen(false);
    } catch {
      // Reported by the mutation's `onError` above.
    }
  };

  // A failed status read used to render "Not connected", which offers Connect
  // to an org that is already connected. It is its own screen instead.
  const dataState = classifySettingsPanelRead({
    error: statusQuery.error,
    hasData: status !== undefined,
    isEmpty: false,
    isPending: statusQuery.isPending,
  });

  if (dataState !== SettingsPanelDataState.Ready || status === undefined) {
    return (
      <IntegrationConnectionCard
        description={CARD_DESCRIPTION}
        title={CARD_TITLE}
        titleIcon={
          <ExternalLinkIcon className="h-5 w-5 text-muted-foreground" />
        }
      >
        <SettingsPanelDataStateView
          onRetry={() => {
            statusQuery.refetch();
          }}
          state={dataState}
          subject={GOOGLE_DRIVE_SUBJECT}
        />
      </IntegrationConnectionCard>
    );
  }

  return (
    <>
      <IntegrationConnectionCard
        actions={
          status.connected ? (
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
            // An anchor, not a fetch: this path starts the browser OAuth
            // redirect. Once clicked it looks and acts disabled, as the legacy button
            // did, so a second click cannot start a second redirect.
            <Button
              asChild
              className={
                connecting ? "pointer-events-none opacity-50" : undefined
              }
            >
              <a
                aria-busy={connecting}
                aria-disabled={connecting}
                href={GOOGLE_OAUTH_CONNECT_PATH}
                onClick={() => setConnecting(true)}
              >
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
              </a>
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
        description={CARD_DESCRIPTION}
        statusDescription={
          status.connected
            ? status.email
            : "Connect Google Drive to import documents"
        }
        statusIcon={
          status.connected ? (
            <CheckCircleIcon className="h-5 w-5 text-success" />
          ) : undefined
        }
        statusTitle={
          status.connected ? "Connected to Google Drive" : "Not connected"
        }
        title={CARD_TITLE}
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
