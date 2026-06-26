"use client";

import type {
  GitHubInstallationInfo,
  GitHubRepository,
} from "@repo/api/src/types/github";
import { GitHubInstallationStatus } from "@repo/api/src/types/github";
import {
  useConfirmDifferentAccountReset,
  useDisconnectGitHub,
  useGitHubIntegrationStatus,
  useGitHubRepositories,
} from "@repo/app/github/hooks/use-github-integration";
import { ConfirmationDialog } from "@repo/app/shared/components/confirmation-dialog";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { toast } from "@repo/design-system/components/ui/sonner";
import type { ReadonlySearchParams } from "@repo/navigation/navigation-adapter";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import {
  AlertCircleIcon,
  CheckCircleIcon,
  ExternalLinkIcon,
  GithubIcon,
  Loader2Icon,
  LockIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useState } from "react";
import { getGitHubConnectUrl } from "@/lib/integration-connect-urls";
import { IntegrationConnectionCard } from "./integration-connection-card";
import { PublicRepositoriesSection } from "./public-repositories-section";

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
        <AlertCircleIcon className="mt-0.5 h-5 w-5 text-warning" />
        <div className="flex-1 space-y-2">
          <div className="flex items-center gap-2">
            <p className="font-medium">Connected to GitHub</p>
            <Badge className="border-warning/30 bg-warning/14 text-warning-foreground">
              Suspended
            </Badge>
          </div>
          {installation.accountLogin ? (
            <p className="text-muted-foreground text-sm">
              @{installation.accountLogin}
            </p>
          ) : null}
          <div className="rounded-md border border-warning/30 bg-warning/12 p-3 text-sm text-warning-foreground">
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
              <Loader2Icon className="h-4 w-4 animate-spin" />
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
          <CheckCircleIcon className="h-5 w-5 text-success" />
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
              <ExternalLinkIcon className="h-3 w-3" />
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
                <Loader2Icon className="h-4 w-4 animate-spin" />
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
  onInstall,
  isConnecting,
}: {
  onConnect: () => void;
  onInstall: () => void;
  isConnecting: boolean;
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="font-medium">Not connected</p>
        <p className="text-muted-foreground text-sm">
          Connect GitHub to enable repository integrations
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
        <Button disabled={isConnecting} onClick={onInstall} variant="outline">
          <ExternalLinkIcon className="h-4 w-4" />
          Install App
        </Button>
        <Button disabled={isConnecting} onClick={onConnect}>
          {isConnecting ? (
            <>
              <Loader2Icon className="h-4 w-4 animate-spin" />
              Connecting...
            </>
          ) : (
            <>
              <ExternalLinkIcon className="h-4 w-4" />
              Connect GitHub
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

/**
 * PLN-634: the OAuth callback redirects here with these query params when an
 * org admin reconnects to a different GitHub account than was previously
 * linked. The dialog renders inline so the admin can confirm the destructive
 * reset before it runs.
 */
type RequiresConfirmationParams = {
  priorAccountId: string;
  priorAccountLogin: string;
  newAccountId: string;
  newAccountLogin: string;
  newInstallationId: string;
};

function readRequiresConfirmationParams(
  searchParams: ReadonlySearchParams | null
): RequiresConfirmationParams | null {
  if (searchParams?.get("github") !== "requires_confirmation") {
    return null;
  }
  const priorAccountId = searchParams.get("priorAccountId");
  const priorAccountLogin = searchParams.get("priorAccountLogin");
  const newAccountId = searchParams.get("newAccountId");
  const newAccountLogin = searchParams.get("newAccountLogin");
  const newInstallationId = searchParams.get("newInstallationId");
  if (
    !(
      priorAccountId &&
      priorAccountLogin &&
      newAccountId &&
      newAccountLogin &&
      newInstallationId
    )
  ) {
    return null;
  }
  return {
    priorAccountId,
    priorAccountLogin,
    newAccountId,
    newAccountLogin,
    newInstallationId,
  };
}

export function GitHubIntegrationCard() {
  const [connecting, setConnecting] = useState(false);
  const [showDisconnectDialog, setShowDisconnectDialog] = useState(false);
  const navigation = useNavigation();
  const searchParams = useSearchParamsValue();
  const confirmReset = useConfirmDifferentAccountReset();
  const requiresConfirmation = readRequiresConfirmationParams(searchParams);
  const publicReposEnabled = useFeatureFlagEnabled("public-github-repos");
  const {
    data: status,
    isError,
    isLoading: loading,
    isRefetching,
    refetch,
  } = useGitHubIntegrationStatus();
  const { data: repositories, isLoading: repositoriesLoading } =
    useGitHubRepositories();
  const authorizeUrl = getGitHubConnectUrl("authorize");
  const installUrl = getGitHubConnectUrl("install");
  const disconnectGitHub = useDisconnectGitHub();

  const handleConnect = () => {
    setConnecting(true);
    // Redirect to app's OAuth route (Clerk auth works natively there)
    globalThis.location.assign(authorizeUrl);
  };

  const handleInstall = () => {
    setConnecting(true);
    globalThis.location.assign(installUrl);
  };

  const handleDisconnect = async () => {
    try {
      await disconnectGitHub.mutateAsync();
      toast.success("GitHub disconnected successfully");
    } catch {
      toast.error("Failed to disconnect GitHub");
    }
  };

  const handleConfirmReset = async () => {
    if (!requiresConfirmation) {
      return;
    }
    // mutateAsync (not mutate) so the ConfirmationDialog's `await onConfirm()`
    // actually blocks until the mutation settles. On failure the rejection
    // propagates up, the dialog skips `onOpenChange(false)`, and the admin can
    // retry without redoing the full OAuth flow. The global query-client
    // onError handler surfaces the failure toast.
    await confirmReset.mutateAsync();
    toast.success("GitHub connected to the new account");
    navigation.replace("/settings");
  };

  const handleCancelReset = () => {
    navigation.replace("/settings");
  };

  if (loading) {
    return (
      <IntegrationConnectionCard
        description="Connect your GitHub account to enable repository integrations"
        isLoading
        title="GitHub"
        titleIcon={<GithubIcon className="h-5 w-5" />}
      />
    );
  }

  if (isError) {
    return (
      <IntegrationConnectionCard
        description="Connect your GitHub account to enable repository integrations"
        title="GitHub"
        titleIcon={<GithubIcon className="h-5 w-5" />}
      >
        <div className="flex items-start gap-3">
          <AlertCircleIcon className="mt-0.5 h-5 w-5 text-destructive" />
          <div className="flex-1 space-y-4">
            <p className="font-medium text-destructive">
              Failed to load GitHub integration status
            </p>
            <p className="text-muted-foreground text-sm">
              There was an error loading your GitHub connection status. Please
              try refreshing the page.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                disabled={isRefetching}
                onClick={() => {
                  refetch();
                }}
                size="sm"
                variant="outline"
              >
                {isRefetching ? (
                  <Loader2Icon className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCwIcon className="h-4 w-4" />
                )}
                Retry
              </Button>
              <Button
                disabled={connecting}
                onClick={handleInstall}
                size="sm"
                variant="outline"
              >
                <ExternalLinkIcon className="h-4 w-4" />
                Install App
              </Button>
              <Button disabled={connecting} onClick={handleConnect} size="sm">
                <ExternalLinkIcon className="h-4 w-4" />
                Connect GitHub
              </Button>
            </div>
          </div>
        </div>
      </IntegrationConnectionCard>
    );
  }

  const content = (() => {
    if (!status?.connected) {
      return (
        <DisconnectedState
          isConnecting={connecting}
          onConnect={handleConnect}
          onInstall={handleInstall}
        />
      );
    }

    if (status.installation.status === GitHubInstallationStatus.Suspended) {
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
      <IntegrationConnectionCard
        description="Connect your GitHub account to enable repository integrations"
        title="GitHub"
        titleIcon={<GithubIcon className="h-5 w-5" />}
      >
        {content}
        {publicReposEnabled && (
          <div className="mt-6 border-t pt-6">
            <PublicRepositoriesSection />
          </div>
        )}
      </IntegrationConnectionCard>

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

      {requiresConfirmation ? (
        <ConfirmationDialog
          confirmLabel="Continue and reset"
          description={`You previously connected GitHub @${requiresConfirmation.priorAccountLogin} (account id ${requiresConfirmation.priorAccountId}). You're now connecting @${requiresConfirmation.newAccountLogin} (account id ${requiresConfirmation.newAccountId}). Continuing will reset all team repository selections and project repository settings for this organization. Branch and pull request history will be preserved.`}
          isPending={confirmReset.isPending}
          onConfirm={handleConfirmReset}
          onOpenChange={(open) => {
            if (!open) {
              handleCancelReset();
            }
          }}
          open={true}
          title="Confirm GitHub account switch"
          variant="destructive"
        />
      ) : null}
    </>
  );
}
