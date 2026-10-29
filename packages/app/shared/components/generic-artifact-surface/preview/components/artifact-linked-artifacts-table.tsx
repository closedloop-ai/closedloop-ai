"use client";

import { toast } from "@repo/design-system/components/ui/sonner";
import { Link } from "@repo/navigation/link";
import { useNavigationAdapterOptional } from "@repo/navigation/provider";
import type { LucideIcon } from "lucide-react";
import { useId } from "react";
import type { GenericArtifact } from "../fixtures";
import { ArtifactTypeIcons } from "./artifact-icons";

export type ArtifactLinkedRecord = {
  /** Absent: the prototype's toast. `null`: an inert row. */
  href?: string | null;
  icon: LucideIcon;
  name: string;
  relationship: string;
  slug: string;
  type: string;
};

/**
 * One row of {@link LinkedArtifactGroupsTable}. Domain-free: the host resolves
 * every value, including the destination.
 */
export type LinkedArtifactTableRow = {
  /** Unique within its group. */
  key: string;
  /** `null`: an inert row. */
  href: string | null;
  icon: LucideIcon;
  /** The artifact's identifier; `null` when it has none. */
  slug: string | null;
  name: string;
  /** A short state drawn beside the name, when the artifact has one. */
  status?: string | null;
  /** `null`: no stated relationship, so the cell stays blank. */
  relationship: string | null;
};

/** A titled run of rows. A group with no rows is not drawn. */
export type LinkedArtifactTableGroup = {
  key: string;
  heading: string;
  rows: readonly LinkedArtifactTableRow[];
  /**
   * `true`: no Relationship column, for a group whose heading already says
   * how its rows relate (an issue's sub-issues). Opt-in, so a group whose
   * rows happen to state none still lines up with the groups around it.
   */
  hideRelationship?: boolean;
  /**
   * `true`: no heading row and no region of its own, for a group inside a
   * section the host already titles (an issue's Sub-issues section). Only
   * with `hideRelationship`, whose column label shares the row.
   */
  hideHeading?: boolean;
};

const ARTIFACT_COLUMN_LABEL = "Artifact";
const TYPE_COLUMN_LABEL = "Type";
const RELATIONSHIP_COLUMN_LABEL = "Relationship";
const FLAT_COLUMNS =
  "grid-cols-2 md:grid-cols-[minmax(0,1.6fr)_10rem_12rem] md:gap-0";
const GROUPED_COLUMNS =
  "grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,1fr)_12rem]";
const GROUPED_COLUMNS_NO_RELATIONSHIP = "grid-cols-1";
const ROW_CLASS =
  "grid min-h-12 w-full items-center gap-x-4 gap-y-1 border-b px-4 py-2 text-left text-sm transition-colors last:border-b-0 hover:bg-muted/40 md:py-0";

export function LinkedArtifactsTable({
  artifact,
  records,
}: {
  artifact?: GenericArtifact;
  records?: readonly ArtifactLinkedRecord[];
}) {
  const linked = records ?? [
    {
      icon: ArtifactTypeIcons.Document,
      slug: "PRD-595",
      name: "Generic artifact and project experience",
      type: "Document",
      relationship: "Defines",
    },
    {
      icon: ArtifactTypeIcons.Branch,
      slug: "BR-2048",
      name: "prototype/generic-artifacts-web-master",
      type: "Branch",
      relationship: "Implemented by",
    },
    {
      icon: ArtifactTypeIcons.Session,
      slug: "SES-7B91",
      name: "Prototype generic artifact shells",
      type: "Session",
      relationship: `Updated ${artifact?.slug}`,
    },
  ];
  return (
    <div className="w-full border-y">
      <div
        className={`grid gap-x-4 gap-y-1 border-b bg-muted/30 px-4 py-2 text-muted-foreground text-xs ${FLAT_COLUMNS}`}
      >
        <span className="col-span-2 md:col-span-1">
          {ARTIFACT_COLUMN_LABEL}
        </span>
        <span>{TYPE_COLUMN_LABEL}</span>
        <span>{RELATIONSHIP_COLUMN_LABEL}</span>
      </div>
      {linked.map((item) => {
        const Row = linkedRecordRow(item.href);
        return (
          <Row
            className={`${ROW_CLASS} ${FLAT_COLUMNS}`}
            key={`${item.slug}:${item.relationship}`}
            {...linkedRecordRowProps(item)}
          >
            <LinkedArtifactIdentity
              className="col-span-2 md:col-span-1"
              icon={item.icon}
              name={item.name}
              slug={item.slug}
            />
            <span className="text-muted-foreground">{item.type}</span>
            <span className="text-muted-foreground">{item.relationship}</span>
          </Row>
        );
      })}
    </div>
  );
}

