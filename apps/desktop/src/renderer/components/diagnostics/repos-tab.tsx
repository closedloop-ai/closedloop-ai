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
import type { DiagnosticsRepoRow } from "../../../shared/diagnostics-contract";

type ReposTabProps = {
  repos: DiagnosticsRepoRow[];
};

export function ReposTab({ repos }: ReposTabProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Repo Registry
          {repos.length > 0 && (
            <Badge className="ml-2" variant="secondary">
              {repos.length}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {repos.length === 0 ? (
          <p className="py-8 text-center text-[var(--muted-foreground)] text-sm">
            No repos discovered
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Repo</TableHead>
                <TableHead>Git Dir</TableHead>
                <TableHead>Default Branch</TableHead>
                <TableHead className="text-right">Worktrees</TableHead>
                <TableHead>Last Seen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {repos.map((repo) => (
                <TableRow key={repo.id}>
                  <TableCell className="font-medium">
                    {repo.repoFullName ?? repo.remoteUrl ?? "—"}
                  </TableCell>
                  <TableCell
                    className="max-w-[250px] truncate font-mono text-xs"
                    title={repo.gitDir}
                  >
                    {repo.gitDir}
                  </TableCell>
                  <TableCell>{repo.defaultBranch ?? "—"}</TableCell>
                  <TableCell className="text-right">
                    <Badge variant="secondary">{repo.worktreeCount}</Badge>
                  </TableCell>
                  <TableCell className="text-[var(--muted-foreground)] text-xs">
                    {repo.lastSeenAt}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
