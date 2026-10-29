"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { PlusIcon } from "lucide-react";
import {
  typographyPreviewStyle,
  typographySample,
} from "./style-browser-canvas-preview-utils";
import {
  TokenTile,
  type TokenTileContext,
} from "./style-browser-canvas-token-tile";
import {
  StyleTokenScope,
  styleReconciliationGroupId,
  TokenCategory,
  type TokenDefinition,
} from "./style-browser-editor-data";
import {
  type StyleReconciliationItem,
  type StyleReconciliationSwatch,
  styleReconciliationItems,
} from "./style-browser-reconciliation-data";
import type { AddedTokenDefinition } from "./style-browser-token-operations";

export function ReconciliationBoard(
  props: TokenTileContext & {
    tokens: readonly TokenDefinition[];
    tokensById: Readonly<Record<string, TokenDefinition>>;
    onAddToken: (token: AddedTokenDefinition, value: string) => void;
  }
) {
  return (
    <div className="grid gap-3">
      {styleReconciliationItems.map((item) => (
        <ReconciliationItemCard
          item={item}
          key={item.id}
          onAddToken={props.onAddToken}
          onSelectToken={props.onSelectToken}
          tokensById={props.tokensById}
        />
      ))}
      <div className="grid grid-cols-2 gap-2">
        {props.tokens.map((token) => (
          <TokenTile key={token.id} token={token} {...props}>
            <ReconciliationTokenPreview token={token} />
          </TokenTile>
        ))}
      </div>
    </div>
  );
}

function ReconciliationTokenPreview({ token }: { token: TokenDefinition }) {
  if (token.category === TokenCategory.Type) {
    return (
      <span
        className="block min-h-12 rounded-sm border bg-background p-2 leading-snug"
        style={typographyPreviewStyle(token)}
      >
        {typographySample(token)}
      </span>
    );
  }
  if (token.category === TokenCategory.Color) {
    return (
      <span
        className="block h-12 rounded-sm border shadow-inset"
        style={{ background: `var(--${token.cssName})` }}
      />
    );
  }
  return (
    <span
      className="block h-12 rounded-sm border bg-primary/20"
      style={{ borderRadius: `var(--${token.cssName})` }}
    />
  );
}

function ReconciliationItemCard({
  item,
  tokensById,
  onAddToken,
  onSelectToken,
}: {
  item: StyleReconciliationItem;
  tokensById: Readonly<Record<string, TokenDefinition>>;
  onAddToken: (token: AddedTokenDefinition, value: string) => void;
  onSelectToken: (token: TokenDefinition) => void;
}) {
  const selectOrCreateOverrideToken = (swatch: StyleReconciliationSwatch) => {
    const canonicalToken = swatch.tokenId ? tokensById[swatch.tokenId] : null;
    if (canonicalToken) {
      onSelectToken(canonicalToken);
      return;
    }
    const cssName = tokenNameForSwatch(item, swatch);
    const tokenId = `${StyleTokenScope.Root}:${cssName}`;
    const existingToken = tokensById[tokenId];
    if (existingToken) {
      onSelectToken(existingToken);
      return;
    }
    const value = swatch.overrideValue ?? swatch.value;
    onAddToken(
      {
        category: swatch.overrideCategory ?? TokenCategory.Color,
        cssName,
        groupId: styleReconciliationGroupId,
        id: tokenId,
        initialValue: value,
        label: toLabel(cssName),
        scope: StyleTokenScope.Root,
      },
      value
    );
  };

  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium text-sm">{item.label}</p>
        <Badge variant="outline">{item.status}</Badge>
      </div>
      <p className="mt-1 text-muted-foreground text-xs">{item.description}</p>
      <div className="mt-2 grid gap-1 text-xs">
        <code className="break-words text-muted-foreground">
          {item.sourcePath}
        </code>
        <code className="break-words text-muted-foreground">
          {item.storyPath}
        </code>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {item.swatches.map((swatch) => (
          <Button
            aria-label={`${swatch.tokenId ? "Open token" : "Create override token"} for ${item.label} ${swatch.name}`}
            className="style-lab-control h-auto min-w-0 justify-start gap-1 rounded-full border bg-background px-1.5 py-1 text-xs"
            key={`${item.id}-${swatch.name}`}
            onClick={() => selectOrCreateOverrideToken(swatch)}
            title={
              swatch.tokenId ? "Open canonical token" : "Create override token"
            }
            type="button"
            variant="ghost"
          >
            <span
              className="size-3 rounded-full border"
              style={{ background: swatch.value }}
            />
            {swatch.name}
            {swatch.sourceLabel ? (
              <code className="text-muted-foreground">
                {swatch.sourceLabel}
              </code>
            ) : null}
            {swatch.tokenId ? null : <PlusIcon className="size-3" />}
          </Button>
        ))}
      </div>
    </div>
  );
}

function tokenNameForSwatch(
  item: StyleReconciliationItem,
  swatch: StyleReconciliationSwatch
): string {
  const rawName =
    swatch.suggestedTokenName ?? `override-${item.id}-${swatch.name}`;
  const tokenName = rawName
    .trim()
    .toLowerCase()
    .replace(nonTokenCharacterPattern, "-")
    .replace(repeatedHyphenPattern, "-")
    .replace(edgeHyphenPattern, "");
  if (tokenName.length === 0) {
    return "style-override";
  }
  if (startsWithLetterPattern.test(tokenName)) {
    return tokenName;
  }
  return `style-${tokenName}`;
}

function toLabel(name: string): string {
  return name
    .split("-")
    .map((part) => {
      if (part === "ai") {
        return "AI";
      }
      return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
    })
    .join(" ");
}

const edgeHyphenPattern = /^-|-$/g;
const nonTokenCharacterPattern = /[^a-z0-9-]+/g;
const repeatedHyphenPattern = /-+/g;
const startsWithLetterPattern = /^[a-z]/;
