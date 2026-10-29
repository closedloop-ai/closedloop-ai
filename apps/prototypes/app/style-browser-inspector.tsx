"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { Label } from "@repo/design-system/components/ui/label";
import { Separator } from "@repo/design-system/components/ui/separator";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import {
  AlertTriangleIcon,
  RotateCcwIcon,
  Trash2Icon,
  Undo2Icon,
} from "lucide-react";
import type { CSSProperties } from "react";
import { AddTokenForm, ColorValueTools } from "./style-browser-add-token-form";
import type { ColorConflict } from "./style-browser-color-conflicts";
import {
  type StyleTaxonomyGroup,
  TokenCategory,
  type TokenDefinition,
  type TokenEdits,
} from "./style-browser-editor-data";
import type { AddedTokenDefinition } from "./style-browser-token-operations";

export function StyleInspector({
  selectedGroup,
  selectedToken,
  edits,
  colorConflicts,
  addedTokenIds,
  removedTokenIds,
  tokensById,
  onAddToken,
  onRemoveToken,
  onResetToken,
  onRestoreToken,
  onTokenChange,
}: {
  selectedGroup: StyleTaxonomyGroup;
  selectedToken: TokenDefinition;
  edits: TokenEdits;
  colorConflicts: ReadonlyMap<string, ColorConflict>;
  addedTokenIds: ReadonlySet<string>;
  removedTokenIds: ReadonlySet<string>;
  tokensById: Readonly<Record<string, TokenDefinition>>;
  onAddToken: (token: AddedTokenDefinition, value: string) => void;
  onRemoveToken: (token: TokenDefinition) => void;
  onResetToken: () => void;
  onRestoreToken: (token: TokenDefinition) => void;
  onTokenChange: (token: TokenDefinition, value: string) => void;
}) {
  const value = edits[selectedToken.id] ?? selectedToken.initialValue;
  const isAdded = addedTokenIds.has(selectedToken.id);
  const isRemoved = removedTokenIds.has(selectedToken.id);
  const isEdited = edits[selectedToken.id] !== undefined;
  const colorConflict = colorConflicts.get(selectedToken.id);
  return (
    <div className="grid gap-4 p-4">
      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="font-medium text-sm">Inspector</p>
          <div className="flex flex-wrap justify-end gap-1.5">
            {isAdded ? <Badge variant="success">Added</Badge> : null}
            {isRemoved ? <Badge variant="destructive">Removed</Badge> : null}
            {isEdited && !isAdded ? <Badge variant="info">Edited</Badge> : null}
          </div>
        </div>
        <InspectorPreview token={selectedToken} />
      </div>

      {colorConflict && !isRemoved ? (
        <div className="grid gap-2 rounded-md border border-warning/30 bg-warning/10 p-3 text-warning-foreground">
          <Badge className="w-fit" variant="warning">
            <AlertTriangleIcon />
            Visual overlap
          </Badge>
          <p className="text-xs">
            Close to --{colorConflict.nearestToken.cssName}. Use this as a
            prompt to merge, rename, or intentionally separate the roles before
            exporting a PR.
          </p>
        </div>
      ) : null}

      <div className="grid gap-2">
        <Label htmlFor="style-token-value">Token value</Label>
        <Textarea
          className="style-lab-control min-h-20 resize-none text-sm"
          disabled={isRemoved}
          id="style-token-value"
          onChange={(event) => onTokenChange(selectedToken, event.target.value)}
          value={value}
        />
      </div>

      {selectedToken.category === TokenCategory.Color && !isRemoved ? (
        <ColorValueTools
          onSelectValue={(nextValue) => onTokenChange(selectedToken, nextValue)}
        />
      ) : null}

      <div className="grid gap-2 text-xs">
        <TokenMetadata label="Name" value={`--${selectedToken.cssName}`} />
        <TokenMetadata label="Scope" value={selectedToken.scope} />
        <TokenMetadata
          label={isAdded ? "Initial export value" : "Original"}
          value={selectedToken.initialValue || "New token"}
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Button
          className="style-lab-control"
          disabled={!(isEdited || isAdded || isRemoved)}
          onClick={onResetToken}
          type="button"
          variant="outline"
        >
          <RotateCcwIcon />
          Reset
        </Button>
        {isRemoved ? (
          <Button
            className="style-lab-control"
            onClick={() => onRestoreToken(selectedToken)}
            type="button"
            variant="outline"
          >
            <Undo2Icon />
            Restore
          </Button>
        ) : (
          <Button
            className="style-lab-control"
            onClick={() => onRemoveToken(selectedToken)}
            type="button"
            variant="destructive"
          >
            <Trash2Icon />
            {isAdded ? "Discard" : "Remove"}
          </Button>
        )}
      </div>

      <Separator />

      <div className="grid gap-2">
        <p className="font-medium text-sm">Live preview</p>
        <p className="text-muted-foreground text-xs">
          Updates and new tokens are written to the prototype app root as CSS
          variables, so other prototypes inherit the same values while this tab
          stays open.
        </p>
      </div>

      <Separator />

      <AddTokenForm
        group={selectedGroup}
        onAddToken={onAddToken}
        tokensById={tokensById}
      />
    </div>
  );
}

function InspectorPreview({ token }: { token: TokenDefinition }) {
  if (token.category === TokenCategory.Color) {
    return (
      <div
        className="h-28 rounded-md border shadow-inset"
        style={{ background: `var(--${token.cssName})` }}
      />
    );
  }
  if (token.category === TokenCategory.Type) {
    return (
      <div className="grid gap-3 rounded-md border p-3">
        <p className="text-muted-foreground text-xs">Typography example</p>
        <p className="leading-snug" style={inspectorTypeStyle(token)}>
          Review-ready product copy should be easy to scan.
        </p>
        <p
          className="text-muted-foreground text-xs"
          style={inspectorTypeStyle(token)}
        >
          Metadata labels, branch names, and dense rows inherit this
          immediately.
        </p>
      </div>
    );
  }
  if (token.category === TokenCategory.Shape) {
    return (
      <div
        className="h-28 border bg-muted/50"
        style={inspectorShapeStyle(token)}
      />
    );
  }
  return (
    <div className="grid h-28 place-items-center rounded-md border bg-muted/40">
      <span
        className="block rounded-sm bg-primary"
        style={{
          height: `var(--${token.cssName})`,
          width: `var(--${token.cssName})`,
        }}
      />
    </div>
  );
}

function TokenMetadata({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 rounded-md border bg-muted/30 p-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="break-words text-foreground">{value}</span>
    </div>
  );
}

function inspectorTypeStyle(token: TokenDefinition): CSSProperties {
  if (token.cssName.startsWith("text-")) {
    return { fontSize: `var(--${token.cssName})` };
  }
  if (token.cssName === "font-weight-bold") {
    return { fontWeight: `var(--${token.cssName})` };
  }
  if (token.cssName === "font-mono") {
    return { fontFamily: `var(--${token.cssName})` };
  }
  if (token.cssName === "font-sans") {
    return { fontFamily: `var(--${token.cssName})` };
  }
  if (token.cssName.startsWith("heading-")) {
    return { font: `var(--${token.cssName})` };
  }
  return {};
}

function inspectorShapeStyle(token: TokenDefinition): CSSProperties {
  if (token.cssName.includes("shadow")) {
    return { boxShadow: `var(--${token.cssName})` };
  }
  return { borderRadius: `var(--${token.cssName})` };
}
