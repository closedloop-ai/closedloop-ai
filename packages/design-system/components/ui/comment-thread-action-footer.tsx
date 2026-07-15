"use client";

import { Button } from "@closedloop-ai/design-system/components/ui/button";
import type { ReactNode } from "react";

export type CommentThreadActionFooterProps = {
  label: string;
  isPending?: boolean;
  icon?: ReactNode;
  onClick: () => void;
};

export function CommentThreadActionFooter({
  label,
  isPending = false,
  icon,
  onClick,
}: Readonly<CommentThreadActionFooterProps>) {
  return (
    <div className="flex justify-end border-border border-t bg-muted/20 px-3 py-2">
      <Button
        data-comment-control="true"
        disabled={isPending}
        onClick={(event) => {
          event.stopPropagation();
          onClick();
        }}
        size="sm"
        type="button"
        variant="secondary"
      >
        {icon}
        {label}
      </Button>
    </div>
  );
}