/**
 * Linked artifacts grouped under the host's headings (PLN-2175 M1). The group
 * heading names the type, so there is no Type column; every row of every group
 * is drawn, with no cap (Kerensa Whitlock, 2026-10-09).
 */
export function LinkedArtifactGroupsTable({
  groups,
}: {
  groups: readonly LinkedArtifactTableGroup[];
}) {
  return (
    <div className="flex w-full flex-col gap-6">
      {groups
        .filter((group) => group.rows.length > 0)
        .map((group) => (
          <LinkedArtifactGroup group={group} key={group.key} />
        ))}
    </div>
  );
}

function LinkedArtifactGroup({ group }: { group: LinkedArtifactTableGroup }) {
  const headingId = useId();
  const showsRelationship = group.hideRelationship !== true;
  const columns = showsRelationship
    ? GROUPED_COLUMNS
    : GROUPED_COLUMNS_NO_RELATIONSHIP;
  if (group.hideHeading === true && !showsRelationship) {
    return (
      <div className="w-full border-y">
        {group.rows.map((row) => (
          <GroupedRow
            columns={columns}
            key={row.key}
            row={row}
            showsRelationship={false}
          />
        ))}
      </div>
    );
  }
  return (
    <section aria-labelledby={headingId} className="w-full border-y">
      <div
        className={`grid gap-x-4 border-b bg-muted/30 px-4 py-2 text-muted-foreground text-xs ${columns}`}
      >
        <h3 className="font-medium text-foreground text-sm" id={headingId}>
          {group.heading}
        </h3>
        {showsRelationship ? (
          <span className="self-end">{RELATIONSHIP_COLUMN_LABEL}</span>
        ) : null}
      </div>
      {group.rows.map((row) => (
        <GroupedRow
          columns={columns}
          key={row.key}
          row={row}
          showsRelationship={showsRelationship}
        />
      ))}
    </section>
  );
}

/**
 * An in-app destination goes through the navigation port, because the desktop
 * renderer blocks a bare root-relative anchor (`desktop-adapter.tsx`); an
 * absolute one opens outside the app, as the prototype table's rows do. The
 * Details design harness mounts no navigation port, so there the row is a plain
 * anchor.
 */
function GroupedRow({
  columns,
  row,
  showsRelationship,
}: {
  columns: string;
  row: LinkedArtifactTableRow;
  showsRelationship: boolean;
}) {
  const navigation = useNavigationAdapterOptional();
  const className = `${ROW_CLASS} ${columns}`;
  const content = (
    <>
      <LinkedArtifactIdentity
        icon={row.icon}
        name={row.name}
        slug={row.slug}
        status={row.status}
      />
      {showsRelationship ? (
        <>
          {" "}
          <span className="text-muted-foreground">
            {row.relationship ?? ""}
          </span>
        </>
      ) : null}
    </>
  );
  if (row.href === null) {
    return <div className={className}>{content}</div>;
  }
  if (ABSOLUTE_HTTP_HREF.test(row.href)) {
    return (
      <a className={className} href={row.href} rel="noreferrer" target="_blank">
        {content}
      </a>
    );
  }
  if (navigation === null) {
    return (
      <a className={className} href={row.href}>
        {content}
      </a>
    );
  }
  return (
    <Link className={className} href={row.href}>
      {content}
    </Link>
  );
}

function LinkedArtifactIdentity({
  className,
  icon: Icon,
  name,
  slug,
  status,
}: {
  className?: string;
  icon: LucideIcon;
  name: string;
  slug: string | null;
  status?: string | null;
}) {
  // The spaces keep the parts apart in the row's accessible name; a flex
  // container draws no whitespace-only text.
  return (
    <span className={`flex min-w-0 items-center gap-2 ${className ?? ""}`}>
      <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      {slug ? (
        <span className="font-mono text-muted-foreground text-xs max-md:shrink-0">
          {slug}
        </span>
      ) : null}{" "}
      <span className="truncate font-medium">{name}</span>
      {status ? (
        <>
          {" "}
          <span className="shrink-0 text-muted-foreground text-xs">
            {status}
          </span>
        </>
      ) : null}
    </span>
  );
}

const ABSOLUTE_HTTP_HREF = /^https?:\/\//i;
function linkedRecordRow(href: string | null | undefined) {
  if (href === undefined) {
    return "button";
  }
  return href === null ? "div" : "a";
}
function linkedRecordRowProps({ href, slug }: ArtifactLinkedRecord) {
  if (href === undefined) {
    const onClick = () => toast.success(`Opened ${slug}`);
    return { onClick, type: "button" as const };
  }
  if (href === null || !ABSOLUTE_HTTP_HREF.test(href)) {
    return href === null ? {} : { href };
  }
  return { href, rel: "noreferrer", target: "_blank" };
}
