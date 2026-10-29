"use client";

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  AvatarStatus,
  avatarInitial,
} from "./avatar";
import type { ComponentProps } from "react";

type PersonAvatarBaseProps = Omit<
  ComponentProps<typeof Avatar>,
  "aria-hidden" | "aria-label" | "children" | "name" | "role"
> & {
  /** The full identity used for the default initials fallback. */
  name: string;
  /** Image source; an absent or failed image leaves the fallback visible. */
  avatarUrl?: string | null;
  /** A consumer's own initials; the avatar draws their first letter (one initial on every avatar, Nerys 2026-10-22). */
  initials?: string;
  /**
   * Caller-owned shape and placement. Size it with `size` (2xs-2xl, the Figma
   * sizes), which also sets the letter's type; a size class here is the
   * legacy route and yields to `size`.
   */
  className?: string;
  /** Shows the online status dot, bottom right. */
  online?: boolean;
  /** Caller-owned image crop or fit treatment. */
  imageClassName?: string;
  /** Caller-owned fallback type size and shape; colours are the shared avatar pair. */
  fallbackClassName?: string;
  /** The image alt text for callers with an existing image announcement contract. */
  imageAlt?: string;
};

/** The avatar either names itself or leaves naming to an adjacent element. */
export type PersonAvatarProps = PersonAvatarBaseProps &
  (
    | { ariaLabel: string; decorative?: false; role?: "img" }
    | { ariaLabel?: never; decorative: true; role?: never }
    | { ariaLabel?: never; decorative?: false; role?: never }
  );

/** Shared photo-first person avatar with initials on absent or failed images. */
export function PersonAvatar({
  name,
  avatarUrl,
  initials,
  className,
  imageClassName,
  fallbackClassName,
  imageAlt = "",
  online = false,
  ariaLabel,
  role,
  decorative,
  ...avatarProps
}: Readonly<PersonAvatarProps>) {
  return (
    <Avatar
      className={className}
      {...avatarProps}
      {...avatarAccessibilityProps(decorative, ariaLabel, role)}
    >
      {/* ISS-8972: an absent source must not unmount the image; Radix tracks the
          transition back to initials when the source changes. */}
      <AvatarImage
        alt={imageAlt}
        className={imageClassName}
        src={avatarUrl ?? undefined}
      />
      <AvatarFallback className={fallbackClassName}>
        {avatarInitial(initials ?? name)}
      </AvatarFallback>
      {online ? <AvatarStatus /> : null}
    </Avatar>
  );
}

function avatarAccessibilityProps(
  decorative: boolean | undefined,
  ariaLabel: string | undefined,
  role: "img" | undefined
) {
  if (decorative) {
    return { "aria-hidden": true as const };
  }
  if (ariaLabel) {
    return { "aria-label": ariaLabel, ...(role ? { role } : {}) };
  }
  return {};
}


/**
 * The type size table and Branches person cells use. Colours are the shared
 * avatar pair on every person avatar (Nerys, 2026-10-22), so this no longer
 * carries any.
 */
export const PERSON_AVATAR_PRIMARY_FALLBACK_CLASS_NAME = "text-[10px]";
