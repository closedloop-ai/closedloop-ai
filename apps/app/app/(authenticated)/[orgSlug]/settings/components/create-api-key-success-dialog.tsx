"use client";

import { copyToClipboard } from "@repo/app/shared/lib/clipboard-utils";
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
import { useState } from "react";

type CreateApiKeySuccessDialogProps = {
  plaintext: string;
  onClose: () => void;
};

export function CreateApiKeySuccessDialog({
  plaintext,
  onClose,
}: Readonly<CreateApiKeySuccessDialogProps>) {
  const [copied, setCopied] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  const handleCopy = async () => {
    const success = await copyToClipboard(plaintext);
    if (!success) {
      toast.error("Failed to copy to clipboard");
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Dialog onOpenChange={(open) => !open && acknowledged && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>API Key Created</DialogTitle>
          <DialogDescription>
            Copy your new API key now. You will not be able to see it again.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Alert variant="error">
            <TriangleAlertIcon className="h-4 w-4" />
            <AlertDescription>
              This key will not be shown again. Copy it now and store it
              securely.
            </AlertDescription>
          </Alert>

          <div className="space-y-2">
            <Label htmlFor="api-key-value">API Key</Label>
            <div className="flex gap-2">
              <Input
                className="font-mono text-sm"
                id="api-key-value"
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
                  <CheckIcon className="h-4 w-4" />
                ) : (
                  <CopyIcon className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              checked={acknowledged}
              id="acknowledge"
              onCheckedChange={(checked) => setAcknowledged(checked === true)}
            />
            <Label className="cursor-pointer text-sm" htmlFor="acknowledge">
              I have copied and stored this key securely
            </Label>
          </div>
        </div>

        <DialogFooter>
          <Button disabled={!acknowledged} onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
