import { ArrowRight, CheckCircle2 } from "lucide-react";

export const ArtifactsSection = () => {
  return (
    <section className="dark w-full bg-sidebar py-16 text-foreground md:py-24">
      <div className="mx-auto w-full max-w-[1300px] px-6 md:px-10">
        <div className="max-w-3xl">
          <h2 className="text-balance font-semibold text-4xl tracking-tight md:text-5xl">
            Every step, grounded in what came before
          </h2>
          <p className="mt-6 text-balance text-lg text-muted-foreground">
            Artifacts are the units of work that agents read and produce.
            Requirements become plans, plans drive execution, and results
            surface as previews. All connected, all visible, nothing lost
            between sessions.
          </p>
        </div>

        <ArtifactLifecycleVisual />
      </div>
    </section>
  );
};

const ArtifactLifecycleVisual = () => {
  return (
    <div className="mt-10 grid gap-3 lg:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr]">
      <RequirementsCard />
      <FlowConnector />
      <PlanCard />
      <FlowConnector />
      <BranchCard />
      <FlowConnector />
      <DeploymentCard />
    </div>
  );
};

const FlowConnector = () => {
  return (
    <div
      aria-hidden="true"
      className="flex items-center justify-center text-muted-foreground"
    >
      <ArrowRight className="hidden size-5 lg:block" />
      <ArrowRight className="size-5 rotate-90 lg:hidden" />
    </div>
  );
};

type StatusTone = "running" | "in-review" | "approved" | "complete";

type ArtifactCardProps = {
  label: string;
  status: { tone: StatusTone; text: string };
  title: string;
  children: React.ReactNode;
};

const ArtifactCard = ({
  children,
  label,
  status,
  title,
}: ArtifactCardProps) => {
  return (
    <div className="relative flex flex-col gap-3 rounded-2xl border border-border/60 bg-card/60 p-4 shadow-sm backdrop-blur">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground/80 text-xs uppercase tracking-wide">
          {label}
        </span>
        <StatusBadge text={status.text} tone={status.tone} />
      </div>
      <p className="font-medium text-sm leading-tight">{title}</p>
      <div className="flex-1">{children}</div>
    </div>
  );
};

const RequirementsCard = () => {
  return (
    <ArtifactCard
      label="Requirements"
      status={{ tone: "approved", text: "Approved" }}
      title="Add tags to items…"
    >
      <p className="text-muted-foreground text-xs leading-relaxed">
        Users should be able to add, edit, and remove tags…
      </p>
      <div className="mt-3 space-y-1.5">
        <DocLine width="w-full" />
        <DocLine width="w-5/6" />
        <DocLine width="w-2/3" />
      </div>
    </ArtifactCard>
  );
};

const PlanCard = () => {
  return (
    <ArtifactCard
      label="Plan"
      status={{ tone: "approved", text: "Approved" }}
      title="Implementation Plan"
    >
      <p className="text-muted-foreground text-xs leading-relaxed">
        Given existing models and APIs, we will…
      </p>
      <ul className="mt-3 space-y-1.5 text-xs">
        {[
          "Add Tag model and migration",
          "Expose tag endpoints",
          "Render tag chips on items",
        ].map((step) => (
          <li className="flex items-start gap-2" key={step}>
            <CheckCircle2 className="mt-0.5 size-3 shrink-0 text-primary" />
            <span className="text-muted-foreground">{step}</span>
          </li>
        ))}
      </ul>
    </ArtifactCard>
  );
};

const BranchCard = () => {
  return (
    <ArtifactCard
      label="Branch"
      status={{ tone: "in-review", text: "In Review" }}
      title="feat/item-tags"
    >
      <div className="space-y-1 font-mono text-[10px] text-muted-foreground">
        <div>src/items/</div>
        <div className="pl-3">tags.ts</div>
        <div className="pl-3">item.ts</div>
      </div>
      <div className="mt-3 space-y-1 rounded-md bg-muted/60 p-2 font-mono text-[10px]">
        <div className="text-success">+ addTagToItem(item, tag)</div>
        <div className="text-success">+ updateTagList(itemId, tags)</div>
      </div>
    </ArtifactCard>
  );
};

const DeploymentCard = () => {
  return (
    <ArtifactCard
      label="Preview"
      status={{ tone: "approved", text: "Live" }}
      title="Deployment / Preview"
    >
      <div className="overflow-hidden rounded-md border border-border/60 bg-card">
        <div className="flex items-center gap-1 border-border/60 border-b bg-muted/40 px-2 py-1">
          <span className="size-1.5 rounded-full bg-destructive/70" />
          <span className="size-1.5 rounded-full bg-warning/70" />
          <span className="size-1.5 rounded-full bg-success/70" />
        </div>
        <div className="space-y-2 p-2">
          <div className="h-2 w-3/4 rounded bg-muted" />
          <div className="flex flex-wrap gap-1">
            <TagChip>design</TagChip>
            <TagChip>infra</TagChip>
            <TagChip>p0</TagChip>
          </div>
          <div className="rounded border border-border/60 bg-card/60 p-1.5 text-[9px] text-muted-foreground">
            <span className="font-medium text-foreground">PM:</span> spacing
            tweak?
          </div>
        </div>
      </div>
    </ArtifactCard>
  );
};

const DocLine = ({ width }: { width: string }) => {
  return <div className={`h-1.5 rounded bg-muted ${width}`} />;
};

const TagChip = ({ children }: { children: React.ReactNode }) => {
  return (
    <span className="rounded-full bg-primary/10 px-1.5 py-0.5 font-medium text-[9px] text-primary">
      {children}
    </span>
  );
};

const STATUS_TONE_CLASSES: Record<StatusTone, string> = {
  running:
    "bg-primary/10 text-primary border-primary/30 [&>span]:animate-pulse [&>span]:bg-primary",
  "in-review":
    "bg-warning/10 text-warning border-warning/30 [&>span]:bg-warning",
  approved: "bg-success/10 text-success border-success/30 [&>span]:bg-success",
  complete:
    "bg-muted text-muted-foreground border-border/60 [&>span]:bg-muted-foreground",
};

type StatusBadgeProps = {
  text: string;
  tone: StatusTone;
};

const StatusBadge = ({ text, tone }: StatusBadgeProps) => {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium text-[10px] uppercase tracking-wide ${STATUS_TONE_CLASSES[tone]}`}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full" />
      {text}
    </span>
  );
};
