"use client";

import { ExternalLinkIcon } from "lucide-react";

type PreviewLinkProps = {
  url: string | null | undefined;
};

export function PreviewLink({ url }: PreviewLinkProps) {
  if (!url) {
    return <span className="text-muted-foreground text-sm">-</span>;
  }

  return (
    <a
      className="inline-flex items-center gap-1 text-primary text-sm hover:underline"
      href={url}
      onClick={(e) => e.stopPropagation()}
      rel="noopener noreferrer"
      target="_blank"
    >
      Preview
      <ExternalLinkIcon className="h-3 w-3" />
    </a>
  );
}
