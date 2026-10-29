"use client";

import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import { Checkbox } from "@repo/design-system/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { toast } from "@repo/design-system/components/ui/sonner";
import { CheckIcon, CopyIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { copyToClipboard } from "../../shared/lib/clipboard-utils";

const COPIED_RESET_MS = 2000;

/**
 * The ONE boundary at which a new key's secret is shown (ISS-8369 AC1).
 *
 * Shared by the Settings v2 API Keys panel and the legacy Settings panel, which
 * is why it lives here rather than beside either. Of everything in the product
 * this is the worst thing to have two of: the day the copies drift is the day
 * one of them stops warning somebody that the key is shown once (visual-QA
 * finding, ISS-8369).
 *
 * The secret is a prop and nothing else: it is never written to a log, an
 * analytics property, a telemetry attribute, a thrown `Error` message, or a
 * `data-` attribute, and there is no read path that can bring it back — the
 * server hashes it on creation and the list projection carries only the prefix.
 * Its only exits are the clipboard, at the user's request, and the `value` of
 * the read-only field below.
 *
 * The copy failure path is deliberately a fixed string. Interpolating anything
 * from the failed clipboard call is how a secret reaches a toast, and from there
 * a screenshot or a session replay.
 *
 * Closing is gated on the acknowledgement rather than the copy: a user who wrote
 * the key down by hand should not be trapped, and one who dismissed the dialog
 * by reflex should not lose the key silently.
 */
export function ApiKeyCreatedDialog({
  plaintext,
  onDismiss,
}: Readonly<{ plaintext: string; onDismiss: () => void }>) {
  const [copied, setCopied] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const copiedResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Both callers mount this conditionally, so the dialog can leave the tree
  // while a reset is pending — and a second copy must not be un-confirmed by
  // the FIRST copy's timer still coming due (AGENTS.md -> Runtime Cleanup).
  useEffect(
    () => () => {
      if (copiedResetTimer.current !== null) {
        globalThis.clearTimeout(copiedResetTimer.current);
      }
    },
    []
  );

  const handleCopy = async () => {
    const succeeded = await copyToClipboard(plaintext);
    if (!succeeded) {
      toast.error(
        "Couldn't copy to your clipboard. Select the key and copy it."
      );
      return;
    }
    setCopied(true);
    if (copiedResetTimer.current !== null) {
      globalThis.clearTimeout(copiedResetTimer.current);
    }
    copiedResetTimer.current = globalThis.setTimeout(() => {
      copiedResetTimer.current = null;
      setCopied(false);
    }, COPIED_RESET_MS);
  };

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open && acknowledged) {
          onDismiss();
        }
      }}
      open
    >
      {/* The dismissal is gated on the acknowledgement, so the close control
          must not exist until it would actually work — a drawn, focusable X
          that silently no-ops is a control lying about what it does. */}
      <DialogContent showCloseButton={acknowledged}>
        <DialogHeader>
          <DialogTitle>API key created</DialogTitle>
          <DialogDescription>
            This is the only time this key is shown. We store a hash of it, so
            we cannot show it to you again.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Alert variant="error">
            <TriangleAlertIcon aria-hidden="true" />
            <AlertDescription>
              Copy it now and store it somewhere safe. If you lose it, revoke
              the key and create a new one.
            </AlertDescription>
          </Alert>

          <div className="space-y-2">
            <Label htmlFor="created-api-key">API key</Label>
            <div className="flex gap-2">
              <Input
                className="font-mono text-sm"
                id="created-api-key"
                readOnly
                value={plaintext}
              />
              <Button
                aria-label={copied ? "Copied" : "Copy API key"}
                onClick={handleCopy}
                size="icon"
                variant="outline"
              >
                {copied ? (
                  <CheckIcon aria-hidden="true" />
                ) : (
                  <CopyIcon aria-hidden="true" />
                )}
              </Button>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              checked={acknowledged}
              id="acknowledge-api-key-stored"
              onCheckedChange={(checked) => setAcknowledged(checked === true)}
            />
            <Label
              className="cursor-pointer text-sm"
              htmlFor="acknowledge-api-key-stored"
            >
              I have stored this key somewhere safe
            </Label>
          </div>
        </div>

        <DialogFooter>
          <Button disabled={!acknowledged} onClick={onDismiss}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
