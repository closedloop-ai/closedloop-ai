"use client";

import type { PrCommentAuthorKind } from "@repo/api/src/types/branch-view";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@repo/design-system/components/ui/avatar";
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

export function getCommentAuthorInitials(author: string): string {
  return author
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

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
      <Avatar className={cn("rounded-none", box)}>
        {authorAvatar ? (
          <AvatarImage
            alt={author}
            className="object-cover"
            src={authorAvatar}
          />
        ) : null}
        <AvatarFallback
          className={cn("rounded-none", AVATAR_FALLBACK_CLASS_NAME[size])}
        >
          {getCommentAuthorInitials(author)}
        </AvatarFallback>
      </Avatar>
    </span>
  );
}
