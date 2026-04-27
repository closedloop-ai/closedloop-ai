"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { cn } from "@repo/design-system/lib/utils";
import {
  AlertTriangleIcon,
  CheckCircleIcon,
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  KeyIcon,
  Loader2Icon,
  MonitorIcon,
  TerminalIcon,
} from "lucide-react";
import { useState } from "react";
import {
  useCreateDesktopProvisioningAttempt,
  useDesktopProvisioningCapability,
} from "@/hooks/queries/use-desktop-provisioning";
import { useLatestElectronRelease } from "@/hooks/queries/use-electron-release";
import { useCreatePlatformApiKey } from "@/hooks/queries/use-platform-api-keys";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { buildDesktopOnboardingCommand } from "@/lib/desktop-managed-onboarding";
import { getClientDesktopProvisioningPlatform } from "@/lib/desktop-provisioning-platform";
import { useElectronDetection } from "@/lib/engineer/electron-detection";
import { isUpdateAvailable } from "@/lib/version-utils";

type DownloadElectronAppStepProps = {
  readonly onNext: () => void;
};

const FIRST_PRINTABLE_JSON_CHARACTER_CODE = 0x20;

export function DownloadElectronAppStep({
  onNext,
}: DownloadElectronAppStepProps) {
  const { data: release, isLoading: isReleaseLoading } =
    useLatestElectronRelease();
  const provisioningCapability = useDesktopProvisioningCapability();
  const createProvisioningAttempt = useCreateDesktopProvisioningAttempt();
  const electron = useElectronDetection();
  const createApiKey = useCreatePlatformApiKey();

  const [generatedKey, setGeneratedKey] = useState<string | null>(null);
  const [provisioningCommand, setProvisioningCommand] = useState<string | null>(
    null
  );
  const [provisioningError, setProvisioningError] = useState<string | null>(
    null
  );
  const [sandboxBaseDirectory, setSandboxBaseDirectory] = useState("~/Source");
  const [copied, copyGeneratedKey] = useCopyToClipboard();
  const [commandCopied, copyProvisioningCommand] = useCopyToClipboard();

  const downloadUrl = release?.downloadUrl ?? null;
  const latestVersion = release?.version ?? null;
  const runningVersion = electron.detected ? electron.version : null;
  let versionLabel = "Latest version";
  if (electron.detected) {
    versionLabel = runningVersion
      ? `Version ${runningVersion}`
      : "Version unavailable";
  } else if (latestVersion) {
    versionLabel = `Version ${latestVersion}`;
  }
  const isElectronOutdated =
    electron.detected &&
    runningVersion !== null &&
    latestVersion !== null &&
    isUpdateAvailable(runningVersion, latestVersion);

  const automatedProvisioningEnabled =
    provisioningCapability.data?.automatedManagedProvisioningEnabled === true;
  const desktopProvisioningPlatform = getClientDesktopProvisioningPlatform();
  const canContinue =
    electron.detected &&
    (generatedKey !== null || provisioningCommand !== null);

  const handleGenerateKey = () => {
    createApiKey.mutate(
      { name: "ClosedLoop Desktop" },
      {
        onSuccess: (data) => {
          setGeneratedKey(data.plaintext);
        },
      }
    );
  };

  const handleCopy = async () => {
    await copyGeneratedKey(generatedKey);
  };

  const handleCreateProvisioningCommand = () => {
    if (!(downloadUrl && automatedProvisioningEnabled)) {
      return;
    }
    if (hasJsonControlCharacter(sandboxBaseDirectory)) {
      setProvisioningCommand(null);
      setProvisioningError(
        "Sandbox directory cannot contain control characters."
      );
      return;
    }
    const webAppOrigin = globalThis.location.origin;
    createProvisioningAttempt.mutate(
      { platform: desktopProvisioningPlatform, webAppOrigin },
      {
        onSuccess: (attempt) => {
          setProvisioningError(null);
          setProvisioningCommand(
            buildDesktopOnboardingCommand({
              onboardingAttemptId: attempt.onboardingAttemptId,
              webAppOrigin,
              desktopDownloadUrl: downloadUrl,
              installerScriptUrl: `${webAppOrigin}/api/desktop/install.sh`,
              sandboxBaseDirectory,
            })
          );
        },
        onError: (error) => {
          setProvisioningCommand(null);
          setProvisioningError(
            error instanceof Error
              ? error.message
              : "Failed to start automated onboarding."
          );
        },
      }
    );
  };

  const handleCopyCommand = async () => {
    await copyProvisioningCommand(provisioningCommand);
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-semibold text-lg">Download ClosedLoop Desktop</h2>
        <p className="text-muted-foreground text-sm">
          The ClosedLoop desktop app enables local AI-powered engineering
          workflows directly on your machine. Download and install it to get
          started.
        </p>
      </div>

      <div className="rounded-lg border p-4">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted">
            <MonitorIcon className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-medium text-sm">ClosedLoop Desktop</p>
            <p className="text-muted-foreground text-xs">{versionLabel}</p>
          </div>
          {electron.detected && (
            <div className="flex flex-wrap items-center justify-end gap-2 text-sm">
              {isElectronOutdated ? (
                <div className="flex items-center gap-1 text-amber-600">
                  <AlertTriangleIcon className="h-4 w-4" />
                  Update available
                </div>
              ) : null}
              <div className="flex items-center gap-1 text-green-500">
                <CheckCircleIcon className="h-4 w-4" />
                Running
              </div>
            </div>
          )}
        </div>

        <DownloadAction
          downloadUrl={downloadUrl}
          electronDetected={electron.detected}
          isDetecting={electron.loading}
          isElectronOutdated={isElectronOutdated}
          isReleaseLoading={isReleaseLoading}
          latestVersion={latestVersion}
          runningVersion={runningVersion}
        />
      </div>

      <AutomatedProvisioningCard
        automatedProvisioningEnabled={automatedProvisioningEnabled}
        capabilityLoading={provisioningCapability.isLoading}
        commandCopied={commandCopied}
        createProvisioningPending={createProvisioningAttempt.isPending}
        downloadUrl={downloadUrl}
        isReleaseLoading={isReleaseLoading}
        onCopyCommand={handleCopyCommand}
        onCreateCommand={handleCreateProvisioningCommand}
        onSandboxBaseDirectoryChange={setSandboxBaseDirectory}
        provisioningCommand={provisioningCommand}
        provisioningError={provisioningError}
        sandboxBaseDirectory={sandboxBaseDirectory}
      />

      {electron.detected && (
        <div className="space-y-3 rounded-lg border p-4">
          <div className="flex items-center gap-2">
            <KeyIcon className="h-4 w-4 text-muted-foreground" />
            <p className="font-medium text-sm">Connect with an API Key</p>
          </div>
          <p className="text-muted-foreground text-xs">
            Generate an API key to authenticate ClosedLoop Desktop with your
            account. The key will have full read, write, and delete access.
          </p>

          {generatedKey ? (
            <div className="space-y-2">
              <Label htmlFor="generated-api-key">Your API Key</Label>
              <div className="flex gap-2">
                <Input
                  className="font-mono text-xs"
                  id="generated-api-key"
                  readOnly
                  value={generatedKey}
                />
                <Button onClick={handleCopy} size="icon" variant="outline">
                  {copied ? (
                    <CheckIcon className="h-4 w-4" />
                  ) : (
                    <CopyIcon className="h-4 w-4" />
                  )}
                </Button>
              </div>
              <p className="text-muted-foreground text-xs">
                Copy this key and paste it into ClosedLoop Desktop settings.
                This key will not be shown again.
              </p>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Button
                disabled={createApiKey.isPending}
                onClick={handleGenerateKey}
                size="sm"
                variant="outline"
              >
                {createApiKey.isPending ? (
                  <Loader2Icon className="h-4 w-4 animate-spin" />
                ) : (
                  <KeyIcon className="h-4 w-4" />
                )}
                Generate API Key
              </Button>
            </div>
          )}
        </div>
      )}

      <p className="text-muted-foreground text-xs">
        Requires macOS 12 or later. Apple Silicon and Intel supported.
      </p>

      <div className="flex items-center justify-between">
        <Button
          className="text-muted-foreground"
          onClick={onNext}
          size="sm"
          variant="ghost"
        >
          Skip for now
        </Button>
        <Button disabled={!canContinue} onClick={onNext}>
          Continue
        </Button>
      </div>
    </div>
  );
}

