"use client";

import { DesktopDeviceSessionStatus } from "@repo/api/src/types/onboarding";
import {
  useDesktopDeviceSession,
  useDesktopDeviceSessionAction,
} from "@repo/app/onboarding/hooks/use-desktop-onboarding";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { Input } from "@repo/design-system/components/ui/input";
import { toast } from "@repo/design-system/components/ui/sonner";
import { Loader2 } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

export function DesktopConnectApproval({
  initialCode,
}: {
  initialCode: string;
}) {
  const [code, setCode] = useState(initialCode.toUpperCase());
  const [submitting, setSubmitting] = useState<"approve" | "deny" | null>(null);

  const normalizedCode = useMemo(() => code.trim().toUpperCase(), [code]);
  const { data: details, isLoading: loading } =
    useDesktopDeviceSession(normalizedCode);
  const updateSession = useDesktopDeviceSessionAction();

  const submit = (action: "approve" | "deny") => {
    if (!normalizedCode) {
      return;
    }
    setSubmitting(action);
    updateSession.mutate(
      { userCode: normalizedCode, action },
      {
        onError: () => {
          toast.error("Could not update Desktop connection request");
          setSubmitting(null);
        },
        onSuccess: () => {
          toast.success(
            action === "approve" ? "Desktop connected" : "Request denied"
          );
          setSubmitting(null);
        },
      }
    );
  };

  let sessionContent: ReactNode = null;
  if (loading) {
    sessionContent = (
      <div className="flex items-center gap-2 text-muted-foreground text-sm">
        <Loader2 className="size-4 animate-spin" />
        Loading request
      </div>
    );
  } else if (details) {
    sessionContent = (
      <div className="space-y-3 rounded-lg border p-4 text-sm">
        <div className="grid grid-cols-[120px_1fr] gap-2">
          <span className="text-muted-foreground">Code</span>
          <span className="font-medium">{details.userCode}</span>
          <span className="text-muted-foreground">Machine</span>
          <span>{details.machineName}</span>
          <span className="text-muted-foreground">Platform</span>
          <span>{details.platform}</span>
          <span className="text-muted-foreground">Origin</span>
          <span className="break-all">{details.webAppOrigin}</span>
          <span className="text-muted-foreground">Status</span>
          <span className="capitalize">{details.status}</span>
        </div>
      </div>
    );
  } else if (normalizedCode) {
    sessionContent = (
      <p className="text-muted-foreground text-sm">
        No active request found for this code.
      </p>
    );
  }

  return (
    <main className="mx-auto flex min-h-[70vh] max-w-xl items-center px-6 py-12">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Connect Desktop</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <Input
            aria-label="Verification code"
            autoCapitalize="characters"
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            placeholder="Code"
            value={code}
          />

          {sessionContent}

          <div className="flex justify-end gap-2">
            <Button
              disabled={
                details?.status !== DesktopDeviceSessionStatus.Pending ||
                submitting !== null
              }
              onClick={() => submit("deny")}
              variant="outline"
            >
              {submitting === "deny" && (
                <Loader2 className="size-4 animate-spin" />
              )}
              Deny
            </Button>
            <Button
              disabled={
                details?.status !== DesktopDeviceSessionStatus.Pending ||
                submitting !== null
              }
              onClick={() => submit("approve")}
            >
              {submitting === "approve" && (
                <Loader2 className="size-4 animate-spin" />
              )}
              Approve
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
