import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import type { Meta, StoryObj } from "@storybook/react";
import { AppScreenShell } from "./app-shell";

const SPARK = [12, 18, 15, 24, 22, 31, 28, 36, 33, 41, 38, 46];

const RECENT_SESSIONS = [
  {
    agent: "claude-opus",
    repo: "closedloop-ai/app",
    status: "Merged",
    when: "12m ago",
  },
  {
    agent: "claude-sonnet",
    repo: "closedloop-ai/api",
    status: "Open",
    when: "34m ago",
  },
  {
    agent: "claude-opus",
    repo: "closedloop-ai/desktop",
    status: "Merged",
    when: "1h ago",
  },
  {
    agent: "codex",
    repo: "closedloop-ai/web",
    status: "Failed",
    when: "2h ago",
  },
  {
    agent: "claude-sonnet",
    repo: "closedloop-ai/app",
    status: "Merged",
    when: "3h ago",
  },
];

const STATUS_TONE: Record<string, string> = {
  Merged: "bg-success text-success-foreground",
  Open: "bg-info text-info-foreground",
  Failed: "bg-destructive text-destructive-foreground",
};

const DashboardScreen = () => (
  <AppScreenShell activePath="/dashboard" breadcrumbs={["Dashboard"]}>
    <div className="flex min-h-0 flex-1 flex-col gap-6 p-6">
      <div>
        <h1 className="font-semibold text-2xl tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground">
          Agent-session telemetry across your organization's synced compute
          targets.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          deltaLabel="+12% vs prior period"
          info={{
            what: "Sessions started by any connected agent.",
            how: "Counted from session telemetry across every synced target.",
          }}
          label="Agent sessions"
          sparkline={SPARK}
          value="1,284"
        />
        <MetricCard
          deltaLabel="+4% vs prior period"
          info={{ what: "Share of agent branches that reached main." }}
          label="Merge rate"
          unitLabel="%"
          value="72"
        />
        <MetricCard
          detail="Calculated from available data."
          info={{ what: "Median lines changed per pull request." }}
          label="Median PR size"
          unitLabel="LOC"
          value="148"
        />
        <MetricCard
          info={{ what: "Spend attributed to agent sessions this period." }}
          label="Spend"
          sparkline={SPARK}
          value="$4,206"
        />
      </div>

      <div className="grid min-h-0 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Recent sessions</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground text-xs">
                  <th className="px-6 py-2 font-medium">Agent</th>
                  <th className="px-6 py-2 font-medium">Repository</th>
                  <th className="px-6 py-2 font-medium">Status</th>
                  <th className="px-6 py-2 text-right font-medium">Started</th>
                </tr>
              </thead>
              <tbody>
                {RECENT_SESSIONS.map((session) => (
                  <tr
                    className="border-b last:border-0"
                    key={`${session.agent}-${session.when}`}
                  >
                    <td className="px-6 py-3 font-medium">{session.agent}</td>
                    <td className="px-6 py-3 text-muted-foreground">
                      {session.repo}
                    </td>
                    <td className="px-6 py-3">
                      <Badge className={STATUS_TONE[session.status]}>
                        {session.status}
                      </Badge>
                    </td>
                    <td className="px-6 py-3 text-right text-muted-foreground">
                      {session.when}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Model usage</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {[
              { model: "claude-opus", share: 54, token: "--chart-1" },
              { model: "claude-sonnet", share: 31, token: "--chart-2" },
              { model: "codex", share: 15, token: "--chart-3" },
            ].map((row) => (
              <div className="space-y-1" key={row.model}>
                <div className="flex items-baseline justify-between text-sm">
                  <span>{row.model}</span>
                  <span className="text-muted-foreground">{row.share}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full"
                    style={{
                      background: `var(${row.token})`,
                      width: `${row.share}%`,
                    }}
                  />
                </div>
              </div>
            ))}
            <Button className="w-full" size="sm" variant="outline">
              View all models
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  </AppScreenShell>
);

const meta = {
  title: "Screens/Dashboard",
  component: DashboardScreen,
  parameters: { controls: { disable: true }, layout: "fullscreen" },
} satisfies Meta<typeof DashboardScreen>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
