"use client";

import type {
  GitHubInstallationInfo,
  GitHubRepository,
} from "@repo/api/src/types/github";
import { Badge } from "@repo/design-system/components/ui/badge";
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
  GithubIcon,
  Loader2Icon,
  LockIcon,
} from "lucide-react";
import { useState } from "react";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import {
  useDisconnectGitHub,
  useGetGitHubConnectUrl,
  useGitHubIntegrationStatus,
  useGitHubRepositories,
} from "@/hooks/queries/use-github-integration";

function SuspendedState({
  installation,
  onDisconnect,
  isDisconnecting,
}: {
  installation: GitHubInstallationInfo;
  onDisconnect: () => void;
  isDisconnecting: boolean;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <AlertCircleIcon className="mt-0.5 h-5 w-5 text-amber-600" />
        <div className="flex-1 space-y-2">
          <div className="flex items-center gap-2">
            <p className="font-medium">Connected to GitHub</p>
            <Badge className="border-amber-600 bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-400">
              Suspended
            </Badge>
          </div>
          {installation.accountLogin ? (
            <p className="text-muted-foreground text-sm">
              @{installation.accountLogin}
            </p>
          ) : null}
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-800 text-sm dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-400">
            Installation suspended by GitHub admin. Ask your admin to unsuspend
            the app.
          </div>
        </div>
      </div>
      <div className="flex justify-end">
        <Button
          disabled={isDisconnecting}
          onClick={onDisconnect}
          variant="outline"
        >
          {isDisconnecting ? (
            <>
              <Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
              Disconnecting...
            </>
          ) : (
            "Disconnect"
          )}
        </Button>
      </div>
    </div>
  );
}

function RepositoryList({
  repositories,
  isLoading,
}: {
  repositories: GitHubRepository[] | undefined;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-sm">
        <Loader2Icon className="h-4 w-4 animate-spin" />
        Loading repositories...
      </div>
    );
  }

  if (!repositories || repositories.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">No repositories connected</p>
    );
  }

  return (
    <div className="space-y-2">
      <p className="font-medium text-sm">Connected Repositories</p>
      <ul className="space-y-1">
        {repositories.map((repo) => (
          <li className="flex items-center gap-2 text-sm" key={repo.id}>
            <GithubIcon className="h-4 w-4 text-muted-foreground" />
            <a
              className="text-foreground hover:underline"
              href={`https://github.com/${repo.fullName}`}
              rel="noopener noreferrer"
              target="_blank"
            >
              {repo.fullName}
            </a>
            {repo.private ? (
              <LockIcon className="h-3 w-3 text-muted-foreground" />
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ConnectedState({
  installation,
  repositories,
  repositoriesLoading,
  onDisconnect,
  isDisconnecting,
}: {
  installation: GitHubInstallationInfo;
  repositories: GitHubRepository[] | undefined;
  repositoriesLoading: boolean;
  onDisconnect: () => void;
  isDisconnecting: boolean;
}) {
  // Build GitHub settings URL based on account type
  const githubSettingsUrl =
    installation.accountType === "Organization"
      ? `https://github.com/organizations/${installation.accountLogin}/settings/installations/${installation.installationId}`
      : `https://github.com/settings/installations/${installation.installationId}`;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <CheckCircleIcon className="h-5 w-5 text-green-600" />
          <div>
            <p className="font-medium">Connected to GitHub</p>
            {installation.accountLogin ? (
              <p className="text-muted-foreground text-sm">
                @{installation.accountLogin}
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild size="sm" variant="ghost">
            <a
              href={githubSettingsUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              <ExternalLinkIcon className="mr-1 h-3 w-3" />
              Manage
            </a>
          </Button>
          <Button
            disabled={isDisconnecting}
            onClick={onDisconnect}
            size="sm"
            variant="outline"
          >
            {isDisconnecting ? (
              <>
                <Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
                Disconnecting...
              </>
            ) : (
              "Disconnect"
            )}
          </Button>
        </div>
      </div>
      <RepositoryList
        isLoading={repositoriesLoading}
        repositories={repositories}
      />
    </div>
  );
}

function DisconnectedState({
  onConnect,
  isConnecting,
}: {
  onConnect: () => void;
  isConnecting: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <p className="font-medium">Not connected</p>
        <p className="text-muted-foreground text-sm">
          Connect GitHub to enable repository integrations
        </p>
      </div>
      <Button disabled={isConnecting} onClick={onConnect}>
        {isConnecting ? (
          <>
            <Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
            Connecting...
          </>
        ) : (
          <>
            <ExternalLinkIcon className="mr-2 h-4 w-4" />
            Connect GitHub
          </>
        )}
      </Button>
    </div>
  );
}

export function GitHubIntegrationCard() {
  const [connecting, setConnecting] = useState(false);
  const [showDisconnectDialog, setShowDisconnectDialog] = useState(false);
  const {
    data: status,
    isError,
    isLoading: loading,
  } = useGitHubIntegrationStatus();
  const { data: repositories, isLoading: repositoriesLoading } =
    useGitHubRepositories({
      enabled: status?.connected === true,
    });
  const connectUrl = useGetGitHubConnectUrl();
  const disconnectGitHub = useDisconnectGitHub();

  const handleConnect = () => {
    setConnecting(true);
    // Redirect to app's OAuth route (Clerk auth works natively there)
    window.location.href = connectUrl;
  };

  const handleDisconnect = async () => {
    try {
      await disconnectGitHub.mutateAsync();
      toast.success("GitHub disconnected successfully");
    } catch {
      toast.error("Failed to disconnect GitHub");
    }
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <GithubIcon className="h-5 w-5" />
            GitHub
          </CardTitle>
          <CardDescription>
            Connect your GitHub account to enable repository integrations
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

  if (isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <GithubIcon className="h-5 w-5" />
            GitHub
          </CardTitle>
          <CardDescription>
            Connect your GitHub account to enable repository integrations
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-3">
            <AlertCircleIcon className="mt-0.5 h-5 w-5 text-red-600" />
            <div className="flex-1">
              <p className="font-medium text-red-900 dark:text-red-300">
                Failed to load GitHub integration status
              </p>
              <p className="text-muted-foreground text-sm">
                There was an error loading your GitHub connection status. Please
                try refreshing the page.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const content = (() => {
    if (!status?.connected) {
      return (
        <DisconnectedState
          isConnecting={connecting}
          onConnect={handleConnect}
        />
      );
    }

    if (status.installation.status === "SUSPENDED") {
      return (
        <SuspendedState
          installation={status.installation}
          isDisconnecting={disconnectGitHub.isPending}
          onDisconnect={() => setShowDisconnectDialog(true)}
        />
      );
    }

    return (
      <ConnectedState
        installation={status.installation}
        isDisconnecting={disconnectGitHub.isPending}
        onDisconnect={() => setShowDisconnectDialog(true)}
        repositories={repositories}
        repositoriesLoading={repositoriesLoading}
      />
    );
  })();

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <GithubIcon className="h-5 w-5" />
            GitHub
          </CardTitle>
          <CardDescription>
            Connect your GitHub account to enable repository integrations
          </CardDescription>
        </CardHeader>
        <CardContent>{content}</CardContent>
      </Card>

      <ConfirmationDialog
        confirmLabel="Disconnect"
        description="This will uninstall the GitHub App from your account and remove the connection. You can reconnect at any time."
        isPending={disconnectGitHub.isPending}
        onConfirm={handleDisconnect}
        onOpenChange={setShowDisconnectDialog}
        open={showDisconnectDialog}
        title="Disconnect GitHub"
        variant="destructive"
      />
    </>
  );
}
