"use client";

import { useAuth } from "@repo/auth/client";
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
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { resolveApiUrl } from "@/hooks/use-api-client";

type SessionDetails = {
  userCode: string;
  machineName: string;
  platform: string;
  webAppOrigin: string;
  status: string;
  expiresAt: string;
};

async function fetchDesktopSession<T>(
  token: string | null,
  path: string,
  options?: RequestInit
): Promise<T> {
  const response = await fetch(`${resolveApiUrl()}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(
      typeof body?.code === "string"
        ? body.code
        : "DESKTOP_DEVICE_SESSION_FAILED"
    );
  }
  return body as T;
}

export function DesktopConnectApproval({
  initialCode,
}: {
  initialCode: string;
}) {
  const { getToken } = useAuth();
  const [code, setCode] = useState(initialCode.toUpperCase());
  const [details, setDetails] = useState<SessionDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState<"approve" | "deny" | null>(null);

  const normalizedCode = useMemo(() => code.trim().toUpperCase(), [code]);

  useEffect(() => {
    if (!normalizedCode) {
      setDetails(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    getToken()
      .then((token) =>
        fetchDesktopSession<SessionDetails>(
          token,
          `/desktop/device-onboarding/session?code=${encodeURIComponent(
            normalizedCode
          )}`
        )
      )
      .then((result) => {
        if (!cancelled) {
          setDetails(result);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDetails(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [getToken, normalizedCode]);

  const submit = useCallback(
    async (action: "approve" | "deny") => {
      if (!normalizedCode) {
        return;
      }
      setSubmitting(action);
      try {
        const token = await getToken();
        await fetchDesktopSession(token, "/desktop/device-onboarding/approve", {
          method: "POST",
          body: JSON.stringify({
            userCode: normalizedCode,
            action,
          }),
        });
        toast.success(
          action === "approve" ? "Desktop connected" : "Request denied"
        );
        setDetails((current) =>
          current
            ? {
                ...current,
                status: action === "approve" ? "approved" : "denied",
              }
            : current
        );
      } catch {
        toast.error("Could not update Desktop connection request");
      } finally {
        setSubmitting(null);
      }
    },
    [getToken, normalizedCode]
  );

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
            autoCapitalize="characters"
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            placeholder="Code"
            value={code}
          />

          {sessionContent}

          <div className="flex justify-end gap-2">
            <Button
              disabled={
                !details || details.status !== "pending" || submitting !== null
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
                !details || details.status !== "pending" || submitting !== null
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
