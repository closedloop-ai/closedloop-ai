"use client";

import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import {
  GridTable,
  type GridTableColumn,
  type GridTableGroup,
} from "@repo/design-system/components/ui/grid-table";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { BlocksIcon, LayersIcon, TriangleAlertIcon } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import {
  groupMemberPacks,
  MemberPackGroup,
  type MemberPackRow,
} from "../lib/member-pack-groups";
import type { PackView } from "../lib/pack-view";
import { InstallSourceLabel } from "./install-source-label";
import { PackListRow } from "./pack-list-row";
import { PacksLoadFailed } from "./packs-load-failed";
import { PageSection } from "./page-section";
import { SourceStatusLine, StatusTone } from "./source-status-line";

// FEA-4089 — the member by-source treatment. The member surface is not a flat
// marketplace grid: it must tell an honest story about where each pack came
// from. Two regions: a primary "Your packs" table grouped by source (Required,
// then Installed), where every installed row carries its honest provenance
// label and a required-but-failed pack is a visible strand row (never a silent
// absence); and a secondary "Available" catalog list, demoted so discovery no
// longer outranks the packs the member already has. Install/uninstall dispatch
// is deferred to FEA-4071 / FEA-4082 — this slice is the treatment + source
// honesty.

const MEMBER_COLUMNS: readonly GridTableColumn[] = [
  { id: "version", label: "Version" },
  { id: "source", label: "Source" },
];

// Lead (name + publisher/description) + version + source. Source is wide enough
// for the labelled provenance text.
const MEMBER_GRID = "minmax(16rem,1fr) 7rem 16rem";

const renderLead = (pack: MemberPackRow) => (
  <div className="flex min-w-0 flex-col">
    <span className="truncate font-medium text-sm">{pack.name}</span>
    <span className="truncate text-muted-foreground text-xs">
      {pack.description
        ? `${pack.publisher} · ${pack.description}`
        : pack.publisher}
    </span>
  </div>
);

const SourceCell = ({ pack }: { pack: MemberPackRow }) => {
  // The honest strand: this pack is required, but the org push failed to
  // install it on this machine. Said with an icon + words (never color alone),
  // in the danger tone — the member sees the failure, not a silent absence.
  if (pack.installFailed) {
    return (
      <SourceStatusLine
        icon={TriangleAlertIcon}
        text="Required, install failed"
        tone={StatusTone.Danger}
      />
    );
  }
  // A resolved provenance renders through the shared FEA-4090 label (Required /
  // Auto-installed / Opted in / Self-installed), which says the strongest
  // truthful source once — a dual-source self+blessed pack resolves to a single
  // `opted-in` source upstream, so there is never a double badge here.
  if (pack.source) {
    return <InstallSourceLabel source={pack.source} />;
  }
  return <span className="text-muted-foreground text-sm">Not installed</span>;
};

const renderCell = (columnId: string, pack: MemberPackRow): ReactNode => {
  if (columnId === "version") {
    return (
      <span className="text-muted-foreground text-sm tabular-nums">
        {pack.version}
      </span>
    );
  }
  if (columnId === "source") {
    return <SourceCell pack={pack} />;
  }
  return null;
};

// The grouped-table skeleton mirrors the table's own row rhythm (lead + version
// + source) so a loading member view reads as "your packs table is coming
// here", not a generic block.
const GroupedSkeleton = () => (
  <div className="flex flex-col gap-3" data-testid="member-packs-skeleton">
    {[0, 1, 2, 3, 4].map((row) => (
      <div className="flex items-center gap-4" key={row}>
        <Skeleton className="h-9 flex-1" />
        <Skeleton className="h-9 w-16" />
        <Skeleton className="h-9 w-40" />
      </div>
    ))}
  </div>
);

// Empty treatment inside the primary section (not a page-level return) so the
// "Available" catalog it points the member to stays rendered — a member with no
// packs still sees the path forward.
const YourPacksEmpty = () => (
  <EmptyState
    description="Your org hasn't required any packs, and you haven't installed any yet. Browse the catalog below to add one."
    icon={BlocksIcon}
    title="No packs yet"
  />
);

// A failed catalog read must NOT fall through to the empty state — a member
// whose org requires a pack can't be told they have nothing. The surface owns
// its own error at the section level so the region reads honestly (never lies
// about data) while the rest of the page stays put.
//
// ISS-5002: the copy comes from the shared `PacksLoadFailed` rather than a
// local duplicate, so a client-side deadline doesn't tell the member to "check
// your connection" while the page around them says we stopped waiting. Same
// event, one story.
const YourPacksError = ({ error }: { error: unknown }) => (
  <PacksLoadFailed error={error} />
);

type YourPacksTableProps = {
  readonly groups: GridTableGroup<MemberPackRow>[];
};