function hasJsonControlCharacter(value: string): boolean {
  for (const character of value) {
    if (character.charCodeAt(0) < FIRST_PRINTABLE_JSON_CHARACTER_CODE) {
      return true;
    }
  }
  return false;
}

type AutomatedProvisioningCardProps = {
  readonly automatedProvisioningEnabled: boolean;
  readonly capabilityLoading: boolean;
  readonly commandCopied: boolean;
  readonly createProvisioningPending: boolean;
  readonly downloadUrl: string | null;
  readonly isReleaseLoading: boolean;
  readonly provisioningCommand: string | null;
  readonly provisioningError: string | null;
  readonly sandboxBaseDirectory: string;
  readonly onCopyCommand: () => void;
  readonly onCreateCommand: () => void;
  readonly onSandboxBaseDirectoryChange: (value: string) => void;
};

function AutomatedProvisioningCard({
  automatedProvisioningEnabled,
  capabilityLoading,
  commandCopied,
  createProvisioningPending,
  downloadUrl,
  isReleaseLoading,
  onCopyCommand,
  onCreateCommand,
  onSandboxBaseDirectoryChange,
  provisioningCommand,
  provisioningError,
  sandboxBaseDirectory,
}: AutomatedProvisioningCardProps) {
  if (!automatedProvisioningEnabled) {
    if (capabilityLoading) {
      return (
        <div className="flex items-center gap-2 rounded-lg border p-4 text-muted-foreground text-sm">
          <Loader2Icon className="h-4 w-4 animate-spin" />
          Checking automated setup availability
        </div>
      );
    }

    return (
      <div className="rounded-lg border p-4 text-muted-foreground text-sm">
        Automated setup is unavailable. Use manual API key setup.
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex items-center gap-2">
        <TerminalIcon className="h-4 w-4 text-muted-foreground" />
        <p className="font-medium text-sm">Automated setup</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="desktop-sandbox-directory">Sandbox directory</Label>
        <Input
          id="desktop-sandbox-directory"
          onChange={(event) => onSandboxBaseDirectoryChange(event.target.value)}
          value={sandboxBaseDirectory}
        />
      </div>
      <Button
        disabled={createProvisioningPending || isReleaseLoading || !downloadUrl}
        onClick={onCreateCommand}
        size="sm"
        variant="outline"
      >
        {createProvisioningPending ? (
          <Loader2Icon className="h-4 w-4 animate-spin" />
        ) : (
          <TerminalIcon className="h-4 w-4" />
        )}
        Generate install command
      </Button>
      {provisioningError ? (
        <p className="text-destructive text-xs">{provisioningError}</p>
      ) : null}
      {provisioningCommand ? (
        <div className="space-y-2">
          <Label htmlFor="desktop-install-command">Install command</Label>
          <div className="flex gap-2">
            <Textarea
              className="min-h-24 font-mono text-xs"
              id="desktop-install-command"
              readOnly
              value={provisioningCommand}
            />
            <Button onClick={onCopyCommand} size="icon" variant="outline">
              {commandCopied ? (
                <CheckIcon className="h-4 w-4" />
              ) : (
                <CopyIcon className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function DownloadAction({
  downloadUrl,
  electronDetected,
  isElectronOutdated,
  isDetecting,
  isReleaseLoading,
  latestVersion,
  runningVersion,
}: {
  readonly downloadUrl: string | null;
  readonly electronDetected: boolean;
  readonly isElectronOutdated: boolean;
  readonly isDetecting: boolean;
  readonly isReleaseLoading: boolean;
  readonly latestVersion: string | null;
  readonly runningVersion: string | null;
}) {
  if (electronDetected) {
    if (isElectronOutdated) {
      return (
        <div className="space-y-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900 text-sm">
          <div className="flex items-start gap-2">
            <AlertTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              ClosedLoop Desktop version {runningVersion} is running. Version{" "}
              {latestVersion} is available.
            </span>
          </div>
          <Button asChild className="w-full" size="sm" variant="outline">
            <a
              aria-disabled={!downloadUrl}
              className={cn(!downloadUrl && "pointer-events-none opacity-50")}
              download
              href={downloadUrl ?? "#"}
              onClick={downloadUrl ? undefined : (e) => e.preventDefault()}
              rel="noopener noreferrer"
              target="_blank"
            >
              <DownloadIcon className="h-4 w-4" />
              Download latest version
            </a>
          </Button>
        </div>
      );
    }

    return (
      <div className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2 text-sm">
        <CheckCircleIcon className="h-4 w-4 text-green-500" />
        <span>ClosedLoop Desktop detected and running</span>
      </div>
    );
  }

  if (isDetecting) {
    return (
      <div className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2 text-muted-foreground text-sm">
        <Loader2Icon className="h-4 w-4 animate-spin" />
        <span>Waiting for ClosedLoop Desktop to start&hellip;</span>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Button asChild className="w-full">
        <a
          aria-disabled={isReleaseLoading || !downloadUrl}
          className={cn(
            (isReleaseLoading || !downloadUrl) &&
              "pointer-events-none opacity-50"
          )}
          download
          href={downloadUrl ?? "#"}
          onClick={
            isReleaseLoading || !downloadUrl
              ? (e) => e.preventDefault()
              : undefined
          }
          rel="noopener noreferrer"
          target="_blank"
        >
          {isReleaseLoading ? (
            <Loader2Icon className="h-4 w-4 animate-spin" />
          ) : (
            <DownloadIcon className="h-4 w-4" />
          )}
          Download for macOS (.dmg)
        </a>
      </Button>
      <p className="text-center text-muted-foreground text-xs">
        After installing, launch the app and this page will automatically detect
        it.
      </p>
    </div>
  );
}
