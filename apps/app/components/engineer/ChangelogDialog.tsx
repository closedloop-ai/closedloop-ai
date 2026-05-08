/* eslint-disable react-hooks/set-state-in-effect */
"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { Calendar, GitCommit, User } from "lucide-react";
import { useEffect, useState } from "react";

type Commit = {
  hash: string;
  shortHash: string;
  subject: string;
  body: string;
  author: string;
  date: string;
  relativeDate: string;
};

type VersionResponse = {
  version: string;
  commits: Commit[];
};

function CommitSkeleton() {
  return (
    <div className="animate-pulse space-y-4">
      {["sk-1", "sk-2", "sk-3", "sk-4", "sk-5"].map((id) => (
        <div className="flex gap-4" key={id}>
          <div className="size-8 shrink-0 rounded-full bg-muted" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-3/4 rounded bg-muted" />
            <div className="h-3 w-1/2 rounded bg-muted" />
          </div>
        </div>
      ))}
    </div>
  );
}

function CommitItem({
  commit,
  isFirst,
}: Readonly<{ commit: Commit; isFirst: boolean }>) {
  return (
    <div className="group relative flex gap-4">
      {/* Timeline connector */}
      <div className="relative flex flex-col items-center">
        <div
          className={`flex size-8 shrink-0 items-center justify-center rounded-full transition-colors ${
            isFirst
              ? "bg-primary/15 text-primary ring-2 ring-primary/20"
              : "bg-secondary text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary/70"
          }`}
        >
          <GitCommit className="size-3.5" strokeWidth={2} />
        </div>
        {/* Vertical line */}
        <div className="mt-2 w-px flex-1 bg-border/50" />
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1 pb-6">
        {/* Hash badge */}
        <div className="mb-1.5 flex items-center gap-2">
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {commit.shortHash}
          </code>
          {isFirst && (
            <span className="rounded-full bg-primary/10 px-1.5 py-0.5 font-medium text-[9px] text-primary uppercase tracking-wider">
              Latest
            </span>
          )}
        </div>

        {/* Subject */}
        <p className="mb-2 font-medium text-foreground text-sm leading-snug">
          {commit.subject}
        </p>

        {/* Body if present */}
        {commit.body && (
          <p className="mb-2 whitespace-pre-wrap text-muted-foreground/80 text-xs leading-relaxed">
            {commit.body}
          </p>
        )}

        {/* Meta row */}
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground/60">
          <span className="flex items-center gap-1">
            <User className="size-3" />
            {commit.author}
          </span>
          <span className="text-border">·</span>
          <span className="flex items-center gap-1" title={commit.date}>
            <Calendar className="size-3" />
            {commit.relativeDate}
          </span>
        </div>
      </div>
    </div>
  );
}

export function ChangelogDialog({
  open,
  onOpenChange,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
}>) {
  const [data, setData] = useState<VersionResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    setLoading(true);
    setError(null);

    fetch("/api/gateway/version")
      .then((res) => res.json())
      .then((json) => {
        if (json.error) {
          setError(json.error);
        } else {
          setData(json);
        }
      })
      .catch((err) => {
        setError(
          err instanceof Error ? err.message : "Failed to load changelog"
        );
      })
      .finally(() => setLoading(false));
  }, [open]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="gap-0 sm:max-w-lg">
        <DialogHeader className="pb-4">
          <DialogTitle className="flex items-center gap-2 font-semibold text-lg tracking-tight">
            Changelog
            {data?.version && (
              <code className="rounded-full bg-muted px-2 py-0.5 font-mono font-normal text-muted-foreground text-xs">
                {data.version}
              </code>
            )}
          </DialogTitle>
          <DialogDescription>
            Recent changes to Closedloop.dev
          </DialogDescription>
        </DialogHeader>

        {/* Scrollable commit list */}
        <div className="-mx-6 max-h-[60vh] overflow-y-auto px-6 py-2">
          {loading && <CommitSkeleton />}

          {error && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-destructive text-sm">
              {error}
            </div>
          )}

          {!(loading || error) && data?.commits.length === 0 && (
            <div className="py-12 text-center text-muted-foreground text-sm">
              No commits found
            </div>
          )}

          {!(loading || error) && data && data.commits.length > 0 && (
            <div className="relative">
              {data.commits.map((commit, index) => (
                <CommitItem
                  commit={commit}
                  isFirst={index === 0}
                  key={commit.hash}
                />
              ))}
              {/* End cap for timeline */}
              <div className="absolute bottom-0 left-[15px] size-2 rounded-full bg-border/50" />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
