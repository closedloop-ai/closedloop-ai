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

// This prototype keeps its experimental artifact identity mapping local until
// a human selects which concepts should be promoted into shared UI.
export const ArtifactTypeIcons = {
  Agent: BotIcon,
  Branch: GitBranchIcon,
  Document: FileIcon,
  Issue: SquareCheckIcon,
  Prototype: PanelsTopLeftIcon,
  Session: HistoryIcon,
} as const satisfies Record<string, LucideIcon>;

export const GenericArtifactIcon = Layers2Icon;

export const TableFilterIcon = ListFilterIcon;
