import { Badge } from "@closedloop-ai/design-system/components/ui/badge";
import { EmptyState } from "@closedloop-ai/design-system/components/ui/empty-state";
import { MetricCard } from "@closedloop-ai/design-system/components/ui/primitives/metric-card";
import {
  Table as DsTable,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@closedloop-ai/design-system/components/ui/table";
import { formatDateTimeOrFallback } from "@repo/app/shared/lib/date-utils";
import { Package, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import type { SkillWithInvocations } from "../../../shared/agent-db-contract";
import { useQueryCache } from "../../hooks/useQueryCache";
import {
  cx,
  DASHBOARD_METRIC_CARD_CLASS_NAME,
  DASHBOARD_TABLE_CLASS_NAME,
  DashboardCard,
  LoadingState,
  PageShell,
} from "../layout/page-shell";
import { PacksCatalog } from "./PacksCatalog";
import { PlansView as PlansViewFull } from "./PlansView";
import { PullRequestsView as PullRequestsViewFull } from "./PullRequestsView";

// ---- Full-featured views (delegate to dedicated components) ----

export function PacksView() {
  return <PacksCatalog />;
}

export function PlansView() {
  return <PlansViewFull />;
}

export function PullRequestsView() {
  return <PullRequestsViewFull />;
}

// ---- Native Skills view kept outside the shared telemetry route migration ----

export function SkillsView() {
  const { data: skills, loading } = useQueryCache<SkillWithInvocations[]>(
    "db:all-skills",
    () => window.desktopApi.db.getAllSkills(),
    5000,
    10_000
  );

  if (loading && !skills) {
    return <LoadingState label="skills" />;
  }

  const rows = arrayOrEmpty(skills);

  return (
    <PageShell
      description="Skill invocations captured from agent sessions"
      title="Skills"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <MetricCard
          className={DASHBOARD_METRIC_CARD_CLASS_NAME}
          icon={Sparkles}
          label="Skills"
          value={rows.length}
        />
        <MetricCard
          className={DASHBOARD_METRIC_CARD_CLASS_NAME}
          icon={Sparkles}
          label="Total Invocations"
          value={rows.reduce((sum, r) => sum + r.invocationCount, 0)}
        />
        <MetricCard
          className={DASHBOARD_METRIC_CARD_CLASS_NAME}
          icon={Package}
          label="Packs"
          value={new Set(rows.map((r) => r.packId).filter(Boolean)).size}
        />
      </div>

      <FeatureCard
        empty={rows.length === 0 ? "No skill invocations captured yet." : null}
        title="Skill Invocations"
      >
        <Table>
          <TableHeader>
            <TableRow>
              <Header>Name</Header>
              <Header>Pack</Header>
              <Header>Harness</Header>
              <Header align="right">Calls</Header>
              <Header>Last Used</Header>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.skillId}>
                <Cell className="font-medium">{row.name}</Cell>
                <Cell>{row.packId ?? "-"}</Cell>
                <Cell>
                  {row.harness ? (
                    <Badge variant="outline">{row.harness}</Badge>
                  ) : (
                    "-"
                  )}
                </Cell>
                <Cell align="right">{row.invocationCount}</Cell>
                <Cell>{formatDate(row.lastUsedAt)}</Cell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </FeatureCard>
    </PageShell>
  );
}

// ---- Shared primitives (kept for the stub views) ----

function FeatureCard({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string | null;
  children: ReactNode;
}) {
  return (
    <DashboardCard contentClassName="p-0" title={title}>
      {empty ? (
        <EmptyState className="py-12" icon={Package} title={empty} />
      ) : (
        children
      )}
    </DashboardCard>
  );
}

function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-auto">
      <DsTable className={DASHBOARD_TABLE_CLASS_NAME}>{children}</DsTable>
    </div>
  );
}

function Header({
  align = "left",
  children,
}: {
  align?: "left" | "right";
  children: ReactNode;
}) {
  return (
    <TableHead
      className={cx("px-5", align === "right" ? "text-right" : "text-left")}
    >
      {children}
    </TableHead>
  );
}

function Cell({
  align = "left",
  className = "",
  children,
}: {
  align?: "left" | "right";
  className?: string;
  children: ReactNode;
}) {
  return (
    <TableCell
      className={cx(
        "px-5",
        align === "right" ? "text-right" : "text-left",
        className
      )}
    >
      {children}
    </TableCell>
  );
}

function formatDate(value: string | null): string {
  return formatDateTimeOrFallback(value, { fallback: "-" });
}

function arrayOrEmpty<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}
