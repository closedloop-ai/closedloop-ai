"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Check, ExternalLink, Github, Loader2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import {
  useGetGitHubConnectUrl,
  useGitHubIntegrationStatus,
} from "@/hooks/queries/use-github-integration";
import { setOnboardingReturnCookie } from "../lib/onboarding-constants";

type ConnectGitHubStepProps = {
  readonly onNext: () => void;
};

export function ConnectGitHubStep({ onNext }: ConnectGitHubStepProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const githubConnectUrl = useGetGitHubConnectUrl("install");
  const toastedRef = useRef(false);

  const { data: githubStatus, isLoading } = useGitHubIntegrationStatus();
  const isConnected = githubStatus?.connected ?? false;

  // Handle OAuth callback result via URL params (fire once, then strip params)
  useEffect(() => {
    if (toastedRef.current) {
      return;
    }
    const github = searchParams.get("github");
    if (github === "connected") {
      toastedRef.current = true;
      toast.success("GitHub connected successfully");
      router.replace("/onboarding", { scroll: false });
    } else if (github === "error") {
      toastedRef.current = true;
      toast.error("Failed to connect GitHub");
      router.replace("/onboarding", { scroll: false });
    }
  }, [searchParams, router]);

  const handleConnect = () => {
    setOnboardingReturnCookie();
    window.location.href = githubConnectUrl;
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-semibold text-lg">Connect GitHub</h2>
        <p className="text-muted-foreground text-sm">
          Link your GitHub account to enable code management, pull requests, and
          automated workflows.
        </p>
      </div>

      <div className="flex items-center gap-3 rounded-lg border p-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted">
          <Github className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-medium text-sm">GitHub</p>
          <p className="truncate text-muted-foreground text-xs">
            Link repositories for code management
          </p>
        </div>
        <GitHubAction
          isConnected={isConnected}
          isLoading={isLoading}
          onConnect={handleConnect}
        />
      </div>

      <div className="flex items-center justify-between">
        {/* TODO: Remove skip button — temporary for local dev */}
        <Button
          className="text-muted-foreground"
          onClick={onNext}
          size="sm"
          variant="ghost"
        >
          Skip for now
        </Button>
        <Button disabled={!isConnected} onClick={onNext}>
          Continue
        </Button>
      </div>
    </div>
  );
}

function GitHubAction({
  isLoading,
  isConnected,
  onConnect,
}: {
  readonly isLoading: boolean;
  readonly isConnected: boolean;
  readonly onConnect: () => void;
}) {
  if (isLoading) {
    return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
  }

  if (isConnected) {
    return (
      <div className="flex items-center gap-1 text-green-500 text-sm">
        <Check className="h-4 w-4" />
        Connected
      </div>
    );
  }

  return (
    <Button onClick={onConnect} size="sm" variant="outline">
      <ExternalLink className="h-3 w-3" />
      Connect
    </Button>
  );
}
