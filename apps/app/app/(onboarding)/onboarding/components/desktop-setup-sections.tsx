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
import { DesktopSetupStatus } from "./use-desktop-setup-readiness";

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
  readonly onSelect: () => void;
  readonly onSandboxBaseDirectoryChange: (value: string) => void;
  readonly open: boolean;
};

export function AutomatedProvisioningCard({
  automatedProvisioningEnabled,
  capabilityLoading,
  commandCopied,
  createProvisioningPending,
  downloadUrl,
  isReleaseLoading,
  onCopyCommand,
  onCreateCommand,
  onSelect,
  onSandboxBaseDirectoryChange,
  open,
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
    <div className="rounded-lg border border-primary/30 bg-primary/5 p-5 shadow-sm">
      <button
        aria-expanded={open}
        className="block w-full cursor-pointer space-y-1 text-left"
        onClick={onSelect}
        type="button"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-base">Automated setup</span>
          <span className="rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary text-xs">
            Recommended
          </span>
        </div>
        <p className="text-muted-foreground text-sm">
          Generate a command that installs or updates Desktop, provisions your
          account, and opens the app with the right configuration.
        </p>
      </button>
      {open ? (
        <div className="mt-4 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="desktop-sandbox-directory">
              Workspace directory
            </Label>
            <Input
              id="desktop-sandbox-directory"
              onChange={(event) =>
                onSandboxBaseDirectoryChange(event.target.value)
              }
              value={sandboxBaseDirectory}
            />
            <p className="text-muted-foreground text-xs">
              ClosedLoop Desktop will look for your cloned repositories in this
              directory, using the repository name exactly. Desktop commands can
              only run inside this directory.
            </p>
          </div>
          <Button
            className="w-full sm:w-auto"
            disabled={
              createProvisioningPending || isReleaseLoading || !downloadUrl
            }
            onClick={onCreateCommand}
            size="default"
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
              <p className="text-muted-foreground text-xs">
                Copy this command, paste it into macOS Terminal, and press
                Return. Keep this page open; it will continue automatically
                after Desktop completes setup.
              </p>
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
      ) : null}
    </div>
  );
}

type ManualSetupSectionProps = {
  readonly copied: boolean;
  readonly downloadUrl: string | null;
  readonly electronDetected: boolean;
  readonly generatedKey: string | null;
  readonly isDetecting: boolean;
  readonly isElectronOutdated: boolean;
  readonly isPending: boolean;
  readonly isReleaseLoading: boolean;
  readonly latestVersion: string | null;
  readonly runningVersion: string | null;
  readonly onCopy: () => void;
  readonly onGenerateKey: () => void;
  readonly onSelect: () => void;
  readonly open: boolean;
};

