import { GitPullRequestArrow } from "lucide-react";
import type { PrCommentContext } from "../comment-context";

export function PrCommentContextCard({
  context,
}: Readonly<{ context: PrCommentContext }>) {
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-secondary p-3">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <GitPullRequestArrow aria-hidden className="h-3.5 w-3.5 shrink-0" />
        <span className="font-semibold text-[11px]">PR Comment Context</span>
      </div>
      {context.filePath ? (
        <div className="rounded-md bg-muted px-2 py-2 font-mono text-[11px] text-foreground leading-snug">
          {context.filePath}
          {context.line != null ? `:${context.line}` : ""}
        </div>
      ) : null}
      <div className="rounded-md bg-muted p-2 text-foreground text-xs leading-relaxed">
        {context.body}
      </div>
    </div>
  );
}
