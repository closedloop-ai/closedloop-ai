"use client";

import { getStoredBrowserSigningKeyMetadata } from "@repo/app/compute/lib/command-signing/key-store";
import { Button } from "@repo/design-system/components/ui/button";
import { toast } from "@repo/design-system/components/ui/sonner";
import { KeyRound, Loader2, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
  useRegisterBrowserCommandKey,
  useUnregisterBrowserCommandKey,
} from "@/hooks/queries/use-public-keys";
import { SettingsActionPanel } from "./settings-action-panel";

/**
 * Register or unregister THIS browser's command-signing key.
 *
 * Split out of `LocalComputeTargetsCard` (PLN-1915 Step 5) so the Settings v2
 * Local Compute Targets panel offers the same affordance from the same module
 * rather than a second copy of it.
 */
export function BrowserCommandSigningPanel() {
  const registerBrowserKey = useRegisterBrowserCommandKey();
  const unregisterBrowserKey = useUnregisterBrowserCommandKey();
  const [registeredFingerprint, setRegisteredFingerprint] = useState<
    string | null
  >(null);
  const isMutating =
    registerBrowserKey.isPending || unregisterBrowserKey.isPending;

  useEffect(() => {
    let cancelled = false;

    getStoredBrowserSigningKeyMetadata().then((key) => {
      if (!cancelled && key.ok) {
        setRegisteredFingerprint(key.fingerprint);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleRegisterBrowserKey = () => {
    if (registeredFingerprint) {
      return;
    }

    registerBrowserKey.mutate(undefined, {
      onSuccess: (key) => {
        setRegisteredFingerprint(key.fingerprint);
        toast.success("Browser signing key registered");
      },
    });
  };

  const handleUnregisterBrowserKey = () => {
    if (!registeredFingerprint) {
      return;
    }

    unregisterBrowserKey.mutate(registeredFingerprint, {
      onSuccess: () => {
        setRegisteredFingerprint(null);
        toast.success("Browser signing key unregistered");
      },
    });
  };

  let buttonIcon = <KeyRound className="size-4" />;
  if (isMutating) {
    buttonIcon = <Loader2 className="size-4 animate-spin" />;
  } else if (registeredFingerprint) {
    buttonIcon = <Trash2 className="size-4" />;
  }

  return (
    <SettingsActionPanel
      action={
        <Button
          disabled={isMutating}
          onClick={
            registeredFingerprint
              ? handleUnregisterBrowserKey
              : handleRegisterBrowserKey
          }
          size="sm"
          variant="outline"
        >
          {buttonIcon}
          {registeredFingerprint ? "Unregister" : "Register Browser"}
        </Button>
      }
      description={
        registeredFingerprint
          ? `Registered key ${registeredFingerprint}`
          : "Register this browser before authorizing it in Desktop."
      }
      icon={<KeyRound className="size-4" />}
      title="Browser Command Signing"
    />
  );
}
