"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { BanIcon, RepeatIcon } from "lucide-react";
import {
  Convertibility,
  HARNESS_LABEL,
  type SourceComponent,
  targetHarnessFor,
  unsupportedCount,
} from "../mock";
import { KindBadge } from "./convert-meta";

// One discovered component. The primary action names the exact conversion, so
// the user knows what harness it lands on and what it converts from before
// opening the sheet: "Install on Claude (convert from Codex)".
const DiscoverCard = ({
  source,
  onConvert,
}: {
  source: SourceComponent;
  onConvert: (source: SourceComponent) => void;
}) => {
  const target = HARNESS_LABEL[targetHarnessFor(source)];
  const from = HARNESS_LABEL[source.sourceHarness];
  const blocked = source.convertibility === Convertibility.Blocked;
  const dropped = unsupportedCount(source);
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <KindBadge kind={source.kind} />
          <CardTitle className="text-base">{source.name}</CardTitle>
        </div>
        <CardDescription>{source.description}</CardDescription>
      </CardHeader>
      <CardContent className="flex items-center justify-between gap-4">
        <p className="text-muted-foreground text-sm">
          {from} {source.kind} · {source.publisher}
          {!blocked && dropped > 0
            ? ` · ${dropped} field${dropped === 1 ? "" : "s"} dropped on convert`
            : ""}
          {blocked ? " · can't convert" : ""}
        </p>
        <Button
          className="shrink-0 gap-1.5"
          onClick={() => onConvert(source)}
          type="button"
          variant={blocked ? "outline" : "default"}
        >
          {blocked ? (
            <>
              <BanIcon aria-hidden="true" className="size-4" />
              Why it won't convert
            </>
          ) : (
            <>
              <RepeatIcon aria-hidden="true" className="size-4" />
              Install on {target}
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  );
};

export const DiscoverList = ({
  sources,
  onConvert,
}: {
  sources: readonly SourceComponent[];
  onConvert: (source: SourceComponent) => void;
}) => (
  <ul className="space-y-3">
    {sources.map((source) => (
      <li key={source.id}>
        <DiscoverCard onConvert={onConvert} source={source} />
      </li>
    ))}
  </ul>
);
