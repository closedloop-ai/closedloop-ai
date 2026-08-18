"use client";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { FilterChip } from "@repo/design-system/components/ui/filter-chip";
import {
  GridTable,
  type GridTableColumn,
} from "@repo/design-system/components/ui/grid-table";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@repo/design-system/components/ui/popover";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@repo/design-system/components/ui/sidebar";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import { cn } from "@repo/design-system/lib/utils";
import { GithubIcon, MailIcon, RotateCcwIcon } from "lucide-react";
import { useMemo, useState } from "react";
import {
  AuthMethod,
  type AuthMethod as AuthMethodType,
  currentUserName,
  DATE_RANGE_LOOKBACK_DAYS,
  DataSyncLevel,
  type DateRange,
  DEFAULT_DATE_RANGE,
  githubMetricsByRange,
  type TeamSession,
  teamSessions,
} from "../mock";
import { InviteAnnouncementContent } from "./invite-announcement";
import { InviteDialog } from "./invite-dialog";
import { SessionsSidebar } from "./sessions-sidebar";
import { SessionsToolbar } from "./sessions-toolbar";
import { SyncStatus } from "./sync-status";

// Step 5 — the user lands on the Sessions page, laid out like the production
// desktop app: a left sidebar (nav + "Invite your team" footer item + account
// menu), a date-range / Filter / View toolbar, and the sessions table. Because
// they are now authenticated they see every teammate's sessions and the agentic
// components each is using. The arrival pop-up (anchored to the sidebar's invite
// item) invites the rest of the team, and whether the GitHub-dependent tiles are
// populated or show the empty state is fixed by how they signed in — resolved
// silently in the background before this page mounts. The demo toggle only
// exists so a reviewer can preview both resolved states.
type SessionsPageProps = {
  authMethod: AuthMethodType;
  onAuthMethodChange: (method: AuthMethodType) => void;
  onRestart: () => void;
  workspaceName: string;
  // The level committed in the takeover, so the page can acknowledge the sync it
  // just authorized (a progress bar for a syncing level, an "off" note for Off).
  // Null in the takeover backdrop, where no choice has been made yet.
  syncLevel?: DataSyncLevel | null;
  // Backdrop mode: the same page rendered dimmed behind the sync takeover so
  // the app never feels like it went away. Suppresses the auto-opening arrival
  // pop-up and the prototype-only affordances so the illusion reads as product.
  preview?: boolean;
};