export function ManualSetupSection({
  copied,
  downloadUrl,
  electronDetected,
  generatedKey,
  isDetecting,
  isElectronOutdated,
  isPending,
  isReleaseLoading,
  latestVersion,
  onCopy,
  onGenerateKey,
  onSelect,
  open,
  runningVersion,
}: ManualSetupSectionProps) {
  return (
    <div className="rounded-lg border p-4">
      <button
        aria-expanded={open}
        className="block w-full cursor-pointer text-left"
        onClick={onSelect}
        type="button"
      >
        <span className="font-medium text-sm">Manual setup</span>
      </button>
      {open ? (
        <div className="mt-3 space-y-4">
          <p className="text-muted-foreground text-xs">
            Use this fallback if you cannot use automated setup. Download
            Desktop directly, then connect it with an API key.
          </p>

          <div className="rounded-lg border p-4">
            <DownloadAction
              downloadUrl={downloadUrl}
              electronDetected={electronDetected}
              isDetecting={isDetecting}
              isElectronOutdated={isElectronOutdated}
              isReleaseLoading={isReleaseLoading}
              latestVersion={latestVersion}
              runningVersion={runningVersion}
            />
          </div>

          {electronDetected ? (
            <div className="space-y-3 rounded-lg border p-4">
              <div className="flex items-center gap-2">
                <KeyIcon className="h-4 w-4 text-muted-foreground" />
                <p className="font-medium text-sm">Connect with an API Key</p>
              </div>
              <p className="text-muted-foreground text-xs">
                The key will have full read, write, and delete access.
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
                    <Button onClick={onCopy} size="icon" variant="outline">
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
                    disabled={isPending}
                    onClick={onGenerateKey}
                    size="sm"
                    variant="outline"
                  >
                    {isPending ? (
                      <Loader2Icon className="h-4 w-4 animate-spin" />
                    ) : (
                      <KeyIcon className="h-4 w-4" />
                    )}
                    Generate API Key
                  </Button>
                </div>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function DesktopStatusPanel({
  electronDetected,
  isDetecting,
  isElectronOutdated,
  latestVersion,
  runningVersion,
  setupStatus,
  versionLabel,
}: {
  readonly electronDetected: boolean;
  readonly isDetecting: boolean;
  readonly isElectronOutdated: boolean;
  readonly latestVersion: string | null;
  readonly runningVersion: string | null;
  readonly setupStatus: DesktopSetupStatus;
  readonly versionLabel: string;
}) {
  return (
    <div className="rounded-lg border p-4">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted">
          <MonitorIcon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-medium text-sm">ClosedLoop Desktop</p>
          <p className="text-muted-foreground text-xs">{versionLabel}</p>
        </div>
        {electronDetected ? (
          <div className="flex flex-wrap items-center justify-end gap-2 text-sm">
            {isElectronOutdated ? (
              <div className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                <AlertTriangleIcon className="h-4 w-4" />
                Update available
              </div>
            ) : null}
            <div className="flex items-center gap-1 text-green-600 dark:text-green-400">
              <CheckCircleIcon className="h-4 w-4" />
              Running
            </div>
          </div>
        ) : null}
      </div>
      <DesktopStatusMessage
        electronDetected={electronDetected}
        isDetecting={isDetecting}
        latestVersion={latestVersion}
        runningVersion={runningVersion}
        setupStatus={setupStatus}
      />
    </div>
  );
}

function DesktopStatusMessage({
  electronDetected,
  isDetecting,
  latestVersion,
  runningVersion,
  setupStatus,
}: {
  readonly electronDetected: boolean;
  readonly isDetecting: boolean;
  readonly latestVersion: string | null;
  readonly runningVersion: string | null;
  readonly setupStatus: DesktopSetupStatus;
}) {
  if (electronDetected && setupStatus === DesktopSetupStatus.Complete) {
    return (
      <div className="mt-4 flex items-center gap-2 rounded-md bg-green-500/10 px-3 py-2 text-green-700 text-sm dark:text-green-300">
        <CheckCircleIcon className="h-4 w-4" />
        <span>ClosedLoop Desktop setup is complete.</span>
      </div>
    );
  }

  if (electronDetected) {
    if (setupStatus === DesktopSetupStatus.Unknown) {
      return (
        <div className="mt-4 flex items-start gap-2 rounded-md bg-muted/50 px-3 py-2 text-muted-foreground text-sm">
          <CheckCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-green-600 dark:text-green-400" />
          <span>
            ClosedLoop Desktop is running. This version does not report setup
            status, so continue after you confirm Desktop is connected to your
            account.
          </span>
        </div>
      );
    }

    return (
      <div className="mt-4 flex items-start gap-2 rounded-md bg-muted/50 px-3 py-2 text-muted-foreground text-sm">
        <AlertTriangleIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <span>
          ClosedLoop Desktop is running, but setup is not complete yet. Finish
          the prompt in the Desktop app to continue.
        </span>
      </div>
    );
  }

  if (isDetecting) {
    return (
      <div className="mt-4 flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2 text-muted-foreground text-sm">
        <Loader2Icon className="h-4 w-4 animate-spin" />
        <span>Waiting for ClosedLoop Desktop to start&hellip;</span>
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-md bg-muted/50 px-3 py-2 text-muted-foreground text-sm">
      {latestVersion ? (
        <span>
          ClosedLoop Desktop version {latestVersion} is available. Automated
          setup will install it for you.
        </span>
      ) : (
        <span>ClosedLoop Desktop has not been detected yet.</span>
      )}
      {runningVersion ? (
        <span className="sr-only">{runningVersion}</span>
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
    if (isElectronOutdated && runningVersion && latestVersion) {
      return (
        <div className="space-y-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-950 text-sm dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100">
          <div className="flex items-start gap-2">
            <AlertTriangleIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300" />
            <span>
              ClosedLoop Desktop version {runningVersion} is running. Version{" "}
              {latestVersion} is available.
            </span>
          </div>
          <Button
            asChild
            className="w-full border-amber-300 bg-background text-foreground hover:bg-amber-100 hover:text-foreground dark:border-amber-500/40 dark:bg-background dark:hover:bg-amber-500/10"
            size="sm"
            variant="outline"
          >
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
      <p className="text-muted-foreground text-xs">
        After installing, launch the app and this page will automatically detect
        it.
      </p>
    </div>
  );
}
