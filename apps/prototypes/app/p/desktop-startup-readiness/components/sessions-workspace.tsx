import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import { FilterIcon, SearchIcon, SlidersHorizontalIcon } from "lucide-react";
import { type StartupFixture, sessionRows } from "../mock";

const skeletonRowIds = [
  "saved-session-1",
  "saved-session-2",
  "saved-session-3",
  "saved-session-4",
  "saved-session-5",
  "saved-session-6",
] as const;

export function SessionsWorkspace({ fixture }: { fixture: StartupFixture }) {
  const showSavedData = fixture.savedSessionCount !== undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div className="relative min-w-56 flex-1 md:max-w-sm">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search sessions"
            className="pl-9"
            placeholder="Search sessions"
          />
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" type="button" variant="outline">
            <FilterIcon />
            Filter
          </Button>
          <Button
            aria-label="Choose columns"
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <SlidersHorizontalIcon />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <SummaryStrip fixture={fixture} loading={!showSavedData} />
        {showSavedData ? <SessionsTable /> : <SessionsSkeleton />}
      </div>
      <footer className="flex items-center justify-between border-t px-4 py-3 text-muted-foreground text-sm">
        {showSavedData ? (
          <>
            <span>Showing recent sessions</span>
            <span className="tabular-nums">
              1–5 of {fixture.savedSessionCount?.toLocaleString()}
            </span>
          </>
        ) : (
          <span>
            Saved sessions will appear here as soon as the local store opens.
          </span>
        )}
      </footer>
    </div>
  );
}

function SummaryStrip({
  fixture,
  loading,
}: {
  fixture: StartupFixture;
  loading: boolean;
}) {
  const values = [
    {
      label: "Sessions",
      value: fixture.savedSessionCount?.toLocaleString() ?? "—",
    },
    { label: "Active now", value: "1" },
    { label: "Harnesses", value: "5" },
    { label: "Last local check", value: "just now" },
  ];
  return (
    <dl className="grid grid-cols-2 border-b md:grid-cols-4 md:divide-x">
      {values.map((item) => (
        <div className="px-4 py-3" key={item.label}>
          <dt className="text-muted-foreground text-xs">{item.label}</dt>
          <dd className="mt-1 font-medium text-lg tabular-nums">
            {loading ? <Skeleton className="h-6 w-16" /> : item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function SessionsTable() {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-4">Session</TableHead>
          <TableHead>Harness</TableHead>
          <TableHead>Repository</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="pr-4 text-right">Last activity</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sessionRows.map((session) => (
          <TableRow key={session.id}>
            <TableCell className="pl-4 font-medium">{session.name}</TableCell>
            <TableCell>{session.harness}</TableCell>
            <TableCell className="text-muted-foreground">
              {session.repository}
            </TableCell>
            <TableCell>
              <Badge variant={session.status === "Active" ? "info" : "success"}>
                {session.status}
              </Badge>
            </TableCell>
            <TableCell className="pr-4 text-right text-muted-foreground">
              {session.lastActivity}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function SessionsSkeleton() {
  return (
    <div
      aria-label="Loading saved sessions"
      className="space-y-3 px-4 py-4"
      role="status"
    >
      {skeletonRowIds.map((rowId) => (
        <div className="flex items-center gap-6" key={rowId}>
          <Skeleton className="h-5 flex-1" />
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-5 w-20" />
        </div>
      ))}
    </div>
  );
}
