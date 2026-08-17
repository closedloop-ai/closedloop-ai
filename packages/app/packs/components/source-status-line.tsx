"use client";

import { cn } from "@repo/design-system/lib/utils";
import type { LucideIcon } from "lucide-react";

// A status signal that never relies on color alone: a lucide glyph plus a text
// label, so the meaning survives without hue. `tone` only shifts the text
// color as a secondary cue on top of the always-present icon + words.
export const StatusTone = {
  Default: "default",
  Muted: "muted",
  Danger: "danger",
} as const;
export type StatusTone = (typeof StatusTone)[keyof typeof StatusTone];

const TONE_CLASS: Record<StatusTone, string> = {
  [StatusTone.Default]: "text-foreground",
  [StatusTone.Muted]: "text-muted-foreground",
  [StatusTone.Danger]: "text-destructive",
};

type SourceStatusLineProps = {
  readonly icon: LucideIcon;
  readonly text: string;
  readonly description?: string;
  readonly tone?: StatusTone;
};

export const SourceStatusLine = ({
  icon: Icon,
  text,
  description,
  tone = StatusTone.Default,
}: SourceStatusLineProps) => (
  <span className="flex flex-col gap-0.5">
    <span className={cn("flex items-center gap-1.5 text-sm", TONE_CLASS[tone])}>
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      {text}
    </span>
    {description ? (
      <span className="text-muted-foreground text-xs">{description}</span>
    ) : null}
  </span>
);
