import { Badge } from "@closedloop-ai/design-system/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@closedloop-ai/design-system/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@closedloop-ai/design-system/components/ui/table";
import type {
  EnrichmentQueueRow,
  PendingArtifactRow,
  StalledArtifactRow,
} from "../../../shared/diagnostics-contract";

type EnrichmentTabProps = {
  enrichmentQueue: EnrichmentQueueRow[];
  pendingArtifacts: PendingArtifactRow[];
  stalledArtifacts: StalledArtifactRow[];
};

const STATE_LABELS: Record<string, string> = {
  pending: "Pending",
  provisional: "Provisional",
  final: "Final",
  not_applicable: "N/A",
};

const STATE_VARIANTS: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  pending: "destructive",
  provisional: "outline",
  final: "secondary",
  not_applicable: "default",
};

function stateLabel(state: string): string {
  return STATE_LABELS[state] ?? state;
}

function stateBadgeVariant(
  state: string
): "default" | "secondary" | "destructive" | "outline" {
  return STATE_VARIANTS[state] ?? "default";
}

function artifactRef(artifact: PendingArtifactRow): string {
  if (artifact.kind === "commit" && artifact.sha) {
    return artifact.sha.slice(0, 10);
  }
  if (artifact.kind === "branch" && artifact.branchName) {
    return artifact.branchName;
  }
  if (artifact.kind === "pull_request" && artifact.prNumber) {
    return `#${artifact.prNumber}`;
  }
  return artifact.identityKey;
}

export function EnrichmentTab({
  enrichmentQueue,
  pendingArtifacts,
  stalledArtifacts,
}: EnrichmentTabProps) {
  const kinds = [...new Set(enrichmentQueue.map((r) => r.kind))].sort();
  const states = [...new Set(enrichmentQueue.map((r) => r.state))].sort();

  const countMap = new Map<string, number>();
  for (const row of enrichmentQueue) {
    countMap.set(`${row.kind}:${row.state}`, row.count);
  }

  const kindTotals = new Map<string, number>();
  for (const row of enrichmentQueue) {
    kindTotals.set(row.kind, (kindTotals.get(row.kind) ?? 0) + row.count);
  }

  const safePending = pendingArtifacts ?? [];
  const leasedCount = safePending.filter((a) => a.leasedAt).length;
  const pendingNullCount = safePending.filter((a) => !a.enrichmentState).length;
  const provisionalCount = safePending.filter(
    (a) => a.enrichmentState === "provisional"
  ).length;
  const retriedCount = safePending.filter(
    (a) => a.enrichmentAttempts > 0
  ).length;
  const noGitDirCount = safePending.filter((a) => !a.gitDir).length;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Enrichment Queue</CardTitle>
        </CardHeader>
        <CardContent>
          {enrichmentQueue.length === 0 ? (
            <p className="py-8 text-center text-[var(--muted-foreground)] text-sm">
              No artifacts found
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Kind</TableHead>
                  {states.map((state) => (
                    <TableHead className="text-right" key={state}>
                      {stateLabel(state)}
                    </TableHead>
                  ))}
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {kinds.map((kind) => (
                  <TableRow key={kind}>
                    <TableCell className="font-medium">{kind}</TableCell>
                    {states.map((state) => {
                      const count = countMap.get(`${kind}:${state}`) ?? 0;
                      return (
                        <TableCell className="text-right" key={state}>
                          {count > 0 ? (
                            <Badge variant={stateBadgeVariant(state)}>
                              {count}
                            </Badge>
                          ) : (
                            <span className="text-[var(--muted-foreground)]">
                              0
                            </span>
                          )}
                        </TableCell>
                      );
                    })}
                    <TableCell className="text-right font-medium">
                      {kindTotals.get(kind) ?? 0}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            Pending Enrichment
            {safePending.length > 0 && (
              <Badge className="ml-2" variant="destructive">
                {safePending.length}
              </Badge>
            )}
          </CardTitle>
          {safePending.length > 0 && (
            <div className="flex flex-wrap gap-3 text-[var(--muted-foreground)] text-xs">
              <span>{pendingNullCount} new</span>
              <span>{provisionalCount} provisional</span>
              {leasedCount > 0 && <span>{leasedCount} in progress</span>}
              {retriedCount > 0 && (
                <span className="text-[var(--warning-foreground)]">
                  {retriedCount} retried
                </span>
              )}
              {noGitDirCount > 0 && (
                <span className="text-[var(--destructive)]">
                  {noGitDirCount} missing git_dir
                </span>
              )}
            </div>
          )}
        </CardHeader>
        <CardContent>
          {safePending.length === 0 ? (
            <p className="py-8 text-center text-[var(--muted-foreground)] text-sm">
              No pending artifacts — enrichment is caught up
            </p>
          ) : (
            <div className="max-h-[400px] overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Kind</TableHead>
                    <TableHead>Ref</TableHead>
                    <TableHead>Repo</TableHead>
                    <TableHead>git_dir</TableHead>
                    <TableHead className="text-right">Attempts</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {safePending.map((artifact) => (
                    <TableRow key={artifact.id}>
                      <TableCell>{artifact.kind}</TableCell>
                      <TableCell
                        className="max-w-[180px] truncate font-mono text-xs"
                        title={artifact.identityKey}
                      >
                        {artifactRef(artifact)}
                      </TableCell>
                      <TableCell className="max-w-[120px] truncate text-xs">
                        {artifact.repoFullName ?? "—"}
                      </TableCell>
                      <TableCell>
                        {artifact.gitDir ? (
                          <Badge variant="secondary">✓</Badge>
                        ) : (
                          <Badge variant="destructive">missing</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {artifact.enrichmentAttempts > 0 ? (
                          <Badge variant="outline">
                            {artifact.enrichmentAttempts}
                          </Badge>
                        ) : (
                          "0"
                        )}
                      </TableCell>
                      <TableCell>
                        {artifact.leasedAt ? (
                          <Badge variant="secondary">enriching…</Badge>
                        ) : (
                          <Badge
                            variant={stateBadgeVariant(
                              artifact.enrichmentState ?? "pending"
                            )}
                          >
                            {stateLabel(artifact.enrichmentState ?? "pending")}
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            Stalled Artifacts
            {stalledArtifacts.length > 0 && (
              <Badge className="ml-2" variant="destructive">
                {stalledArtifacts.length}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {stalledArtifacts.length === 0 ? (
            <p className="py-8 text-center text-[var(--muted-foreground)] text-sm">
              No stalled artifacts
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Kind</TableHead>
                  <TableHead>Identity Key</TableHead>
                  <TableHead>Repo</TableHead>
                  <TableHead className="text-right">Attempts</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Last Seen</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stalledArtifacts.map((artifact) => (
                  <TableRow key={artifact.id}>
                    <TableCell>{artifact.kind}</TableCell>
                    <TableCell
                      className="max-w-[200px] truncate font-mono text-xs"
                      title={artifact.identityKey}
                    >
                      {artifact.identityKey}
                    </TableCell>
                    <TableCell className="max-w-[150px] truncate">
                      {artifact.repoFullName ?? "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge variant="destructive">
                        {artifact.enrichmentAttempts}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={stateBadgeVariant(
                          artifact.enrichmentState ?? "pending"
                        )}
                      >
                        {stateLabel(artifact.enrichmentState ?? "pending")}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-[var(--muted-foreground)] text-xs">
                      {artifact.lastSeenAt}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
