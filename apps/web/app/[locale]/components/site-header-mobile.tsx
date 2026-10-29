"use client";

import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@repo/design-system/components/ui/sheet";
import { Menu } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { GitHubLogo } from "@/components/github-logo";

type MobileNavProps = {
  docsHref: string;
  resourcesHref: string;
  githubUrl: string;
};

const NAV_LINK_CLASS =
  "rounded-md px-3 py-2 text-foreground/80 text-sm transition-colors hover:bg-muted hover:text-primary";

export const MobileNav = ({
  docsHref,
  githubUrl,
  resourcesHref,
}: MobileNavProps) => {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  // Links are written out, not mapped from a list, so the build can stamp
  // their labels as product copy for click analytics (ISS-12557). Docs
  // hard-navigates for the reason given in site-header.tsx.
  return (
    <Sheet onOpenChange={setOpen} open={open}>
      <SheetTrigger
        aria-label="Open menu"
        className="flex items-center justify-center rounded-md p-2 text-foreground/70 transition-colors hover:bg-muted hover:text-foreground lg:hidden"
      >
        <Menu className="size-5" />
      </SheetTrigger>
      <SheetContent aria-describedby={undefined} className="w-72" side="right">
        <SheetTitle className="sr-only">Site navigation</SheetTitle>
        <nav aria-label="Mobile" className="flex flex-col gap-1 p-4 pt-12">
          <a className={NAV_LINK_CLASS} href={docsHref} onClick={close}>
            Documentation
          </a>
          <Link className={NAV_LINK_CLASS} href={resourcesHref} onClick={close}>
            Resources
          </Link>
          <Link
            className="mt-2 flex items-center gap-2 rounded-md px-3 py-2 text-foreground/80 text-sm transition-colors hover:bg-muted hover:text-primary"
            href={githubUrl}
            onClick={close}
            rel="noopener noreferrer"
            target="_blank"
          >
            <GitHubLogo className="size-4" />
            GitHub
          </Link>
        </nav>
      </SheetContent>
    </Sheet>
  );
};
