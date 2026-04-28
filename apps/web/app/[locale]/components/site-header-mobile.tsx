"use client";

import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@repo/design-system/components/ui/sheet";
import { Github, Menu } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

type NavLink = {
  label: string;
  href: string;
  external?: boolean;
};

type MobileNavProps = {
  navLinks: NavLink[];
  githubUrl: string;
};

export const MobileNav = ({ githubUrl, navLinks }: MobileNavProps) => {
  const [open, setOpen] = useState(false);

  return (
    <Sheet onOpenChange={setOpen} open={open}>
      <SheetTrigger
        aria-label="Open menu"
        className="flex items-center justify-center rounded-md p-2 text-foreground/70 transition-colors hover:bg-muted hover:text-foreground lg:hidden"
      >
        <Menu className="size-5" />
      </SheetTrigger>
      <SheetContent className="w-72" side="right">
        <SheetTitle className="sr-only">Site navigation</SheetTitle>
        <nav aria-label="Mobile" className="flex flex-col gap-1 p-4 pt-12">
          {navLinks.map((link) => (
            <Link
              className="rounded-md px-3 py-2 text-foreground/80 text-sm transition-colors hover:bg-muted hover:text-primary"
              href={link.href}
              key={link.href}
              onClick={() => setOpen(false)}
              rel={link.external ? "noopener noreferrer" : undefined}
              target={link.external ? "_blank" : undefined}
            >
              {link.label}
            </Link>
          ))}
          <Link
            className="mt-2 flex items-center gap-2 rounded-md px-3 py-2 text-foreground/80 text-sm transition-colors hover:bg-muted hover:text-primary"
            href={githubUrl}
            onClick={() => setOpen(false)}
            rel="noopener noreferrer"
            target="_blank"
          >
            <Github className="size-4" />
            GitHub
          </Link>
        </nav>
      </SheetContent>
    </Sheet>
  );
};
