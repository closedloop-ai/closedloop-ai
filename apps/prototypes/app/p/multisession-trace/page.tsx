"use client";

import { Chip } from "@repo/design-system/components/ui/chip";
import { GitBranchIcon } from "lucide-react";
import { AssociatedSessionList } from "./components/associated-session-list";
import { BranchChecksStrip } from "./components/branch-checks-strip";
import { REFERENCE_DETAIL } from "./mock-detail";

const MultiSessionTracePrototypePage = () => {
  const detail = REFERENCE_DETAIL;

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-5 py-8">
      <header className="flex flex-col gap-1">
        <span className="flex items-center gap-1.5 font-semibold text-[11px] text-muted-foreground uppercase tracking-[0.12em]">
          <GitBranchIcon aria-hidden className="size-3.5" />
          {detail.entityLabel}
        </span>
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="font-semibold text-2xl tracking-tight">
            {detail.branchName}
          </h1>
          <Chip size="sm" variant="warning">
            {detail.statusLabel}
          </Chip>
        </div>
        <p className="text-muted-foreground text-sm">
          <a
            className="text-primary hover:underline"
            href={detail.prUrl}
            rel="noreferrer"
            target="_blank"
          >
            #{detail.prNumber}
          </a>{" "}
          {detail.prTitle} · {detail.repoFullName}
        </p>
        <BranchChecksStrip checks={detail.checks} />
      </header>

      {/* Integration note: this collapsed list is the replacement for the
          branches prototype's CombinedTrace inside the branch's "Sessions &
          timeline" tab — not a new Branch page and not a second view beside it.
          The standalone page here is only the sandbox that isolates the trace
          component; in production it drops into that existing tab, so the main
          branch-detail layout decision stays made. */}
      <p className="rounded-md border border-border border-dashed bg-muted/30 px-3 py-2 text-muted-foreground text-xs">
        <span className="font-medium text-foreground">Where this lands: </span>
        this collapsed session list replaces the flat{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
          CombinedTrace
        </code>{" "}
        inside the branch detail&apos;s{" "}
        <span className="font-medium text-foreground">
          Sessions &amp; timeline
        </span>{" "}
        tab (see the branches prototype) — it is the trace for that tab, not a
        new page or a second view beside it. This standalone page only isolates
        the component for review.
      </p>

      <section aria-labelledby="trace-heading" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2
            className="font-semibold text-foreground text-sm"
            id="trace-heading"
          >
            Session trace
            <span className="ml-1 font-normal text-[11px] text-muted-foreground normal-case tracking-normal">
              · {detail.sessions.length} associated sessions
            </span>
          </h2>
          <p className="flex items-center gap-x-2.5 text-[11px] text-muted-foreground tabular-nums">
            <span>{detail.totalDurationLabel}</span>
            <span aria-hidden>·</span>
            <span>{detail.totalTokensLabel}</span>
            <span aria-hidden>·</span>
            <span className="font-semibold text-foreground">
              {detail.totalCostLabel}
            </span>
          </p>
        </div>
        <AssociatedSessionList sessions={detail.sessions} />
      </section>
    </main>
  );
};

export default MultiSessionTracePrototypePage;
