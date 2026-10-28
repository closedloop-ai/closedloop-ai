"use client";

import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";
import type { ReactNode } from "react";
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "./dropdown-menu";

type ThemeSubmenuProps = {
  /**
   * Extra classes for the flyout panel. A host whose other panels carry a
   * treatment (radius, padding, shadow) passes it here, so the theme flyout is
   * not the one panel in the menu still wearing the primitive default.
   *
   * Width is deliberately NOT part of that: the options are three short words,
   * so the panel sizes to its content rather than inheriting a sibling's width.
   */
  contentClassName?: string;
  /**
   * Icon shown on the submenu trigger next to the "Theme" label. Omit for a
   * dynamic icon reflecting the active theme (sun/moon/monitor). Pass a fixed
   * icon (e.g. a sun-moon glyph) to keep the trigger stable regardless of
   * theme, or `null` for a text-only trigger in a menu whose rows carry no
   * glyphs — one row wearing the only icon in the menu reads as a mistake.
   */
  icon?: ReactNode;
  /**
   * Row rhythm, applied to the trigger AND to the three options inside the
   * flyout — they are all rows of the same control, and dressing only the
   * trigger leaves a flyout that is denser than the one its sibling submenu
   * opens two rows away, in the same menu, at the same moment.
   */
  itemClassName?: string;
};

/**
 * Generic dropdown submenu for switching the next-themes color theme between
 * Light, Dark, and System. Composes the design-system dropdown primitives and
 * is shared by every account/gateway menu so the theme block lives in one place.
 *
 * The class hooks are named for the parts they dress rather than one bare
 * `className`: this component's root renders no element of its own, so a single
 * `className` could not say which part it meant.
 */
export function ThemeSubmenu({
  contentClassName,
  icon,
  itemClassName,
}: ThemeSubmenuProps) {
  const { theme, setTheme } = useTheme();

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className={itemClassName}>
        {/* `undefined` means "caller said nothing", which is the only case that
            earns the default icon. `??` could not tell that from an explicit
            `null`, so a host asking for a text-only trigger got one anyway. */}
        {icon === undefined ? <ThemeIcon theme={theme} /> : icon}
        Theme
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className={contentClassName}>
        <DropdownMenuRadioGroup
          onValueChange={setTheme}
          value={theme ?? "system"}
        >
          <DropdownMenuRadioItem className={itemClassName} value="light">
            <SunIcon className="size-4" />
            Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem className={itemClassName} value="dark">
            <MoonIcon className="size-4" />
            Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem className={itemClassName} value="system">
            <MonitorIcon className="size-4" />
            System
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function ThemeIcon({ theme }: { theme: string | undefined }) {
  if (theme === "dark") {
    return <MoonIcon className="size-4" />;
  }
  if (theme === "light") {
    return <SunIcon className="size-4" />;
  }
  return <MonitorIcon className="size-4" />;
}
