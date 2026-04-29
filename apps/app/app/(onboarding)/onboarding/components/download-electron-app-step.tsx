"use client";

import { DesktopProvisioningPlatform } from "@repo/api/src/types/electron";
import { Button } from "@repo/design-system/components/ui/button";
import { useEffect, useRef, useState } from "react";
import {
  useCreateDesktopProvisioningAttempt,
  useDesktopProvisioningCapability,
} from "@/hooks/queries/use-desktop-provisioning";
import { useLatestElectronRelease } from "@/hooks/queries/use-electron-release";
import { useCreatePlatformApiKey } from "@/hooks/queries/use-platform-api-keys";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { buildDesktopOnboardingCommand } from "@/lib/desktop-managed-onboarding";
import { getClientDesktopProvisioningPlatform } from "@/lib/desktop-provisioning-platform";
import { isUpdateAvailable } from "@/lib/version-utils";
import {
  AutomatedProvisioningCard,
  DesktopStatusPanel,
  ManualSetupSection,
} from "./desktop-setup-sections";
import { useDesktopSetupReadiness } from "./use-desktop-setup-readiness";

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
  const createApiKey = useCreatePlatformApiKey();
  const desktopProvisioningPlatform = getClientDesktopProvisioningPlatform();
  const defaultSetupMode =
    desktopProvisioningPlatform === DesktopProvisioningPlatform.Darwin
      ? "automated"
      : "manual";

  const [generatedKey, setGeneratedKey] = useState<string | null>(null);
  const [provisioningCommand, setProvisioningCommand] = useState<string | null>(
    null
  );
  const [provisioningAttemptId, setProvisioningAttemptId] = useState<
    string | null
  >(null);
  const [provisioningError, setProvisioningError] = useState<string | null>(
    null
  );
  const [sandboxBaseDirectory, setSandboxBaseDirectory] = useState("~/Source");
  const [setupMode, setSetupMode] = useState<"automated" | "manual">(
    defaultSetupMode
  );
  const autoContinuedRef = useRef(false);
  const [copied, copyGeneratedKey] = useCopyToClipboard();
  const [commandCopied, copyProvisioningCommand] = useCopyToClipboard();
  const { canContinue, desktopSetupStatus, electron, shouldAutoContinue } =
    useDesktopSetupReadiness({
      generatedKeyPresent: generatedKey !== null,
      provisioningAttemptId,
      provisioningCommandPresent: provisioningCommand !== null,
    });

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

  useEffect(() => {
    if (!shouldAutoContinue || autoContinuedRef.current) {
      return;
    }
    autoContinuedRef.current = true;
    onNext();
  }, [shouldAutoContinue, onNext]);

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
      setProvisioningAttemptId(null);
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
          setProvisioningAttemptId(attempt.onboardingAttemptId);
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
        onError: () => {
          setProvisioningCommand(null);
          setProvisioningAttemptId(null);
          setProvisioningError(
            "Failed to generate install command. Please try again."
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
        <h2 className="font-semibold text-lg">Set up ClosedLoop Desktop</h2>
        <p className="text-muted-foreground text-sm">
          Use the recommended automated setup to install or update Desktop and
          connect it to your account.
        </p>
      </div>

      <DesktopStatusPanel
        electronDetected={electron.detected}
        isDetecting={electron.loading}
        isElectronOutdated={isElectronOutdated}
        latestVersion={latestVersion}
        runningVersion={runningVersion}
        setupStatus={desktopSetupStatus}
        versionLabel={versionLabel}
      />

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
        onSelect={() => setSetupMode("automated")}
        open={setupMode === "automated"}
        provisioningCommand={provisioningCommand}
        provisioningError={provisioningError}
        sandboxBaseDirectory={sandboxBaseDirectory}
      />

      <ManualSetupSection
        copied={copied}
        downloadUrl={downloadUrl}
        electronDetected={electron.detected}
        generatedKey={electron.detected ? generatedKey : null}
        isDetecting={electron.loading}
        isElectronOutdated={isElectronOutdated}
        isPending={createApiKey.isPending}
        isReleaseLoading={isReleaseLoading}
        latestVersion={latestVersion}
        onCopy={handleCopy}
        onGenerateKey={handleGenerateKey}
        onSelect={() => setSetupMode("manual")}
        open={setupMode === "manual" || !automatedProvisioningEnabled}
        runningVersion={runningVersion}
      />

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
