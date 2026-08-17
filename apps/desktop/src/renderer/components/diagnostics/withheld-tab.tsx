import { formatDateTimeOrFallback } from "@repo/app/shared/lib/date-utils";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@closedloop-ai/design-system/components/ui/alert";
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
  DiagnosticsWithheldRow,
  DiagnosticsWithheldScan,
} from "../../../shared/diagnostics-contract";

type WithheldTabProps = {
  /**
   * ISS-5266. `undefined` is a THIRD state, not a spelling of empty: a payload
   * from a build that predates this field carries no withhold information at
   * all, and answering "nothing is withheld" there would be exactly the false
   * reassurance this tab exists to remove.
   */
  withheld: DiagnosticsWithheldRow[] | undefined;
  /**
   * ISS-5266. The stores that have completed a full scan.
   *
   * Without this, an empty `withheld` is ambiguous three ways: nothing was
   * withheld, nothing has been imported, or a reconcile failed. Only the first
   * means complete, and claiming it for all three is precisely the overclaim
   * this tab exists to remove. `undefined` is the same third state as above (a
   * producer that cannot report scans), and an EMPTY array is the real answer
   * "no store has reported yet", which is unknown, not complete.
   */
  scans: DiagnosticsWithheldScan[] | undefined;
};

const TITLE_ID = "withheld-subagents-title";

/** Rendered wherever a count is not known, so it can never read as a zero. */
const UNAVAILABLE = "Unavailable";

/** Rendered wherever an instant is not known. */
const UNKNOWN = "Unknown";

/**
 * Add one row's counter into a running total, keeping UNAVAILABLE absorbing.
 *
 * This is the SECOND aggregation layer (the collector's per-subtree sum is the
 * first), and it needs the same overflow check: a total that leaves the JS-safe
 * integer range is no longer the sum, and rendering the rounded result under a
 * label that claims an exact shortfall would be the precise failure this tab
 * exists to remove.
 */
function addTotal(current: number | null, delta: number | null): number | null {
  if (current === null || delta === null) {
    return null;
  }
  const next = current + delta;
  return Number.isSafeInteger(next) ? next : null;
}

/**
 * ISS-5266. Totals across every withheld subtree, so the shortfall is stated
 * once as a number rather than left to be added up from the rows.
 *
 * Billable and cache tokens stay separate all the way to the surface: the
 * dashboard's headline total is `SUM(input) + SUM(output)`, so only the billable
 * figure can be quoted as the amount that total is short by.
 */
function totals(withheld: readonly DiagnosticsWithheldRow[]): {
  sessions: number;
  tokens: number | null;
  cacheTokens: number | null;
} {
  let sessions = 0;
  let tokens: number | null = 0;
  let cacheTokens: number | null = 0;
  for (const row of withheld) {
    sessions += row.withheldCount;
    tokens = addTotal(tokens, row.withheldTokens);
    cacheTokens = addTotal(cacheTokens, row.withheldCacheTokens);
  }
  return { sessions, tokens, cacheTokens };
}

/** A token count, or an explicit unavailable. Never a stand-in zero. */
function formatTokens(value: number | null): string {
  if (value === null) {
    return UNAVAILABLE;
  }
  return value.toLocaleString();
}

/**
 * The affected window, or an explicit unknown.
 *
 * A withheld child can carry no timestamp, and a dash there would read as an
 * instant-long window. Say "Unknown" instead: the whole point of this tab is
 * that an absence never gets rendered as a value. A HALF-known window keeps the
 * end it does know rather than collapsing the whole thing to unknown.
 */
function formatWindow(row: DiagnosticsWithheldRow): string {
  if (row.earliestChildStartedAt === null && row.latestChildEndedAt === null) {
    return UNKNOWN;
  }
  const from = formatDateTimeOrFallback(row.earliestChildStartedAt, {
    fallback: UNKNOWN,
  });
  const to = formatDateTimeOrFallback(row.latestChildEndedAt, {
    fallback: UNKNOWN,
  });
  return `${from} to ${to}`;
}

