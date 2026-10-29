"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { PlusIcon } from "lucide-react";

/**
 * The primary action of a list page's header. The size lives in the shared page
 * chrome, so no page picks its own and the header height cannot differ between
 * Documents, Issues and the rest (ISS-13007).
 */
export function HeaderPrimaryAction({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <Button onClick={onClick} size="sm" type="button">
      <PlusIcon aria-hidden />
      {label}
    </Button>
  );
}

/**
 * Size and variant of an icon-only header action (favorite star, "..." menu).
 * Header controls are all 32px tall, so a page's header height cannot depend on
 * which actions it carries (ISS-13007).
 */
export const HEADER_ICON_ACTION_PROPS = {
  size: "icon-sm",
  variant: "ghost",
} as const;
