"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import {
  ChevronDownIcon,
  ClipboardIcon,
  DownloadIcon,
  FileCode2Icon,
} from "lucide-react";
import { useState } from "react";
import {
  type StyleTokenChange,
  StyleTokenOperation,
} from "./style-browser-token-operations";

export function ExportPanel({
  tokenChanges,
  generatedSpec,
  exportPayload,
}: {
  tokenChanges: readonly StyleTokenChange[];
  generatedSpec: string;
  exportPayload: string;
}) {
  const [copied, setCopied] = useState<ExportCopyTarget | null>(null);
  const prCommands = buildPrCommands(exportPayload);
  const presetBundle = buildPresetBundle(tokenChanges);
  const copyText = (target: ExportCopyTarget, text: string) => {
    const clipboard = globalThis.navigator?.clipboard;
    if (!clipboard) {
      setCopied(null);
      return;
    }
    clipboard.writeText(text).then(
      () => setCopied(target),
      () => setCopied(null)
    );
  };
  const downloadExport = () => {
    const documentRef = globalThis.document;
    const urlApi = globalThis.URL;
    if (!(documentRef && urlApi)) {
      return;
    }
    const blob = new Blob([exportPayload], { type: "application/json" });
    const url = urlApi.createObjectURL(blob);
    const anchor = documentRef.createElement("a");
    anchor.href = url;
    anchor.download = "style-lab-export.json";
    anchor.style.display = "none";
    documentRef.body.append(anchor);
    try {
      anchor.click();
    } finally {
      anchor.remove();
      urlApi.revokeObjectURL(url);
    }
  };

  return (
    <div className="grid gap-4 p-4">
      <div>
        <p className="font-medium text-sm">Export as a local PR</p>
        <p className="mt-1 text-muted-foreground text-xs">
          Download or copy the token bundle, then apply it with the prototype
          script to raise a design-system PR from this machine.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Button
          className="style-lab-control"
          disabled={tokenChanges.length === 0}
          onClick={downloadExport}
          size="sm"
          type="button"
          variant="outline"
        >
          <DownloadIcon />
          Download
        </Button>
        <Button
          className="style-lab-control"
          disabled={tokenChanges.length === 0}
          onClick={() => copyText(ExportCopyTarget.Json, exportPayload)}
          size="sm"
          type="button"
          variant="outline"
        >
          <ClipboardIcon />
          {copied === ExportCopyTarget.Json ? "Copied" : "Copy JSON"}
        </Button>
      </div>

      <div className="rounded-md border p-3">
        <p className="font-medium text-sm">Token changes</p>
        {tokenChanges.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {tokenChanges.map((change) => (
              <Badge
                key={`${change.operation}:${change.token.id}`}
                variant={operationBadgeVariant(change.operation)}
              >
                {change.operation} --{change.token.cssName}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-muted-foreground text-xs">
            Add, edit, or remove a token on the canvas to generate an export
            bundle.
          </p>
        )}
      </div>

      <ExportBlock label="CSS patch preview" value={generatedSpec} />
      <ExportBlock label="Preset handoff" value={presetBundle} />
      <ExportBlock label="JSON bundle" value={exportPayload} />
      <ExportBlock label="PR command path" value={prCommands} />

      <Button
        className="style-lab-control w-full"
        disabled={tokenChanges.length === 0}
        onClick={() => copyText(ExportCopyTarget.Commands, prCommands)}
        size="sm"
        type="button"
        variant="outline"
      >
        <FileCode2Icon />
        {copied === ExportCopyTarget.Commands
          ? "Commands copied"
          : "Copy PR commands"}
      </Button>
    </div>
  );
}

function operationBadgeVariant(operation: StyleTokenChange["operation"]) {
  switch (operation) {
    case StyleTokenOperation.Add:
      return "success";
    case StyleTokenOperation.Remove:
      return "destructive";
    case StyleTokenOperation.Update:
      return "info";
    default: {
      const exhaustiveCheck: never = operation;
      return exhaustiveCheck;
    }
  }
}

function buildPrCommands(exportPayload: string): string {
  return [
    "git checkout -b design/style-lab-token-edits",
    "cat > apps/prototypes/style-lab-export.json <<'STYLE_LAB_JSON'",
    exportPayload.trimEnd(),
    "STYLE_LAB_JSON",
    "pnpm -C apps/prototypes style-lab:apply apps/prototypes/style-lab-export.json",
    "pnpm --filter @repo/design-system test",
    "pnpm -C apps/prototypes typecheck",
    "pnpm -C apps/prototypes test",
    "git diff -- packages/design-system/styles/globals.css",
    "git add packages/design-system/styles/globals.css",
    'git commit -m "feat(design-system): apply style lab token edits"',
    'gh pr create --fill --label "design-system"',
  ].join("\n");
}

function buildPresetBundle(tokenChanges: readonly StyleTokenChange[]): string {
  return `${JSON.stringify(
    {
      name: "closedloop-style-lab",
      source: "packages/design-system/styles/globals.css",
      model: {
        componentLibrary: "@repo/design-system",
        exportPath: "local PR",
        icons: "lucide-react + design-system brand icons",
        previewSurface: "apps/prototypes",
        styleInputs: ["colors", "fonts", "icons", "radius", "assets"],
      },
      changes: tokenChanges.map((change) => ({
        name: change.token.cssName,
        operation: change.operation,
        scope: change.token.scope,
      })),
    },
    null,
    2
  )}\n`;
}

const ExportCopyTarget = {
  Json: "json",
  Commands: "commands",
} as const;

type ExportCopyTarget =
  (typeof ExportCopyTarget)[keyof typeof ExportCopyTarget];

function ExportBlock({ label, value }: { label: string; value: string }) {
  return (
    <Collapsible className="group rounded-md border bg-muted/20">
      <CollapsibleTrigger asChild>
        <Button
          className="style-lab-control h-auto w-full justify-between rounded-none px-3 py-2 text-left font-medium text-sm"
          type="button"
          variant="ghost"
        >
          {label}
          <ChevronDownIcon className="size-4 transition-transform group-data-[state=open]:rotate-180" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="max-h-56 overflow-auto border-t bg-background p-3 font-mono text-xs">
          {value}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}
