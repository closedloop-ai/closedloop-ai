import {
  BotIcon,
  FileIcon,
  GitBranchIcon,
  HistoryIcon,
  Layers2Icon,
  ListFilterIcon,
  type LucideIcon,
  PanelsTopLeftIcon,
  RocketIcon,
  SquareCheckIcon,
} from "lucide-react";

// Promoted into production use as the linked-artifacts table's per-type icons
// (Kerensa Whitlock 2026-10-09, PLN-2175 campaign).
export const ArtifactTypeIcons = {
  Agent: BotIcon,
  Branch: GitBranchIcon,
  Document: FileIcon,
  Deployment: RocketIcon,
  Issue: SquareCheckIcon,
  Prototype: PanelsTopLeftIcon,
  Session: HistoryIcon,
} as const satisfies Record<string, LucideIcon>;

export const GenericArtifactIcon = Layers2Icon;

export const TableFilterIcon = ListFilterIcon;