/** The headline: what is missing, and how much of it. */
function headline(sessions: number, tokens: number | null): string {
  const plural = sessions === 1 ? "" : "s";
  if (tokens === null) {
    return `${sessions} subagent session${plural} withheld, token total unavailable`;
  }
  return `${sessions} subagent session${plural} withheld, ${tokens.toLocaleString()} tokens missing`;
}

/**
 * The cache sentence. Session and period totals do not count cache tokens, so
 * the cache shortfall is stated on its own basis instead of being folded into a
 * single figure that reconciles against neither.
 */
function cacheNote(cacheTokens: number | null): string {
  if (cacheTokens === null) {
    return "The cache token total for these sessions is unavailable.";
  }
  return `A further ${cacheTokens.toLocaleString()} cache tokens are missing from cache figures, which session totals do not count.`;
}

/**
 * Where the totals come from, and how current they are.
 *
 * The totals sum every row regardless of store, so a store that has stopped
 * being read still contributes to a number the reader takes as the CURRENT gap.
 * Rather than invent a staleness cutoff, this states the provenance: how many
 * stores are in the number, when the least-recently-scanned of them last
 * reported, and whether any of them has no scan verdict at all, which is the
 * case where a claim has outlived the store that made it.
 */
function coverageNote(
  withheld: readonly DiagnosticsWithheldRow[],
  scans: readonly DiagnosticsWithheldScan[]
): string {
  const scannedAt = new Map(
    scans.map((scan) => [scan.sourcePath, scan.observedAt])
  );
  const stores = new Set(withheld.map((row) => row.sourcePath));
  const instants: string[] = [];
  let unscanned = 0;
  for (const store of stores) {
    const observedAt = scannedAt.get(store);
    if (observedAt === undefined) {
      unscanned += 1;
    } else {
      instants.push(observedAt);
    }
  }
  const plural = stores.size === 1 ? "" : "s";
  const oldest =
    instants.length > 0
      ? instants.reduce((a, b) => (b < a ? b : a))
      : undefined;
  const coverage =
    oldest === undefined
      ? `Totals cover ${stores.size} store${plural}.`
      : `Totals cover ${stores.size} store${plural}, the least recently scanned on ${formatDateTimeOrFallback(oldest, { fallback: UNKNOWN })}.`;
  if (unscanned === 0) {
    return coverage;
  }
  const staleplural = unscanned === 1 ? " has" : "s have";
  return `${coverage} ${unscanned} of them${staleplural} not reported a scan, so that part of the total may be out of date.`;
}

