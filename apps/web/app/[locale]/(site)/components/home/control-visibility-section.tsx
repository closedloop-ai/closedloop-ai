/**
 * Static product screenshot for the marketing home page (plan editor).
 *
 * Mirrors the authenticated implementation-plan editor with generic data.
 * Structure sources (keep this mock in sync if the product changes):
 *   - Page shell:    apps/app/app/(authenticated)/implementation-plans/[slug]/plan-editor.tsx
 *   - Header:        apps/app/app/(authenticated)/implementation-plans/[slug]/components/plan-editor-header.tsx
 *   - Metadata bar:  apps/app/app/(authenticated)/implementation-plans/[slug]/components/plan-metadata-bar.tsx
 *
 * Colors use design-system semantic tokens so the mock tracks theme updates.
 */

import { PriorityIcon } from "@repo/design-system/components/ui/priority-icon";
import { StatusIcon } from "@repo/design-system/components/ui/status-icon";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  GitBranch,
  MessageSquare,
  MoreHorizontal,
  PanelLeft,
  Paperclip,
  Star,
} from "lucide-react";

const controlPoints = [
  {
    label: "Plans are reviewed before execution",
    description: "No code runs until the team aligns on how it will be built.",
  },
  {
    label: "Work is visible while it runs",
    description:
      "See progress, changes, and outputs in real time across the team.",
  },
  {
    label: "Outputs are validated before merge",
    description:
      "Every result is reviewed against the original intent before shipping.",
  },
];

export const ControlVisibilitySection = () => {
  return (
    <section className="mx-auto w-full max-w-[1300px] px-6 py-16 md:px-10 md:py-24">
      <div className="grid gap-12 lg:grid-cols-[2fr_3fr] lg:items-center lg:gap-16">
        <div>
          <h2 className="font-semibold text-4xl tracking-tight md:text-5xl">
            Built for control, not just speed
          </h2>
          <p className="mt-6 text-balance text-lg text-muted-foreground">
            Speed without control creates risk. Every step is visible,
            reviewable, and enforceable so teams can trust what ships.
          </p>
          <ul className="mt-10 space-y-3">
            {controlPoints.map(({ description, label }, index) => (
              <li
                className={`rounded-xl border p-5 transition-colors ${
                  index === 0
                    ? "border-border bg-accent/40"
                    : "border-border/60 bg-background hover:bg-accent/20"
                }`}
                key={label}
              >
                <p className="font-medium text-base">{label}</p>
                <p className="mt-1 text-muted-foreground text-sm">
                  {description}
                </p>
              </li>
            ))}
          </ul>
        </div>
        <PlanEditorMock />
      </div>
    </section>
  );
};

const PlanEditorMock = () => {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-background shadow-2xl">
      <PlanHeader />
      <div className="h-[48vh] max-h-[432px] overflow-hidden border-border border-b">
        <div className="px-8 pt-7 pb-6 md:px-10 md:pt-8">
          <PlanTitle />
          <PlanMetadataBar />
          <PlanBody />
        </div>
      </div>
      <AgentReviewSection />
    </div>
  );
};

/* Header — mirrors plan-editor-header.tsx. Panel toggle (left), breadcrumbs, Actions / overflow / panel toggle (right). */
const PlanHeader = () => {
  return (
    <header className="flex shrink-0 items-center justify-between gap-2 border-border border-b px-4 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <button
          aria-label="Toggle sidebar"
          className="-ml-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50"
          type="button"
        >
          <PanelLeft className="size-4" />
        </button>
        <div className="flex min-w-0 items-center gap-1.5 text-sm">
          <span className="text-muted-foreground">Product</span>
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="text-muted-foreground">Mobile checkout</span>
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium text-foreground">
            Background job queue migration
          </span>
        </div>
        <button
          aria-label="Favorite"
          className="ml-1 flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-accent/50"
          type="button"
        >
          <Star className="size-4 text-muted-foreground" />
        </button>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 font-medium text-primary-foreground text-xs shadow-sm"
          type="button"
        >
          Actions
          <ChevronDown className="size-3.5" />
        </button>
        <button
          aria-label="More actions"
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50"
          type="button"
        >
          <MoreHorizontal className="size-4" />
        </button>
      </div>
    </header>
  );
};

const PlanTitle = () => (
  <h1 className="font-semibold text-2xl tracking-tight md:text-3xl">
    Background job queue migration
  </h1>
);

