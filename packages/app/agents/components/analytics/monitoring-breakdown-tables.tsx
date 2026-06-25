"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import {
  BotIcon,
  FolderGit2Icon,
  FolderKanbanIcon,
  WrenchIcon,
} from "lucide-react";
import type { ReactNode } from "react";

export type MonitoringAgentTypeRow = {
  agentType: string;
  count: string;
  successCount: string;
  failedCount: string;
  successRateLabel: string | null;
  successRateVariant: "secondary" | "destructive";
  avgDurationLabel: string;
};

export type MonitoringRepositoryRow = {
  repositoryFullName: string;
  sessionCount: string;
  tokenCount: string;
  cost: string;
  errorCount: string;
  hasErrors: boolean;
};

export type MonitoringProjectRow = {
  projectId: string;
  projectName: string;
  sessionCount: string;
  tokenCount: string;
  cost: string;
};

export type MonitoringToolUsageRow = {
  toolName: string;
  invocationCount: string;
  errorCount: string;
  hasErrors: boolean;
  sessionCount: string;
  errorRateLabel: string | null;
  errorRateVariant: "secondary" | "destructive";
};

/**
 * Shared analytics table for agent-type effectiveness breakdowns.
 */
export function MonitoringAgentTypeTable({
  rows,
  totalAgentsLabel,
}: Readonly<{
  rows: MonitoringAgentTypeRow[];
  totalAgentsLabel: string;
}>) {
  if (rows.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BotIcon className="h-4 w-4" />
          Agent Type Effectiveness
        </CardTitle>
        <CardDescription>
          Performance breakdown across {totalAgentsLabel} agent instances.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="cl-mobile-only space-y-3">
          {rows.map((row) => (
            <MobileBreakdownRow key={row.agentType} title={row.agentType}>
              <MobileBreakdownFact label="Count" value={row.count} />
              <MobileBreakdownFact
                label="Success"
                value={<span className="text-success">{row.successCount}</span>}
              />
              <MobileBreakdownFact
                label="Failed"
                value={
                  row.failedCount === "0" ? (
                    <span className="text-muted-foreground">0</span>
                  ) : (
                    <span className="text-destructive">{row.failedCount}</span>
                  )
                }
              />
              <MobileBreakdownFact
                label="Success Rate"
                value={
                  row.successRateLabel ? (
                    <Badge className="text-xs" variant={row.successRateVariant}>
                      {row.successRateLabel}
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )
                }
              />
              <MobileBreakdownFact
                label="Avg Duration"
                value={row.avgDurationLabel}
              />
            </MobileBreakdownRow>
          ))}
        </div>
        <Table className="cl-desktop-table">
          <TableHeader>
            <TableRow>
              <TableHead>Agent Type</TableHead>
              <TableHead className="text-right">Count</TableHead>
              <TableHead className="text-right">Success</TableHead>
              <TableHead className="text-right">Failed</TableHead>
              <TableHead className="text-right">Success Rate</TableHead>
              <TableHead className="text-right">Avg Duration</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.agentType}>
                <TableCell className="font-medium">{row.agentType}</TableCell>
                <TableCell className="text-right">{row.count}</TableCell>
                <TableCell className="text-right">
                  <span className="text-success">{row.successCount}</span>
                </TableCell>
                <TableCell className="text-right">
                  {row.failedCount === "0" ? (
                    <span className="text-muted-foreground">0</span>
                  ) : (
                    <span className="text-destructive">{row.failedCount}</span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {row.successRateLabel ? (
                    <Badge className="text-xs" variant={row.successRateVariant}>
                      {row.successRateLabel}
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </TableCell>
                <TableCell className="text-right font-mono text-sm">
                  {row.avgDurationLabel}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/**
 * Shared analytics tables for repository and project session activity.
 */
export function MonitoringRepositoryBreakdown({
  repositoryRows,
  projectRows,
}: Readonly<{
  repositoryRows: MonitoringRepositoryRow[];
  projectRows: MonitoringProjectRow[];
}>) {
  if (repositoryRows.length === 0 && projectRows.length === 0) {
    return null;
  }

  return (
    <div className="grid gap-6 xl:grid-cols-2">
      {repositoryRows.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FolderGit2Icon className="h-4 w-4" />
              By Repository
            </CardTitle>
            <CardDescription>
              Agent session activity by git repository.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="cl-mobile-only space-y-3">
              {repositoryRows.map((row) => (
                <MobileBreakdownRow
                  key={row.repositoryFullName}
                  title={row.repositoryFullName}
                >
                  <MobileBreakdownFact
                    label="Sessions"
                    value={row.sessionCount}
                  />
                  <MobileBreakdownFact label="Tokens" value={row.tokenCount} />
                  <MobileBreakdownFact label="Cost" value={row.cost} />
                  <MobileBreakdownFact
                    label="Errors"
                    value={
                      row.hasErrors ? (
                        <span className="text-destructive">
                          {row.errorCount}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">0</span>
                      )
                    }
                  />
                </MobileBreakdownRow>
              ))}
            </div>
            <Table className="cl-desktop-table">
              <TableHeader>
                <TableRow>
                  <TableHead>Repository</TableHead>
                  <TableHead className="text-right">Sessions</TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="text-right">Errors</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {repositoryRows.map((row) => (
                  <TableRow key={row.repositoryFullName}>
                    <TableCell className="max-w-[200px] truncate font-medium">
                      {row.repositoryFullName}
                    </TableCell>
                    <TableCell className="text-right">
                      {row.sessionCount}
                    </TableCell>
                    <TableCell className="text-right">
                      {row.tokenCount}
                    </TableCell>
                    <TableCell className="text-right">{row.cost}</TableCell>
                    <TableCell className="text-right">
                      {row.hasErrors ? (
                        <span className="text-destructive">
                          {row.errorCount}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">0</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      {projectRows.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FolderKanbanIcon className="h-4 w-4" />
              By Project
            </CardTitle>
            <CardDescription>
              Agent session activity by project.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="cl-mobile-only space-y-3">
              {projectRows.map((row) => (
                <MobileBreakdownRow key={row.projectId} title={row.projectName}>
                  <MobileBreakdownFact
                    label="Sessions"
                    value={row.sessionCount}
                  />
                  <MobileBreakdownFact label="Tokens" value={row.tokenCount} />
                  <MobileBreakdownFact label="Cost" value={row.cost} />
                </MobileBreakdownRow>
              ))}
            </div>
            <Table className="cl-desktop-table">
              <TableHeader>
                <TableRow>
                  <TableHead>Project</TableHead>
                  <TableHead className="text-right">Sessions</TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {projectRows.map((row) => (
                  <TableRow key={row.projectId}>
                    <TableCell className="max-w-[200px] truncate font-medium">
                      {row.projectName}
                    </TableCell>
                    <TableCell className="text-right">
                      {row.sessionCount}
                    </TableCell>
                    <TableCell className="text-right">
                      {row.tokenCount}
                    </TableCell>
                    <TableCell className="text-right">{row.cost}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

/**
 * Shared analytics table for tool reliability breakdowns.
 */
export function MonitoringToolUsageTable({
  rows,
  totalInvocationsLabel,
}: Readonly<{
  rows: MonitoringToolUsageRow[];
  totalInvocationsLabel: string;
}>) {
  if (rows.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <WrenchIcon className="h-4 w-4" />
          Tool Reliability
        </CardTitle>
        <CardDescription>
          Error and usage breakdown across {totalInvocationsLabel} tool
          invocations.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="cl-mobile-only space-y-3">
          {rows.map((row) => (
            <MobileBreakdownRow key={row.toolName} title={row.toolName}>
              <MobileBreakdownFact
                label="Invocations"
                value={row.invocationCount}
              />
              <MobileBreakdownFact
                label="Errors"
                value={
                  row.hasErrors ? (
                    <span className="text-destructive">{row.errorCount}</span>
                  ) : (
                    <span className="text-muted-foreground">0</span>
                  )
                }
              />
              <MobileBreakdownFact label="Sessions" value={row.sessionCount} />
              <MobileBreakdownFact
                label="Error Rate"
                value={
                  row.errorRateLabel ? (
                    <Badge className="text-xs" variant={row.errorRateVariant}>
                      {row.errorRateLabel}
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )
                }
              />
            </MobileBreakdownRow>
          ))}
        </div>
        <Table className="cl-desktop-table">
          <TableHeader>
            <TableRow>
              <TableHead>Tool</TableHead>
              <TableHead className="text-right">Invocations</TableHead>
              <TableHead className="text-right">Errors</TableHead>
              <TableHead className="text-right">Sessions</TableHead>
              <TableHead className="text-right">Error Rate</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.toolName}>
                <TableCell className="font-medium">{row.toolName}</TableCell>
                <TableCell className="text-right">
                  {row.invocationCount}
                </TableCell>
                <TableCell className="text-right">
                  {row.hasErrors ? (
                    <span className="text-destructive">{row.errorCount}</span>
                  ) : (
                    <span className="text-muted-foreground">0</span>
                  )}
                </TableCell>
                <TableCell className="text-right">{row.sessionCount}</TableCell>
                <TableCell className="text-right">
                  {row.errorRateLabel ? (
                    <Badge className="text-xs" variant={row.errorRateVariant}>
                      {row.errorRateLabel}
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/**
 * Mobile presentation shell shared by analytics breakdown card rows.
 */
export function MobileBreakdownRow({
  children,
  title,
}: Readonly<{
  title: string;
  children: ReactNode;
}>) {
  return (
    <article className="rounded-md border p-3">
      <div className="mb-3 break-words font-medium">{title}</div>
      <dl className="space-y-2 text-sm">{children}</dl>
    </article>
  );
}

/**
 * Mobile label/value pair shared by analytics breakdown card rows.
 */
export function MobileBreakdownFact({
  label,
  value,
}: Readonly<{
  label: string;
  value: ReactNode;
}>) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  );
}
