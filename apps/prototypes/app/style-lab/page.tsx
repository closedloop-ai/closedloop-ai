import { Button } from "@repo/design-system/components/ui/button";
import { ArrowLeftIcon, PaintbrushIcon } from "lucide-react";
import Link from "next/link";
import { StyleBrowserEditor } from "../style-browser-editor";

const StyleLabPage = () => (
  <main className="min-h-screen bg-muted/30">
    <header className="flex flex-col gap-3 border-b bg-background px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-md border bg-muted/40">
          <PaintbrushIcon className="size-4 text-muted-foreground" />
        </span>
        <div className="min-w-0">
          <h1 className="font-semibold text-lg tracking-tight">Style Lab</h1>
          <p className="max-w-3xl text-muted-foreground text-sm">
            Browse the design-system style taxonomy as editable canvas examples,
            with live previews and a local PR export path.
          </p>
        </div>
      </div>
      <Button asChild className="w-fit" size="sm" variant="ghost">
        <Link href="/">
          <ArrowLeftIcon />
          Prototype library
        </Link>
      </Button>
    </header>
    <StyleBrowserEditor />
  </main>
);

export default StyleLabPage;
