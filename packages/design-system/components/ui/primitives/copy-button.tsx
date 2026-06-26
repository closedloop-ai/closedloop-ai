"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { useCopyToClipboard } from "@repo/design-system/hooks/use-copy-to-clipboard";
import { Check, Copy } from "lucide-react";

type CopyButtonProps = {
  text: string;
  label?: string;
};

export function CopyButton({
  text,
  label = "Copy",
}: CopyButtonProps) {
  const [copied, copy] = useCopyToClipboard(1500);

  return (
    <Button
      className="h-6 gap-1 px-2 text-[10px] text-muted-foreground"
      onClick={async () => {
        await copy(text);
      }}
      size="sm"
      type="button"
      variant="ghost"
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      {copied ? "Copied" : label}
    </Button>
  );
}
