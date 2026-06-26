import type { Harness, Pack } from "@repo/app/agents/lib/session-types";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { Sparkline } from "@repo/design-system/components/ui/primitives/sparkline";
import { badgeClassName } from "@repo/design-system/components/ui/utils";

type PackCardProps = {
  pack: Pack;
  selected?: boolean;
  onSelect?: (packId: string) => void;
  onInstallPack?: (packId: string, harness: Harness) => void;
};

export function PackCard({
  pack,
  selected = false,
  onSelect,
  onInstallPack,
}: PackCardProps) {
  return (
    <Card className={selected ? "ring-1 ring-primary/40" : undefined}>
      <CardHeader className="space-y-2">
        <div className="flex items-start justify-between gap-3">
          <button
            className="space-y-1 text-left"
            disabled={!onSelect}
            onClick={() => onSelect?.(pack.id)}
            type="button"
          >
            <CardTitle>{pack.displayName}</CardTitle>
            <CardDescription className="font-mono">{pack.id}</CardDescription>
          </button>
          <div className="text-right text-amber-600">
            <div className="font-semibold text-lg">★ {pack.stars || "—"}</div>
            <Sparkline
              className="mt-1 ml-auto"
              values={(pack.history || []).map((point) => point.stars)}
            />
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {pack.category ? (
            <Badge className={badgeClassName} variant="muted">
              {pack.category}
            </Badge>
          ) : null}
          {pack.installedHarnesses.length > 0 ? (
            <Badge className={badgeClassName} variant="success">
              Installed ({pack.installedHarnesses.join(", ")})
            </Badge>
          ) : (
            <Badge className={badgeClassName} variant="muted">
              Not installed
            </Badge>
          )}
          {pack.usageCount ? (
            <Badge className={badgeClassName} variant="muted">
              {pack.usageCount} uses
            </Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {pack.description ? (
          <p className="text-muted-foreground text-sm">{pack.description}</p>
        ) : null}
        {pack.placeholderReason ? (
          <p className="text-amber-700 text-xs italic">
            {pack.placeholderReason}
          </p>
        ) : null}
        {pack.installNotes ? (
          <p className="text-muted-foreground text-xs">{pack.installNotes}</p>
        ) : null}
        {pack.usage ? (
          <div className="text-muted-foreground text-xs">
            Used {pack.usage.toolCalls} times across {pack.usage.sessions}{" "}
            sessions.
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={!onSelect}
            onClick={() => onSelect?.(pack.id)}
            size="sm"
            variant="secondary"
          >
            View details
          </Button>
          {pack.harnesses.map((harness) => (
            <Button
              disabled={!onInstallPack}
              key={harness}
              onClick={() => onInstallPack?.(pack.id, harness)}
              size="sm"
              variant="outline"
            >
              {pack.installedHarnesses.includes(harness)
                ? "Uninstall"
                : "Install"}{" "}
              {harness}
            </Button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
