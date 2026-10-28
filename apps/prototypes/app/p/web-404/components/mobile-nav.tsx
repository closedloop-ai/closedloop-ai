"use client";

import { GitHubMark } from "@repo/design-system/components/ui/brand-icons";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@repo/design-system/components/ui/sheet";
import { Menu } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { githubRepoUrl, headerNavLinks } from "../mock";

// Stand-in for apps/web's MobileNav. Below `lg` the real header collapses its
// nav behind this trigger, so without it the 390px review reads as a site with
// no navigation at all — and mobile is where a stale link gets tapped.
//
// The sr-only SheetTitle with no SheetDescription is copied verbatim from the
// real component, which means opening this logs Radix's "Missing `Description`
// or `aria-describedby`" warning twice — as apps/web does today. Left as-is on
// purpose: the stand-in's job is to reproduce production, not to quietly repair
// it. The production fix belongs in site-header-mobile.tsx.
export const MobileNav = () => {
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
          {headerNavLinks.map((link) =>
            link.hardNavigate ? (
              <a
                className={mobileLinkClassName}
                href={link.href}
                key={link.href}
                onClick={() => setOpen(false)}
              >
                {link.label}
              </a>
            ) : (
              <Link
                className={mobileLinkClassName}
                href={link.href}
                key={link.href}
                onClick={() => setOpen(false)}
              >
                {link.label}
              </Link>
            )
          )}
          <a
            className="mt-2 flex items-center gap-2 rounded-md px-3 py-2 text-foreground/80 text-sm transition-colors hover:bg-muted hover:text-primary"
            href={githubRepoUrl}
            onClick={() => setOpen(false)}
            rel="noopener noreferrer"
            target="_blank"
          >
            <GitHubMark className="size-4" />
            GitHub
          </a>
        </nav>
      </SheetContent>
    </Sheet>
  );
};

const mobileLinkClassName =
  "rounded-md px-3 py-2 text-foreground/80 text-sm transition-colors hover:bg-muted hover:text-primary";
