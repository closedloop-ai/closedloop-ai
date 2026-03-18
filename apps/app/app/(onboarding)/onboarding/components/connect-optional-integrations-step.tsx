"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Check, ExternalLink, Loader2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import {
  getGoogleOAuthUrl,
  useGoogleIntegrationStatus,
} from "@/hooks/queries/use-google-integration";
import {
  getLinearOAuthUrl,
  useLinearIntegrationStatus,
} from "@/hooks/queries/use-linear";
import { setOnboardingReturnCookie } from "../lib/onboarding-constants";

type ConnectOptionalIntegrationsStepProps = {
  readonly onNext: () => void;
};

export function ConnectOptionalIntegrationsStep({
  onNext,
}: ConnectOptionalIntegrationsStepProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const toastedRef = useRef(false);

  const { data: linearStatus, isLoading: linearLoading } =
    useLinearIntegrationStatus();
  const { data: googleStatus, isLoading: googleLoading } =
    useGoogleIntegrationStatus();

  // Handle OAuth callback results via URL params (fire once, then strip params)
  useEffect(() => {
    if (toastedRef.current) {
      return;
    }
    const linear = searchParams.get("linear");
    const google = searchParams.get("google");
    let fired = false;

    if (linear === "connected") {
      toast.success("Linear connected successfully");
      fired = true;
    } else if (linear === "error") {
      toast.error("Failed to connect Linear");
      fired = true;
    }

    if (google === "success") {
      toast.success("Google Drive connected successfully");
      fired = true;
    } else if (google === "error") {
      toast.error("Failed to connect Google Drive");
      fired = true;
    }

    if (fired) {
      toastedRef.current = true;
      router.replace("/onboarding", { scroll: false });
    }
  }, [searchParams, router]);

  const handleConnect = (url: string) => {
    setOnboardingReturnCookie();
    window.location.href = url;
  };

  const connectedCount = [
    linearStatus?.connected,
    googleStatus?.connected,
  ].filter(Boolean).length;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-semibold text-lg">Connect additional tools</h2>
        <p className="text-muted-foreground text-sm">
          Optionally link Linear or Google Drive. You can always do this later
          from settings.
        </p>
      </div>

      <div className="space-y-3">
        <IntegrationRow
          connected={linearStatus?.connected ?? false}
          description="Sync issues and project tracking"
          icon={<LinearIcon />}
          loading={linearLoading}
          name="Linear"
          onConnect={() => handleConnect(getLinearOAuthUrl())}
        />

        <IntegrationRow
          connected={googleStatus?.connected ?? false}
          description="Import and collaborate on documents"
          icon={<GoogleDriveIcon />}
          loading={googleLoading}
          name="Google Drive"
          onConnect={() => handleConnect(getGoogleOAuthUrl())}
        />
      </div>

      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm">
          {connectedCount > 0
            ? `${connectedCount} integration${connectedCount > 1 ? "s" : ""} connected`
            : "No additional integrations connected"}
        </p>
        <Button onClick={onNext}>
          {connectedCount > 0 ? "Continue" : "Skip for now"}
        </Button>
      </div>
    </div>
  );
}

type IntegrationRowProps = {
  readonly name: string;
  readonly description: string;
  readonly icon: React.ReactNode;
  readonly connected: boolean;
  readonly loading: boolean;
  readonly onConnect: () => void;
};

function IntegrationRow({
  name,
  description,
  icon,
  connected,
  loading,
  onConnect,
}: IntegrationRowProps) {
  return (
    <div className="flex items-center gap-3 rounded-lg border p-3">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="font-medium text-sm">{name}</p>
        <p className="truncate text-muted-foreground text-xs">{description}</p>
      </div>
      <IntegrationAction
        connected={connected}
        loading={loading}
        onConnect={onConnect}
      />
    </div>
  );
}

function IntegrationAction({
  connected,
  loading,
  onConnect,
}: {
  readonly connected: boolean;
  readonly loading: boolean;
  readonly onConnect: () => void;
}) {
  if (loading) {
    return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
  }

  if (connected) {
    return (
      <div className="flex items-center gap-1 text-green-500 text-sm">
        <Check className="h-4 w-4" />
        Connected
      </div>
    );
  }

  return (
    <Button onClick={onConnect} size="sm" variant="outline">
      <ExternalLink className="mr-1 h-3 w-3" />
      Connect
    </Button>
  );
}

function LinearIcon() {
  return (
    <svg
      aria-label="Linear"
      className="h-5 w-5"
      fill="currentColor"
      role="img"
      viewBox="0 0 24 24"
    >
      <path d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z" />
    </svg>
  );
}

function GoogleDriveIcon() {
  return (
    <svg
      aria-label="Google Drive"
      className="h-5 w-5"
      fill="currentColor"
      role="img"
      viewBox="0 0 24 24"
    >
      <path d="M12.01 1.485c-2.082 0-3.754.02-3.743.047.01.02 1.708 3.001 3.774 6.62l3.76 6.574h3.76c2.081 0 3.753-.02 3.742-.047-.005-.02-1.708-3.001-3.775-6.62l-3.76-6.574zm-4.76 1.73a789.828 789.861 0 0 0-3.63 6.319L0 15.868l1.89 3.298 1.885 3.297 3.62-6.335 3.618-6.33-1.88-3.287C8.1 4.704 7.255 3.22 7.25 3.214zm2.259 12.653-.203.348c-.114.198-.96 1.672-1.88 3.287a423.93 423.948 0 0 1-1.698 2.97c-.01.026 3.24.042 7.222.042h7.244l1.796-3.157c.992-1.734 1.85-3.23 1.906-3.323l.104-.167h-7.249z" />
    </svg>
  );
}
