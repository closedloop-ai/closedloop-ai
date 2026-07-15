"use client";

import { MoonIcon, SunIcon } from "@radix-ui/react-icons";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import { useTheme } from "next-themes";
import { useEffect, useId, useState } from "react";
import { Button } from "./button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";

const themes = [
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
  { label: "System", value: "system" },
];

type ModeToggleProps = {
  className?: string;
};

export function ModeToggle({ className }: ModeToggleProps) {
  const { setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const triggerId = useId();

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <Button
        className={cn("shrink-0 text-foreground", className)}
        size="icon"
        type="button"
        variant="ghost"
      >
        <SunIcon className="h-[1.2rem] w-[1.2rem]" />
        <MoonIcon className="absolute h-[1.2rem] w-[1.2rem] opacity-0" />
        <span className="sr-only">Toggle theme</span>
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild id={triggerId}>
        <Button
          className={cn("shrink-0 text-foreground", className)}
          size="icon"
          type="button"
          variant="ghost"
        >
          <SunIcon className="h-[1.2rem] w-[1.2rem] rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
          <MoonIcon className="absolute h-[1.2rem] w-[1.2rem] rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
          <span className="sr-only">Toggle theme</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {themes.map(({ label, value }) => (
          <DropdownMenuItem key={value} onClick={() => setTheme(value)}>
            {label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
