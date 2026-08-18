// Shared presentation for the Convert & Install flow: per-field-support glyphs
// and the harness/kind labels. Status is never color-only; every support level
// carries its own lucide glyph and a text label so it reads on a mono display
// and to a screen reader.

import type { BadgeProps } from "@repo/design-system/components/ui/badge";
import { Badge } from "@repo/design-system/components/ui/badge";
import {
  ArrowRightIcon,
  BotIcon,
  CheckIcon,
  type LucideIcon,
  MinusCircleIcon,
  TerminalIcon,
  TriangleAlertIcon,
  WebhookIcon,
  WrenchIcon,
} from "lucide-react";
import {
  COMPONENT_KIND_LABEL,
  ComponentKind,
  FIELD_SUPPORT_LABEL,
  FieldSupport,
} from "../mock";

type FieldSupportMeta = {
  icon: LucideIcon;
  label: string;
  variant: NonNullable<BadgeProps["variant"]>;
};

// Green check = clean, amber triangle = partial (converts with changes), muted
// minus = dropped. The glyph, not the color, carries the meaning.
export const FIELD_SUPPORT_META: Record<FieldSupport, FieldSupportMeta> = {
  [FieldSupport.Supported]: {
    icon: CheckIcon,
    label: FIELD_SUPPORT_LABEL[FieldSupport.Supported],
    variant: "success",
  },
  [FieldSupport.Partial]: {
    icon: TriangleAlertIcon,
    label: FIELD_SUPPORT_LABEL[FieldSupport.Partial],
    variant: "warning",
  },
  [FieldSupport.Unsupported]: {
    icon: MinusCircleIcon,
    label: FIELD_SUPPORT_LABEL[FieldSupport.Unsupported],
    variant: "muted",
  },
};

const KIND_ICON: Record<ComponentKind, LucideIcon> = {
  [ComponentKind.Agent]: BotIcon,
  [ComponentKind.Skill]: WrenchIcon,
  [ComponentKind.Command]: TerminalIcon,
  [ComponentKind.Hook]: WebhookIcon,
};

// A component-kind chip (Agent/Skill/Command/Hook) with its glyph, reused by the
// discover list and the source-provenance region.
export const KindBadge = ({ kind }: { kind: ComponentKind }) => {
  const Icon = KIND_ICON[kind];
  return (
    <Badge className="gap-1" variant="muted">
      <Icon className="size-3" />
      {COMPONENT_KIND_LABEL[kind]}
    </Badge>
  );
};

// The support glyph + label chip shown against each field in the breakdown.
export const FieldSupportBadge = ({ support }: { support: FieldSupport }) => {
  const meta = FIELD_SUPPORT_META[support];
  const Icon = meta.icon;
  return (
    <Badge className="gap-1" variant={meta.variant}>
      <Icon aria-hidden="true" className="size-3" />
      {meta.label}
    </Badge>
  );
};

// "Codex -> Claude" harness direction, shown as plain text so the conversion
// direction is legible without color.
export const HarnessArrow = ({ from, to }: { from: string; to: string }) => (
  <span className="inline-flex items-center gap-1.5 font-medium text-sm">
    {from}
    <ArrowRightIcon
      aria-label="converts to"
      className="size-3.5 text-muted-foreground"
    />
    {to}
  </span>
);
