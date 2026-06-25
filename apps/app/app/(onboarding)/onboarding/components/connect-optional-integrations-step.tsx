"use client";

import { useFeatureFlag } from "@repo/analytics/client";
import { FeatureFlagged } from "@repo/analytics/components/feature-flagged";
import { useGoogleIntegrationStatus } from "@repo/app/google/hooks/use-google-integration";
import { Button } from "@repo/design-system/components/ui/button";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { Check, ExternalLink, Loader2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { getGoogleOAuthUrl } from "@/lib/integration-connect-urls";
import { setOnboardingReturnCookie } from "../lib/onboarding-constants";

type ConnectOptionalIntegrationsStepProps = {
  readonly onNext: () => void;
};

export function ConnectOptionalIntegrationsStep({
  onNext,
}: ConnectOptionalIntegrationsStepProps) {
  const navigation = useNavigation();
  const searchParams = useSearchParamsValue();
  const toastedRef = useRef(false);
  const skippedRef = useRef(false);

  const gdriveFlag = useFeatureFlag("google-drive");
  const gdriveFlagLoaded = gdriveFlag !== undefined;
  const gdriveEnabled = Boolean((gdriveFlag as { enabled?: boolean })?.enabled);
  const { data: googleStatus, isLoading: googleLoading } =
    useGoogleIntegrationStatus({ enabled: gdriveEnabled });

  // The only integration this step can offer right now is Google Drive (gated
  // behind the `google-drive` flag). When the flag is loaded and disabled,
  // there is nothing to show — auto-advance instead of rendering an empty step.
  useEffect(() => {
    if (skippedRef.current || !gdriveFlagLoaded || gdriveEnabled) {
      return;
    }
    skippedRef.current = true;
    onNext();
  }, [gdriveFlagLoaded, gdriveEnabled, onNext]);

  // Handle OAuth callback results via URL params (fire once, then strip params)
  useEffect(() => {
    if (toastedRef.current) {
      return;
    }
    const google = searchParams.get("google");
    let fired = false;

    if (google === "success") {
      toast.success("Google Drive connected successfully");
      fired = true;
    } else if (google === "error") {
      toast.error("Failed to connect Google Drive");
      fired = true;
    }

    if (fired) {
      toastedRef.current = true;
      navigation.replace("/onboarding", { scroll: false });
    }
  }, [searchParams, navigation]);

  const handleConnect = (url: string) => {
    setOnboardingReturnCookie();
    window.location.href = url;
  };

  const connectedCount = [gdriveEnabled && googleStatus?.connected].filter(
    Boolean
  ).length;

  if (!gdriveFlagLoaded) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!gdriveEnabled) {
    return null;
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-semibold text-lg">Connect additional tools</h2>
        <p className="text-muted-foreground text-sm">
          Optionally link Google Drive. You can always do this later from
          settings.
        </p>
      </div>

      <div className="space-y-3">
        <FeatureFlagged flag="google-drive">
          <IntegrationRow
            connected={googleStatus?.connected ?? false}
            description="Import and collaborate on documents"
            icon={<GoogleDriveIcon />}
            loading={googleLoading}
            name="Google Drive"
            onConnect={() => handleConnect(getGoogleOAuthUrl())}
          />
        </FeatureFlagged>
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
      <div className="flex items-center gap-1 text-sm text-success">
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
