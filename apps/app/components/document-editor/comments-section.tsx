"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { SendIcon } from "lucide-react";
import { useState } from "react";
import { CollapsibleSection } from "./collapsible-section";

type CommentsSectionProps = {
  /**
   * Artifact ID for future API integration
   */
  documentId: string;
};

/**
 * Comments section for artifact editor.
 * Currently shows "Feature not implemented" message with disabled input/send button.
 * Includes documentId prop for future-proofing when comments API is available.
 */
export function CommentsSection({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  documentId: _documentId,
}: Readonly<CommentsSectionProps>) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <CollapsibleSection onOpenChange={setIsOpen} open={isOpen} title="Comments">
      <p className="text-muted-foreground text-sm">Feature not implemented</p>
      <div className="flex gap-2">
        <Input disabled placeholder="Add a comment..." />
        <Button disabled size="icon" variant="ghost">
          <SendIcon className="h-4 w-4" />
        </Button>
      </div>
    </CollapsibleSection>
  );
}
