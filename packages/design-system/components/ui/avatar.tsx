"use client"

import * as React from "react"
import { Avatar as AvatarPrimitive } from "radix-ui"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@closedloop-ai/design-system/lib/utils"

/**
 * Avatar (Figma "Avatar", Nerys 2026-10-22): seven sizes, a photo or a
 * one-letter placeholder on the shared avatar colours, and an optional
 * online status dot. `size` is optional: without it the avatar keeps the
 * 32px default and a caller's own size classes, as before.
 */
const AVATAR_BASE_CLASS = "group/avatar relative flex shrink-0 rounded-full"

/** The size classes alone, so they can follow a caller's `className`. */
const avatarVariants = cva("", {
    variants: {
      size: {
        "2xs": "size-4",
        xs: "size-6",
        sm: "size-8",
        md: "size-10",
        lg: "size-12",
        xl: "size-14",
        "2xl": "size-16",
      },
    },
  })

export type AvatarSize = NonNullable<
  VariantProps<typeof avatarVariants>["size"]
>

/**
 * The placeholder letter's size per avatar size: Figma's text styles. No
 * line-heights: the fallback trims the letter to its cap height, so the box
 * centres the letter itself, not a line of text.
 */
const FALLBACK_SIZE_CLASS = [
  "group-data-[size=2xs]/avatar:text-[10px]",
  "group-data-[size=xs]/avatar:text-[12px]",
  "group-data-[size=sm]/avatar:text-[14px]",
  "group-data-[size=md]/avatar:text-[16px]",
  "group-data-[size=lg]/avatar:text-[18px]",
  "group-data-[size=xl]/avatar:text-[20px]",
  "group-data-[size=2xl]/avatar:text-[24px]",
].join(" ")

function Avatar({
  className,
  size,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Root> &
  VariantProps<typeof avatarVariants>) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      data-size={size ?? undefined}
      // An explicit `size` wins over a size class in `className`, so the
      // letter and the circle never disagree; only the size classes follow
      // `className`, so a caller's shape (an organisation's rounded square)
      // survives. Without `size`, the 32px default yields to the caller's
      // own size classes, as before.
      className={
        size
          ? cn(AVATAR_BASE_CLASS, className, avatarVariants({ size }))
          : cn(AVATAR_BASE_CLASS, "size-8", className)
      }
      {...props}
    />
  )
}

function AvatarImage({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Image>) {
  return (
    <AvatarPrimitive.Image
      data-slot="avatar-image"
      className={cn(
        // The root's corners, so a rounded-square avatar (an organisation's
        // logo) keeps them: the root does not clip, or it would cut the dot.
        "aspect-square size-full rounded-[inherit] object-cover",
        className
      )}
      {...props}
    />
  )
}

/**
 * The placeholder, on the shared avatar colours for every person avatar. It
 * renders its children as given; text (a string or number) sits in its own
 * block trimmed to cap height and baseline, so flex centring centres the
 * glyphs. One initial per person is the caller's: `PersonAvatar` and the
 * initials helpers produce it, and raw callers pass `avatarInitial(...)`.
 */
function AvatarFallback({
  className,
  children,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Fallback>) {
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      className={cn(
        "flex size-full items-center justify-center overflow-hidden rounded-[inherit] bg-avatar-placeholder font-medium text-avatar-placeholder-foreground",
        FALLBACK_SIZE_CLASS,
        className
      )}
      {...props}
    >
      {typeof children === "string" || typeof children === "number" ? (
        // Its own block, trimmed to cap height and baseline, so flex
        // centring centres the glyphs, not a line box whose half-leading
        // and descender space sit unevenly around them.
        <span className="block [text-box:trim-both_cap_alphabetic]">
          {children}
        </span>
      ) : (
        children
      )}
    </AvatarPrimitive.Fallback>
  )
}

/** The dot's size and ring per avatar size, from Figma. */
const STATUS_SIZE_CLASS = [
  "size-2 border-[1.5px]",
  "group-data-[size=2xs]/avatar:size-1.5 group-data-[size=2xs]/avatar:border",
  "group-data-[size=xs]/avatar:size-1.5 group-data-[size=xs]/avatar:border",
  "group-data-[size=sm]/avatar:size-2",
  "group-data-[size=md]/avatar:size-2.5",
  "group-data-[size=lg]/avatar:size-3",
  "group-data-[size=xl]/avatar:size-3.5",
  "group-data-[size=2xl]/avatar:size-4",
].join(" ")

/** The online status dot, bottom right, ringed so it reads on a photo. */
function AvatarStatus({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="avatar-status"
      className={cn(
        "absolute right-0 bottom-0 z-[2] rounded-full border-avatar-status-border bg-avatar-status-online",
        STATUS_SIZE_CLASS,
        className
      )}
      {...props}
    />
  )
}

/**
 * One uppercase letter: the first of the text, or `fallback` (nothing by
 * default; "?" where a blank name still needs a mark) for blank or missing
 * text. One initial on every person avatar (Nerys, 2026-10-22).
 */
function avatarInitial(
  text: string | null | undefined,
  fallback = ""
): string {
  const first = Array.from((text ?? "").trim())[0]
  return first ? first.toUpperCase() : fallback
}

export { Avatar, AvatarImage, AvatarFallback, AvatarStatus, avatarInitial }