export const SessionsPage = ({
  authMethod,
  onAuthMethodChange,
  onRestart,
  workspaceName,
  syncLevel = null,
  preview = false,
}: SessionsPageProps) => {
  const [announceOpen, setAnnounceOpen] = useState(!preview);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [dateRange, setDateRange] = useState<DateRange>(DEFAULT_DATE_RANGE);
  const [selectedComponents, setSelectedComponents] = useState<Set<string>>(
    () => new Set()
  );
  const [visibleColumns, setVisibleColumns] = useState<Set<string>>(
    () => new Set(ALL_COLUMN_IDS)
  );
  const githubConnected = authMethod === AuthMethod.GitHub;
  // Off = no cloud connection, so the destination must show only this user's
  // local sessions (no teammates) and no cloud metrics — otherwise it would
  // contradict the "nothing leaves this device" consent it just collected.
  const localOnly = syncLevel === DataSyncLevel.Off;

  const componentOptions = useMemo(
    () => [...new Set(teamSessions.map((session) => session.component))],
    []
  );

  const rows = useMemo(() => {
    const lookback = DATE_RANGE_LOOKBACK_DAYS[dateRange];
    return teamSessions.filter(
      (session) =>
        session.daysAgo <= lookback &&
        (selectedComponents.size === 0 ||
          selectedComponents.has(session.component)) &&
        (!localOnly || session.author === currentUserName)
    );
  }, [dateRange, selectedComponents, localOnly]);

  const toggleComponent = (component: string) =>
    setSelectedComponents((current) => {
      const next = new Set(current);
      if (next.has(component)) {
        next.delete(component);
      } else {
        next.add(component);
      }
      return next;
    });

  const toggleColumn = (columnId: string) =>
    setVisibleColumns((current) => {
      const next = new Set(current);
      if (next.has(columnId)) {
        next.delete(columnId);
      } else {
        next.add(columnId);
      }
      return next;
    });

  return (
    <SidebarProvider className="h-svh">
      <SessionsSidebar
        announceOpen={announceOpen}
        onAnnounceInvite={() => {
          setAnnounceOpen(false);
          setInviteOpen(true);
        }}
        onAnnounceOpenChange={setAnnounceOpen}
        onOpenInvite={() => setInviteOpen(true)}
        showAnnouncement={!preview}
        workspaceName={workspaceName}
      />
      <SidebarInset className="min-w-0 overflow-hidden">
        <SessionsTopbar
          announceOpen={announceOpen}
          onAnnounceInvite={() => {
            setAnnounceOpen(false);
            setInviteOpen(true);
          }}
          onAnnounceOpenChange={setAnnounceOpen}
          showAnnouncement={!preview}
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6 md:p-10">
            {/* Prototype-only controls — not part of the product screen. The
                real app resolves the sign-in method silently in the background;
                this only lets a reviewer preview both resolved states and replay
                the flow. */}
            {preview ? null : (
              <div className="flex flex-col gap-2 rounded-lg border border-border border-dashed bg-muted/20 p-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-muted-foreground text-xs leading-relaxed">
                  Prototype control — preview how Sessions renders based on how
                  the user authenticated.
                </p>
                <div className="flex shrink-0 items-center gap-2">
                  <ToggleGroup
                    aria-label="Preview sign-in method"
                    onValueChange={(value) => {
                      if (value) {
                        onAuthMethodChange(value as AuthMethodType);
                      }
                    }}
                    size="sm"
                    type="single"
                    value={authMethod}
                    variant="outline"
                  >
                    <ToggleGroupItem value={AuthMethod.GitHub}>
                      <GithubIcon />
                      GitHub
                    </ToggleGroupItem>
                    <ToggleGroupItem value={AuthMethod.Email}>
                      <MailIcon />
                      Email
                    </ToggleGroupItem>
                  </ToggleGroup>
                  <Button onClick={onRestart} size="sm" variant="ghost">
                    <RotateCcwIcon />
                    Restart flow
                  </Button>
                </div>
              </div>
            )}

            {/* Acknowledge the sync just authorized in the takeover: a progress
                bar for a syncing level, an honest "off" note for Off. Suppressed
                in the backdrop preview (no choice made there yet). */}
            {!preview && syncLevel ? (
              <SyncStatus level={syncLevel} workspaceName={workspaceName} />
            ) : null}

            {/* GitHub metrics are cloud data — hidden entirely when cloud sync
                is Off (local only), since none of it would be available. The
                single Connect GitHub ask lives in the banner; the empty tiles
                carry their own reason caption rather than repeating the CTA. */}
            {localOnly ? null : (
              <>
                {githubConnected ? null : (
                  <Alert>
                    <AlertTitle>
                      Connect GitHub to complete your metrics
                    </AlertTitle>
                    <AlertDescription>
                      You signed in without GitHub, so merged-PR and
                      code-throughput metrics stay empty until you connect it.
                      <Button
                        className="mt-2"
                        onClick={() => onAuthMethodChange(AuthMethod.GitHub)}
                        size="sm"
                        variant="outline"
                      >
                        <GithubIcon />
                        Connect GitHub
                      </Button>
                    </AlertDescription>
                  </Alert>
                )}

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {githubMetricsByRange[dateRange].map((metric) =>
                    githubConnected ? (
                      <MetricCard
                        delta={metric.delta}
                        deltaLabel="vs. prior period"
                        deltaPolarity={metric.deltaPolarity}
                        key={metric.key}
                        label={metric.label}
                        value={metric.value}
                      />
                    ) : (
                      <MetricCard
                        detail="Requires GitHub"
                        key={metric.key}
                        label={metric.label}
                        value={null}
                        valueUnavailable
                      />
                    )
                  )}
                </div>
              </>
            )}

            <div className="flex flex-col gap-3">
              <SessionsToolbar
                columns={SESSION_COLUMN_DEFS.map((column) => ({
                  id: column.id,
                  label: column.label,
                  visible: visibleColumns.has(column.id),
                }))}
                componentOptions={componentOptions}
                dateRange={dateRange}
                onClearComponents={() => setSelectedComponents(new Set())}
                onDateRangeChange={setDateRange}
                onResetView={() => setVisibleColumns(new Set(ALL_COLUMN_IDS))}
                onToggleColumn={toggleColumn}
                onToggleComponent={toggleComponent}
                selectedComponents={selectedComponents}
              />
              {/* Active-filter chip row (mirrors prod's SessionsActiveFiltersBar):
                  a narrowed table that only shows a "1" on the button reads as
                  broken data, so name each active selection with a removable
                  chip. */}
              {selectedComponents.size > 0 ? (
                <div className="flex flex-wrap items-center gap-2">
                  {[...selectedComponents].map((component) => (
                    <FilterChip
                      key={component}
                      label={`Component: ${component}`}
                      onRemove={() => toggleComponent(component)}
                    />
                  ))}
                  <Button
                    className="h-auto p-0 text-muted-foreground text-xs"
                    onClick={() => setSelectedComponents(new Set())}
                    variant="link"
                  >
                    Clear all
                  </Button>
                </div>
              ) : null}
              <SessionsTable rows={rows} visibleColumns={visibleColumns} />
            </div>
          </div>
        </div>
      </SidebarInset>

      <InviteDialog
        onOpenChange={setInviteOpen}
        open={inviteOpen}
        workspaceName={workspaceName}
      />
    </SidebarProvider>
  );
};