const YourPacksTable = ({ groups }: YourPacksTableProps) => (
  <GridTable
    columns={MEMBER_COLUMNS}
    // A pack can appear only once across the member groups, so the pack id is a
    // stable, unique row key.
    getRowId={(pack) => pack.id}
    gridTemplateColumns={MEMBER_GRID}
    groupIcon={<LayersIcon aria-hidden="true" />}
    groups={groups}
    items={[]}
    leadingLabel="Pack"
    renderCell={renderCell}
    renderLead={renderLead}
  />
);

export type MemberViewProps = {
  /** The org catalog folded into the shared view-model (already loaded by the surface). */
  readonly packs: readonly PackView[];
  readonly isLoading?: boolean;
  readonly error?: Error | null;
  /** Extra content above the regions (e.g. the page heading). */
  readonly headerSlot?: ReactNode;
  /**
   * The current member's user id, used to scope `specific` distributions to the
   * targeted cohort so an `auto_install specific` pack that names other members
   * (or only other devices) doesn't read as Required for this member. Omit on
   * surfaces without a resolved identity — a specific distribution then degrades
   * to not-Required rather than mislabelling every member's row.
   */
  readonly memberUserId?: string | null;
  /**
   * The "Available" region body. When supplied (the web surface passes its
   * edit-capable catalog workspace), it replaces the passive read-only list —
   * this is how a member keeps the ability to select and edit an `OrgCustom`
   * pack they created (FEA-4085 parity: `PATCH /catalog/{id}` still permits a
   * creator to edit their own item). Omitted (desktop / tests) → the read-only
   * fallback list of catalog packs renders instead.
   */
  readonly availableSlot?: ReactNode;
};

export const MemberView = ({
  packs,
  isLoading = false,
  error = null,
  headerSlot,
  memberUserId,
  availableSlot,
}: MemberViewProps) => {
  const grouped = useMemo(
    () => groupMemberPacks(packs, memberUserId),
    [packs, memberUserId]
  );

  // Only render a group section that has rows — an empty "Required" heading
  // above nothing would read as a broken table, not "you have no required
  // packs" (that story is the whole-region empty state below).
  const yourPacksGroups = useMemo<GridTableGroup<MemberPackRow>[]>(() => {
    const sections: GridTableGroup<MemberPackRow>[] = [];
    if (grouped[MemberPackGroup.Required].length > 0) {
      sections.push({
        key: MemberPackGroup.Required,
        label: "Required by your org",
        items: grouped[MemberPackGroup.Required],
      });
    }
    if (grouped[MemberPackGroup.Installed].length > 0) {
      sections.push({
        key: MemberPackGroup.Installed,
        label: "Installed",
        items: grouped[MemberPackGroup.Installed],
      });
    }
    return sections;
  }, [grouped]);

  const available = grouped[MemberPackGroup.Available];

  const yourPacksBody = () => {
    if (isLoading) {
      return <GroupedSkeleton />;
    }
    if (error) {
      return <YourPacksError error={error} />;
    }
    if (yourPacksGroups.length === 0) {
      return <YourPacksEmpty />;
    }
    return <YourPacksTable groups={yourPacksGroups} />;
  };

  // The secondary "Available" region. When the surface supplies its own body
  // (`availableSlot` — the web edit-capable catalog, or the desktop-local
  // `PluginsPanel`), render it unconditionally: the slot owns its own
  // load/empty/error state, so it must NOT be suppressed by the primary "Your
  // packs" cloud load/error. This matters most on desktop, where the slot is the
  // fully-local `window.desktopApi.db` install surface that needs no cloud at
  // all — gating it behind the cloud catalog `error` would unmount the member's
  // only install/uninstall path whenever the cloud read fails (signed out,
  // offline, or a 500 on `/catalog`), collapsing the page to a single error
  // card. The primary region owns the cloud error alone (`YourPacksError`); the
  // slot keeps standing. The read-only fallback list, by contrast, is a
  // projection of the same cloud catalog, so it stays gated on a successful,
  // non-empty read and is surfaced once — the primary skeleton signals load and
  // the primary region surfaces the error, never duplicated here.
  const showFallbackAvailable = !(isLoading || error) && available.length > 0;
  const showAvailableSection = availableSlot ? true : showFallbackAvailable;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-10">
      {headerSlot}
      <PageSection
        description="What your org requires or you've installed, and where each one came from."
        title="Your packs"
      >
        {yourPacksBody()}
      </PageSection>

      {showAvailableSection ? (
        <PageSection
          description="Packs in your org's catalog you can install yourself, including ones you've authored."
          title="Available"
        >
          {availableSlot ?? (
            <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
              {available.map((pack) => (
                <PackListRow
                  action={null}
                  description={pack.description}
                  key={pack.id}
                  name={pack.name}
                  publisher={pack.publisher}
                  version={pack.version}
                />
              ))}
            </div>
          )}
        </PageSection>
      ) : null}
    </div>
  );
};
