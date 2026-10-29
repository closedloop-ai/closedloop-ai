import {
  BotIcon,
  FileIcon,
  GitBranchIcon,
  HistoryIcon,
  Layers2Icon,
  ListFilterIcon,
  type LucideIcon,
  PanelsTopLeftIcon,
  SquareCheckIcon,
} from "lucide-react";

/**
 * Canonical artifact identity icons for the Web Master prototype family.
 *
 * The left navigation is the visual source of truth. List rows, references,
 * filters, search results, and nested tables import from this registry so an
 * artifact never changes identity when it appears in a different surface.
 */
export const ArtifactTypeIcons = {
  Agent: BotIcon,
  Branch: GitBranchIcon,
  Document: FileIcon,
  Issue: SquareCheckIcon,
  Prototype: PanelsTopLeftIcon,
  Session: HistoryIcon,
} as const satisfies Record<string, LucideIcon>;

export const GenericArtifactIcon = Layers2Icon;

/** The standard decreasing-line filter affordance used by every table. */
export const TableFilterIcon = ListFilterIcon;