/* Metadata bar — mirrors plan-metadata-bar.tsx, rendered as outline pills below the title. */
const PlanMetadataBar = () => {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <PillButton>
        <StatusIcon size={16} status="in-review" />
        <span>In Review</span>
      </PillButton>
      <PillButton>
        <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-emerald-100 font-medium text-[8px] text-emerald-700">
          SK
        </span>
        <span>Sam Keller</span>
      </PillButton>
      <PillButton>
        <PriorityIcon priority="MEDIUM" />
        <span>Medium</span>
      </PillButton>
      <PillButton>
        <GitBranch className="size-3.5" />
        <span>acme/checkout</span>
        <span className="text-muted-foreground/70">·</span>
        <span>main</span>
      </PillButton>
      <PillButton>
        <Paperclip className="size-3.5" />
        <span>Attach files</span>
      </PillButton>
    </div>
  );
};

const PillButton = ({ children }: { children: React.ReactNode }) => (
  <span className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-background px-2 font-medium text-foreground text-xs hover:bg-muted/50">
    {children}
  </span>
);

/* Body — mimics the rich-text plan content (headings + paragraphs + tasks). */
const PlanBody = () => {
  return (
    <div className="mt-6">
      <h2 className="font-semibold text-lg tracking-tight">
        Implementation Plan: Background Queue Migration
      </h2>
      <h3 className="mt-5 font-semibold text-base tracking-tight">Summary</h3>
      <p className="mt-2 text-foreground text-sm leading-relaxed">
        Migrate transactional emails and webhook delivery off the legacy queue
        with no downtime. Goal: cut p95 worker latency by 40% and remove the
        single-broker dependency in the worker tier. Rollout follows a
        dual-write → shadow-compare → consumer cutover sequence with a flag per
        consumer for fast revert.
      </p>

      <p className="mt-4 font-medium text-foreground text-sm">Scope:</p>
      <ul className="mt-2 space-y-1.5">
        <BodyBullet>
          <span className="font-medium">In-scope:</span> webhook delivery,
          transactional emails, retry policy, dead-letter handling, and
          per-consumer cutover flags.
        </BodyBullet>
        <BodyBullet>
          <span className="font-medium">Out-of-scope:</span> analytics events
          pipeline, user-facing notification preferences, and the realtime
          presence channel.
        </BodyBullet>
      </ul>

      <h3 className="mt-6 font-semibold text-base tracking-tight">
        Implementation Steps
      </h3>
      <ol className="mt-3 space-y-2.5">
        <PlanStep
          detail="Wire the SQS adapter behind the existing Queue interface. No callers change yet."
          done
          index={1}
          title="Add new queue adapter"
        />
        <PlanStep
          detail="Publish to both the legacy broker and SQS. Compare deliveries via the shadow consumer."
          done
          index={2}
          title="Dual-write events"
        />
        <PlanStep
          detail="Move webhook + email workers to read from SQS once shadow parity is ≥ 99.95%."
          index={3}
          title="Cut over consumers"
        />
        <PlanStep
          detail="Remove the old adapter, drop infra, and update on-call docs."
          index={4}
          title="Decommission legacy broker"
        />
      </ol>
    </div>
  );
};

const BodyBullet = ({ children }: { children: React.ReactNode }) => (
  <li className="flex gap-2 text-foreground text-sm">
    <span
      aria-hidden="true"
      className="mt-2 inline-block size-1.5 shrink-0 rounded-full bg-muted-foreground/60"
    />
    <span>{children}</span>
  </li>
);

type PlanStepProps = {
  index: number;
  title: string;
  detail: string;
  done?: boolean;
};

const PlanStep = ({ detail, done = false, index, title }: PlanStepProps) => {
  return (
    <li className="flex items-start gap-3">
      <span
        className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border font-medium text-[11px] ${
          done
            ? "border-success/30 bg-success/10 text-success"
            : "border-border bg-muted/60 text-muted-foreground"
        }`}
      >
        {done ? "✓" : index}
      </span>
      <div>
        <p
          className={`font-medium text-sm ${done ? "text-muted-foreground line-through" : "text-foreground"}`}
        >
          {title}
        </p>
        <p className="mt-0.5 text-muted-foreground text-xs">{detail}</p>
      </div>
    </li>
  );
};

/* Agent Review — mirrors the evaluation collapsible at the bottom of the plan editor. */
const AgentReviewSection = () => {
  return (
    <div className="px-8 py-4 md:px-10">
      <button
        className="flex w-full items-center justify-between gap-2 text-left"
        type="button"
      >
        <span className="flex items-center gap-2">
          <Bot className="size-4 text-muted-foreground" />
          <span className="font-medium text-foreground text-sm">
            Agent Review
          </span>
          <span className="rounded-full border border-success/30 bg-success/10 px-2 py-0.5 font-medium text-[10px] text-success uppercase tracking-wide">
            95%
          </span>
        </span>
        <span className="flex items-center gap-2">
          <MessageSquare className="size-4 text-muted-foreground" />
          <span className="font-medium text-foreground text-sm">
            3 Comments
          </span>
          <ChevronDown className="size-4 text-muted-foreground" />
        </span>
      </button>
    </div>
  );
};
