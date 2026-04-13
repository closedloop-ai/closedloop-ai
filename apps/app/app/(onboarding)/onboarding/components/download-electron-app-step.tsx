"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { cn } from "@repo/design-system/lib/utils";
import {
  CheckCircleIcon,
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  KeyIcon,
  Loader2Icon,
  MonitorIcon,
} from "lucide-react";
import { useState } from "react";
import { useLatestElectronRelease } from "@/hooks/queries/use-electron-release";
import { useCreatePlatformApiKey } from "@/hooks/queries/use-platform-api-keys";
import { useElectronDetection } from "@/lib/engineer/electron-detection";

type DownloadElectronAppStepProps = {
  readonly onNext: () => void;
};

export function DownloadElectronAppStep({
  onNext,
}: DownloadElectronAppStepProps) {
  const { data: release, isLoading: isReleaseLoading } =
    useLatestElectronRelease();
  const electron = useElectronDetection();
  const createApiKey = useCreatePlatformApiKey();

  const [generatedKey, setGeneratedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const downloadUrl = release?.downloadUrl ?? null;
  const version = release?.version ?? null;

  const canContinue = electron.detected && generatedKey !== null;

  const handleGenerateKey = () => {
    createApiKey.mutate(
      { name: "ClosedLoop Desktop", scopes: ["read", "write"] },
      {
        onSuccess: (data) => {
          setGeneratedKey(data.plaintext);
        },
      }
    );
  };

  const handleCopy = async () => {
    if (!generatedKey) {
      return;
    }
    await navigator.clipboard.writeText(generatedKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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
            <p className="text-muted-foreground text-xs">
              {version ? `Version ${version}` : "Latest version"}
            </p>
          </div>
          {electron.detected && (
            <div className="flex items-center gap-1 text-green-500 text-sm">
              <CheckCircleIcon className="h-4 w-4" />
              Running
            </div>
          )}
        </div>

        <DownloadAction
          downloadUrl={downloadUrl}
          electronDetected={electron.detected}
          isDetecting={electron.loading}
          isReleaseLoading={isReleaseLoading}
        />
      </div>

      {electron.detected && (
        <div className="space-y-3 rounded-lg border p-4">
          <div className="flex items-center gap-2">
            <KeyIcon className="h-4 w-4 text-muted-foreground" />
            <p className="font-medium text-sm">Connect with an API Key</p>
          </div>
          <p className="text-muted-foreground text-xs">
            Generate an API key to authenticate ClosedLoop Desktop with your
            account.
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

function DownloadAction({
  downloadUrl,
  electronDetected,
  isDetecting,
  isReleaseLoading,
}: {
  readonly downloadUrl: string | null;
  readonly electronDetected: boolean;
  readonly isDetecting: boolean;
  readonly isReleaseLoading: boolean;
}) {
  if (electronDetected) {
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
