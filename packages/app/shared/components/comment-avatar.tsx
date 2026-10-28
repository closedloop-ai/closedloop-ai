"use client";

import type { PrCommentAuthorKind } from "@repo/api/src/types/branch-view";
import { avatarInitial } from "@repo/design-system/components/ui/avatar";
import { PersonAvatar } from "@repo/design-system/components/ui/person-avatar";
import { cn } from "@repo/design-system/lib/utils";
import { Bot } from "lucide-react";

export type CommentAvatarSize = "md" | "sm" | "xs";

export type CommentAvatarProps = {
  author: string;
  authorAvatar?: string | null;
  authorKind?: PrCommentAuthorKind;
  size?: CommentAvatarSize;
};

const AVATAR_BOX_CLASS_NAME: Record<CommentAvatarSize, string> = {
  md: "h-8 w-8",
  sm: "h-7 w-7",
  xs: "h-5 w-5",
};

const AVATAR_ICON_CLASS_NAME: Record<CommentAvatarSize, string> = {
  md: "h-4 w-4",
  sm: "h-3.5 w-3.5",
  xs: "h-3 w-3",
};

const AVATAR_FALLBACK_CLASS_NAME: Record<CommentAvatarSize, string> = {
  md: "text-xs",
  sm: "text-[10px]",
  xs: "text-[9px]",
};

/** One initial on every avatar (Nerys, 2026-10-22): the author's first letter. */
export function getCommentAuthorInitials(author: string): string {
  return avatarInitial(author);
}

/**
 * The avatar beside a comment/owner row. Decorative by design: every consumer
 * renders `author` as visible text right next to it, so the photo carrying the
 * same string made a screen reader announce the person twice on every row that
 * had one (WCAG 1.1.1 / H67). ISS-5955 settled that for the sibling
 * `ActivityActor` in the same feed rail; ISS-7441 is the same correction here,
 * and it also makes the two branches of this component agree — the bot branch
 * has always been silent, its glyph `aria-hidden`.
 *
 * So the caller owns the name. Do not mount this where nothing else states the
 * author: `alt=""` deduplicates an announcement, it does not relocate one. The
 * avatar that carries its own name on every branch is
 * `shared/components/assignee-avatar.tsx`, whose consumers opt OUT through its
 * `decorative` prop — the same rule spelled as an argument.
 *
 * The `AvatarFallback` initials stay in the accessibility tree, as they do in
 * `ActivityActor`: a derived abbreviation is not the name, and hiding it was
 * the other half of ISS-6174, which was canceled.
 */
export function CommentAvatar({
  author,
  authorAvatar,
  authorKind,
  size = "md",
}: Readonly<CommentAvatarProps>) {
  const box = AVATAR_BOX_CLASS_NAME[size];

  if (authorKind === "bot") {
    return (
      <span
        className={cn(
          "flex shrink-0 items-center justify-center overflow-hidden rounded-[8px] bg-chart-5/15 text-chart-5",
          box
        )}
      >
        <Bot aria-hidden className={AVATAR_ICON_CLASS_NAME[size]} />
      </span>
    );
  }

  return (
    <span className={cn("flex shrink-0 overflow-hidden rounded-[8px]", box)}>
      <PersonAvatar
        avatarUrl={authorAvatar}
        className={cn("rounded-none", box)}
        fallbackClassName={cn("rounded-none", AVATAR_FALLBACK_CLASS_NAME[size])}
        imageClassName="object-cover"
        initials={getCommentAuthorInitials(author)}
        name={author}
      />
    </span>
  );
}