// The topbar (sidebar toggle + page name). On mobile it also owns the Card #5
// arrival pop-up: the sidebar (and its "Invite your team" item) is offcanvas at
// <768px, so the pop-up anchors to the always-visible menu trigger here instead
// — otherwise it would attach to an off-screen element and never appear. On
// desktop the sidebar item is the anchor, so the trigger renders plainly.
const SessionsTopbar = ({
  showAnnouncement,
  announceOpen,
  onAnnounceOpenChange,
  onAnnounceInvite,
}: {
  showAnnouncement: boolean;
  announceOpen: boolean;
  onAnnounceOpenChange: (open: boolean) => void;
  onAnnounceInvite: () => void;
}) => {
  const { isMobile } = useSidebar();
  const anchorHere = showAnnouncement && isMobile;
  const trigger = (
    <SidebarTrigger
      className={cn(
        "text-muted-foreground",
        anchorHere && announceOpen && "ring-2 ring-primary/50 ring-offset-1"
      )}
    />
  );
  return (
    <header className="flex h-[42px] shrink-0 items-center gap-3 border-border border-b bg-background px-3">
      {anchorHere ? (
        <Popover onOpenChange={onAnnounceOpenChange} open={announceOpen}>
          <PopoverAnchor asChild>{trigger}</PopoverAnchor>
          <PopoverContent
            align="start"
            className="w-80"
            side="bottom"
            sideOffset={8}
          >
            <InviteAnnouncementContent
              onDismiss={() => onAnnounceOpenChange(false)}
              onInvite={onAnnounceInvite}
            />
          </PopoverContent>
        </Popover>
      ) : (
        trigger
      )}
      <span className="text-sm">Sessions</span>
    </header>
  );
};

// Composed from the catalog GridTable so row height, hover, header semantics,
// and the responsive treatment come from the system and match the real
// Sessions page (same pattern as the desktop-onboarding-landing prototype).
// The leading "Session" column is always shown; the rest are toggleable from
// the View menu, which is why their tracks are assembled from the visible set.
const SESSION_COLUMN_DEFS = [
  { id: "author", label: "Teammate", track: "minmax(140px,1fr)" },
  { id: "component", label: "Component", track: "150px" },
  { id: "cost", label: "Cost", track: "100px" },
  { id: "efficiency", label: "Efficiency", track: "120px" },
] as const;

const LEADING_TRACK = "minmax(220px,1.6fr)";

const ALL_COLUMN_IDS: readonly string[] = SESSION_COLUMN_DEFS.map(
  (column) => column.id
);

const renderSessionCell = (columnId: string, session: TeamSession) => {
  switch (columnId) {
    case "author":
      return (
        <span className="truncate text-muted-foreground text-sm">
          {session.author}
        </span>
      );
    case "component":
      return <Badge variant="outline">{session.component}</Badge>;
    case "cost":
      return <span className="text-sm tabular-nums">{session.cost}</span>;
    case "efficiency":
      return (
        <span className="text-muted-foreground text-sm">
          {session.efficiency}
        </span>
      );
    default:
      return null;
  }
};

const SessionsTable = ({
  rows,
  visibleColumns,
}: {
  rows: readonly TeamSession[];
  visibleColumns: ReadonlySet<string>;
}) => {
  const activeColumns = SESSION_COLUMN_DEFS.filter((column) =>
    visibleColumns.has(column.id)
  );
  const columns: GridTableColumn[] = activeColumns.map((column) => ({
    id: column.id,
    label: column.label,
  }));
  const gridTemplateColumns = [
    LEADING_TRACK,
    ...activeColumns.map((column) => column.track),
  ].join(" ");

  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardHeader className="border-b py-5">
        <CardTitle>Recent sessions</CardTitle>
      </CardHeader>
      {rows.length === 0 ? (
        <p className="px-6 py-10 text-center text-muted-foreground text-sm">
          No sessions match these filters.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <GridTable
            columns={columns}
            getRowId={(session) => session.id}
            gridTemplateColumns={gridTemplateColumns}
            items={[...rows]}
            leadingLabel="Session"
            renderCell={renderSessionCell}
            renderLead={(session) => (
              <span className="truncate font-medium text-sm">
                {session.title}
              </span>
            )}
          />
        </div>
      )}
    </Card>
  );
};
