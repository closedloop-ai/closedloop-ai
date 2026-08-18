"use client";

import { useState } from "react";
import { type SourceComponent, sourceComponents } from "../mock";
import { ConvertSheet } from "./convert-sheet";
import { DiscoverList } from "./discover-list";

// The discover surface: a list of components published for one harness, each
// convertible onto the other. Selecting one opens the convert-and-install sheet
// where the preview/confirm flow lives.
export const ConvertWorkspace = () => {
  const [active, setActive] = useState<SourceComponent | null>(null);
  return (
    <main className="mx-auto w-full max-w-2xl space-y-8 px-6 py-10">
      <header className="space-y-2">
        <h1 className="font-semibold text-2xl tracking-tight">
          Convert &amp; Install
        </h1>
        <p className="text-muted-foreground leading-relaxed">
          Components published for one harness, ready to convert onto yours.
          Converting is honest about what carries over and what's dropped before
          anything installs.
        </p>
      </header>

      <section aria-label="Discoverable components" className="space-y-3">
        <DiscoverList onConvert={setActive} sources={sourceComponents} />
      </section>

      <ConvertSheet
        onOpenChange={(open) => {
          if (!open) {
            setActive(null);
          }
        }}
        source={active}
      />
    </main>
  );
};
