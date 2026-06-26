"use client";

import { useFeatureFlag } from "@repo/analytics/client";
import { useDocumentBySlug } from "@repo/app/documents/hooks/use-documents";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import { Link } from "@repo/navigation/link";
import { Lightbulb } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useOrgSlug } from "@/hooks/use-org-slug";
import { CommentMarkdown } from "@/lib/markdown";
import { deriveChangeRationale, WhyThisChangeSource } from "./why-this-change";

/** PostHog flag gating the traceable "Why this change" rationale popover. */
export const REVIEW_WHY_FLAG = "emergent";

type WhyThisChangePopoverProps = {
  /** Slug of the Implementation Plan that produced this branch, if linked. */
  planSlug: string | null;
  /** Title of the producing plan, used for the link label. */
  planTitle: string | null;
  /** Path of the diff file currently in focus. */
  filePath: string;
};

/**
 * "Why this change" — a per-file rationale popover for the branch review view.
 *
 * ClosedLoop links each branch to its producing Implementation Plan, so the
 * reason a file changed is sourced from recorded intent rather than guessed by
 * an LLM from the diff. When no plan is linked we show an explicit fallback
 * (the slot a future AI summary would fill). Gated behind `emergent`.
 *
 * The plan is fetched lazily: the body — and its data/org hooks — only mount
 * once the popover is opened.
 */
export function WhyThisChangePopover({
  planSlug,
  planTitle,
  filePath,
}: Readonly<WhyThisChangePopoverProps>) {
  const flag = useFeatureFlag(REVIEW_WHY_FLAG);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Avoid a hydration mismatch: feature flags resolve client-side.
  if (!mounted || flag?.enabled !== true) {
    return null;
  }

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          className="bg-transparent dark:bg-transparent"
          size="sm"
          variant="outline"
        >
          <Lightbulb className="mr-1.5 h-4 w-4" />
          Why this change
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <div className="flex items-center gap-2 border-border border-b px-4 py-3">
          <Lightbulb className="h-4 w-4 shrink-0 text-foreground" />
          <div className="min-w-0">
            <p className="font-medium text-foreground text-sm">
              Why this change
            </p>
            <p className="truncate text-muted-foreground text-xs">
              {planSlug
                ? "Sourced from the linked implementation plan"
                : "No linked implementation plan"}
            </p>
          </div>
        </div>
        <div className="max-h-72 overflow-y-auto px-4 py-3">
          {open ? (
            <WhyThisChangeBody
              filePath={filePath}
              planSlug={planSlug}
              planTitle={planTitle}
            />
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function WhyThisChangeBody({
  planSlug,
  planTitle,
  filePath,
}: Readonly<WhyThisChangePopoverProps>) {
  const orgSlug = useOrgSlug();
  const { data, isLoading, isError } = useDocumentBySlug(
    planSlug ?? "",
    undefined,
    { enabled: Boolean(planSlug) }
  );

  const planContent =
    data?.latestVersionContent ?? data?.version?.content ?? null;
  const rationale = useMemo(
    () => deriveChangeRationale(planContent, filePath),
    [planContent, filePath]
  );

  if (!planSlug) {
    return (
      <p className="text-muted-foreground text-xs">
        This branch isn't linked to an implementation plan, so there's no
        recorded intent to summarize yet.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      <Link
        className="inline-flex w-fit max-w-full items-center gap-1.5 truncate font-medium text-foreground text-xs underline-offset-2 hover:underline"
        href={`/${orgSlug}/implementation-plans/${planSlug}`}
      >
        {planTitle ?? "View implementation plan"}
      </Link>
      <WhyThisChangeRationale
        isError={isError}
        isLoading={isLoading}
        rationale={rationale}
      />
    </div>
  );
}

type WhyThisChangeRationaleProps = {
  isError: boolean;
  isLoading: boolean;
  rationale: ReturnType<typeof deriveChangeRationale>;
};

function WhyThisChangeRationale({
  isError,
  isLoading,
  rationale,
}: Readonly<WhyThisChangeRationaleProps>) {
  if (isLoading) {
    return (
      <p className="text-muted-foreground text-xs">
        Summarizing the intent from the plan…
      </p>
    );
  }
  if (isError) {
    return (
      <p className="text-muted-foreground text-xs">
        Couldn't load the linked plan right now.
      </p>
    );
  }
  if (!rationale) {
    return (
      <p className="text-muted-foreground text-xs">
        The linked plan has no content to summarize yet.
      </p>
    );
  }

  const label =
    rationale.source === WhyThisChangeSource.FileMatch
      ? "From the plan task touching this file"
      : "Plan intent (no task references this file directly)";

  return (
    <div className="flex flex-col gap-1.5">
      <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {label}
      </p>
      <div className="text-foreground text-xs">
        <CommentMarkdown>{rationale.excerpt}</CommentMarkdown>
      </div>
    </div>
  );
}
