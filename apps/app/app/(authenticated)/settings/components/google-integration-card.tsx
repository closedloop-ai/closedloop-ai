"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@repo/design-system/components/ui/alert-dialog";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { toast } from "@repo/design-system/components/ui/sonner";
import {
  AlertCircleIcon,
  CheckCircleIcon,
  ExternalLinkIcon,
  Loader2Icon,
} from "lucide-react";
import { useState } from "react";
import {
  getGoogleOAuthUrl,
  useDisconnectGoogle,
  useGoogleIntegrationStatus,
} from "@/hooks/queries/use-google-integration";
import { GoogleImportModal } from "./google-import-modal";

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
      <Card>
        <CardHeader>
          <CardTitle>Google Drive</CardTitle>
          <CardDescription>
            Import Google Docs as PRD artifacts.
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
    <>
      <Card>
        <CardHeader>
          <CardTitle>Google Drive</CardTitle>
          <CardDescription>
            Import Google Docs as PRD artifacts.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {/* Scope disclosure warning */}
            <div className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 dark:bg-amber-950/20">
              <AlertCircleIcon className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-500" />
              <p className="text-amber-900 text-sm dark:text-amber-200">
                This integration will have read access to all files in your
                Google Drive.
              </p>
            </div>

            {/* Connection status and actions */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {status?.connected ? (
                  <>
                    <CheckCircleIcon className="h-5 w-5 text-green-600" />
                    <div>
                      <p className="font-medium">Connected to Google Drive</p>
                      {status.email ? (
                        <p className="text-muted-foreground text-sm">
                          {status.email}
                        </p>
                      ) : null}
                    </div>
                  </>
                ) : (
                  <div>
                    <p className="font-medium">Not connected</p>
                    <p className="text-muted-foreground text-sm">
                      Connect Google Drive to import documents
                    </p>
                  </div>
                )}
              </div>

              <div className="flex gap-2">
                {status?.connected ? (
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
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <GoogleImportModal
        onOpenChange={setImportModalOpen}
        open={importModalOpen}
      />

      <AlertDialog
        onOpenChange={setDisconnectDialogOpen}
        open={disconnectDialogOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect Google Drive</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to disconnect Google Drive? You will need to
              reconnect to import documents.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={disconnectMutation.isPending}
              onClick={handleDisconnect}
            >
              {disconnectMutation.isPending ? "Disconnecting..." : "Disconnect"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
