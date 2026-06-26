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
   * Icon shown on the submenu trigger next to the "Theme" label. Defaults to a
   * dynamic icon reflecting the active theme (sun/moon/monitor). Pass a fixed
   * icon (e.g. a sun-moon glyph) to keep the trigger stable regardless of theme.
   */
  icon?: ReactNode;
};

/**
 * Generic dropdown submenu for switching the next-themes color theme between
 * Light, Dark, and System. Composes the design-system dropdown primitives and
 * is shared by every account/gateway menu so the theme block lives in one place.
 */
export function ThemeSubmenu({ icon }: ThemeSubmenuProps) {
  const { theme, setTheme } = useTheme();

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        {icon ?? <ThemeIcon theme={theme} />}
        Theme
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuRadioGroup onValueChange={setTheme} value={theme ?? "system"}>
          <DropdownMenuRadioItem value="light">
            <SunIcon className="size-4" />
            Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <MoonIcon className="size-4" />
            Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
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