function WithheldBody({
  withheld,
  scans,
}: {
  withheld: DiagnosticsWithheldRow[];
  scans: DiagnosticsWithheldScan[];
}) {
  const { sessions, tokens, cacheTokens } = totals(withheld);
  return (
    <div className="space-y-4">
      <Alert variant="warning">
        <AlertTitle>{headline(sessions, tokens)}</AlertTitle>
        <AlertDescription>
          Their parent session failed to parse, so they could not be imported.
          Session and period totals are short by that much, not zero.{" "}
          {cacheNote(cacheTokens)} {coverageNote(withheld, scans)}
        </AlertDescription>
      </Alert>
      <Table>
        <caption className="sr-only">
          OpenCode subagent sessions withheld from import, by parent session
        </caption>
        <TableHeader>
          <TableRow>
            <TableHead>Parent session</TableHead>
            <TableHead>Store</TableHead>
            <TableHead className="text-right">Sessions</TableHead>
            <TableHead className="text-right">Tokens</TableHead>
            <TableHead className="text-right">Cache</TableHead>
            <TableHead>Period affected</TableHead>
            <TableHead>Reason</TableHead>
            <TableHead>Last seen</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {withheld.map((row) => (
            <TableRow key={`${row.sourcePath}\u0000${row.rootRawId}`}>
              <TableCell
                className="max-w-[200px] truncate font-mono text-xs"
                title={row.rootRawId}
              >
                {row.rootRawId}
              </TableCell>
              <TableCell
                className="max-w-[200px] truncate font-mono text-xs"
                title={row.sourcePath}
              >
                {row.sourcePath}
              </TableCell>
              <TableCell className="text-right font-medium tabular-nums">
                {row.withheldCount}
              </TableCell>
              <TableCell className="text-right font-medium tabular-nums">
                {formatTokens(row.withheldTokens)}
              </TableCell>
              <TableCell className="text-right font-medium tabular-nums">
                {formatTokens(row.withheldCacheTokens)}
              </TableCell>
              <TableCell className="max-w-[220px] text-xs">
                <span className="block truncate">{formatWindow(row)}</span>
                {row.windowPartial && (
                  <span className="block text-[var(--muted-foreground)]">
                    Possibly wider
                  </span>
                )}
              </TableCell>
              <TableCell
                className="max-w-[250px] truncate text-[var(--muted-foreground)] text-xs"
                title={row.reason}
              >
                {row.reason}
              </TableCell>
              <TableCell className="whitespace-nowrap text-[var(--muted-foreground)] text-xs">
                {formatDateTimeOrFallback(row.observedAt, {
                  fallback: UNKNOWN,
                })}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * The COMPLETE state, and deliberately the quiet one: nothing is owed to the
 * reader when there is nothing missing.
 *
 * Reached only when at least one store has a SCAN VERDICT, so "nothing is
 * withheld" is something the record actually proves rather than an absence of
 * information. The claim is still kept narrow, and the second line names what
 * the tab does not cover: a root that failed to parse but carried no subagents
 * never reaches the withhold record at all, so this screen cannot speak to it.
 */
function WithheldNone({ scans }: { scans: DiagnosticsWithheldScan[] }) {
  const plural = scans.length === 1 ? "" : "s";
  return (
    <div className="space-y-2 py-8 text-center">
      <p className="text-[var(--muted-foreground)] text-sm">
        No subagent sessions are currently withheld across {scans.length}{" "}
        scanned store{plural}.
      </p>
      <p className="text-[var(--muted-foreground)] text-xs">
        This covers subagents withheld because their parent failed to parse. It
        does not cover a parent that failed to parse with no subagents under it.
      </p>
    </div>
  );
}

/**
 * The NOT-YET-SCANNED state.
 *
 * An empty withhold set with no scan verdict behind it proves nothing: the
 * store may be whole, may never have been imported, or may have failed its
 * reconcile. Rendering that as "complete" is the exact false reassurance this
 * tab exists to remove, so it gets the unknown treatment instead.
 */
function WithheldNotScanned() {
  return (
    <Alert variant="warning">
      <AlertTitle>No OpenCode store has reported yet</AlertTitle>
      <AlertDescription>
        Nothing has completed a scan, so whether any sessions are withheld is
        unknown. That is not the same as none being withheld.
      </AlertDescription>
    </Alert>
  );
}

/**
 * The UNKNOWN state, which must never be mistaken for the complete one — that
 * confusion is the whole defect this tab exists to remove, so it gets its own
 * alert rather than the same muted paragraph.
 */
function WithheldUnavailable() {
  return (
    <Alert variant="warning">
      <AlertTitle>Withheld data unavailable</AlertTitle>
      <AlertDescription>
        This build cannot report withheld sessions, so whether any are missing
        is unknown. That is not the same as none being withheld.
      </AlertDescription>
    </Alert>
  );
}

function renderBody(
  withheld: DiagnosticsWithheldRow[] | undefined,
  scans: DiagnosticsWithheldScan[] | undefined
): React.ReactNode {
  if (withheld === undefined || scans === undefined) {
    return <WithheldUnavailable />;
  }
  if (withheld.length === 0) {
    // An empty set only means COMPLETE when a scan actually proved it. With no
    // verdict behind it, the honest answer is that nothing has reported yet.
    if (scans.length === 0) {
      return <WithheldNotScanned />;
    }
    return <WithheldNone scans={scans} />;
  }
  return <WithheldBody scans={scans} withheld={withheld} />;
}

export function WithheldTab({ withheld, scans }: WithheldTabProps) {
  const count = withheld?.length ?? 0;
  return (
    <Card aria-labelledby={TITLE_ID} role="region">
      <CardHeader>
        <CardTitle id={TITLE_ID}>
          Withheld OpenCode Subagents
          {count > 0 && (
            <Badge className="ml-2" variant="secondary">
              {count}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>{renderBody(withheld, scans)}</CardContent>
    </Card>
  );
}
