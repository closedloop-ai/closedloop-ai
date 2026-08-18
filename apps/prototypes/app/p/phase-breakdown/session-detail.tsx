"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Chip } from "@repo/design-system/components/ui/chip";
import { ArrowLeftIcon } from "lucide-react";
import type { ReactNode } from "react";
import { type PhaseSession, SESSION_STATUS_META } from "./mock";

function DetailProperty({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}

export function SessionDetailView({
  session,
  onBack,
}: {
  session: PhaseSession;
  onBack: () => void;
}) {
  const meta = SESSION_STATUS_META[session.status];
  return (
    <div>
      <Button
        className="mb-4 -ml-2 text-muted-foreground"
        onClick={onBack}
        size="sm"
        variant="ghost"
      >
        <ArrowLeftIcon />
        Back to cost breakdown
      </Button>
      <div className="flex items-center gap-2.5">
        <h1 className="font-semibold text-foreground text-lg">
          {session.title}
        </h1>
        <Chip size="sm" variant={meta.variant}>
          {meta.label}
        </Chip>
      </div>
      <p className="mt-1 font-mono text-muted-foreground text-xs">
        {session.id}
      </p>
      <div className="mt-6 divide-y divide-border rounded-lg border bg-card">
        <DetailProperty label="Owner" value={session.owner} />
        <DetailProperty
          label="Model"
          value={<span className="font-mono text-xs">{session.model}</span>}
        />
        <DetailProperty label="Duration" value={session.durationLabel} />
        <DetailProperty
          label="Estimated cost"
          value={<span className="tabular-nums">{session.costLabel}</span>}
        />
        <DetailProperty label="Started" value={session.startedLabel} />
      </div>
      <p className="mt-4 text-muted-foreground text-xs">
        Stand-in for the full session detail page. In the product the session
        title links straight there, without this in-card back step.
      </p>
    </div>
  );
}
