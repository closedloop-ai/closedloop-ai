import type { CliTool, CliToolState } from "@repo/app/agents/lib/session-types";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { Input } from "@repo/design-system/components/ui/input";
import { ToneBadge } from "@repo/design-system/components/ui/primitives/status-badge";
import { CheckCircle2, FileWarning, Search, Wrench } from "lucide-react";

const cliToolTone: Record<
  CliToolState,
  { label: string; tone: Parameters<typeof ToneBadge>[0]["tone"] }
> = {
  checking: { label: "Checking", tone: "info" },
  detected: { label: "Detected", tone: "success" },
  custom: { label: "Custom path", tone: "accent" },
  invalid: { label: "Invalid path", tone: "danger" },
  missing: { label: "Not found", tone: "warning" },
};

const cliToolIcon = {
  detected: CheckCircle2,
  custom: Wrench,
  invalid: FileWarning,
  missing: Search,
  checking: Search,
} satisfies Record<CliToolState, typeof Search>;

type CliToolsPanelProps = {
  tools: CliTool[];
  pathValues?: Record<string, string>;
  onPathChange?: (toolId: string, value: string) => void;
  onSavePath?: (tool: CliTool, value: string) => void;
  onResetPath?: (tool: CliTool) => void;
};

export function CliToolsPanel({
  tools,
  pathValues,
  onPathChange,
  onSavePath,
  onResetPath,
}: CliToolsPanelProps) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {tools.map((tool) => {
        const status = cliToolTone[tool.state];
        const Icon = cliToolIcon[tool.state];
        const pathValue = pathValues?.[tool.id] ?? tool.path;

        return (
          <Card className="border-border/80" key={tool.id}>
            <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
              <div className="space-y-1">
                <CardTitle className="text-base">{tool.name}</CardTitle>
                <CardDescription>{tool.description}</CardDescription>
              </div>
              <ToneBadge label={status.label} tone={status.tone} />
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-2 md:grid-cols-[1fr_auto]">
                <Input
                  aria-label={`Path to ${tool.name}`}
                  onChange={(event) =>
                    onPathChange?.(tool.id, event.target.value)
                  }
                  placeholder="Enter path to this tool"
                  value={pathValue}
                />
                <div className="flex gap-2">
                  <Button
                    disabled={!onSavePath}
                    onClick={() => onSavePath?.(tool, pathValue)}
                    size="sm"
                  >
                    Save
                  </Button>
                  <Button
                    disabled={!onResetPath}
                    onClick={() => onResetPath?.(tool)}
                    size="sm"
                    variant="outline"
                  >
                    Reset
                  </Button>
                </div>
              </div>
              <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/35 px-3 py-2 text-sm">
                <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <p className="text-muted-foreground">{tool.hint}</p>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
