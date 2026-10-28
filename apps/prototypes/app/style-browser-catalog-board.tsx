"use client";

import {
  TokenTile,
  type TokenTileContext,
} from "./style-browser-canvas-token-tile";
import {
  TokenCategory,
  type TokenDefinition,
} from "./style-browser-editor-data";

export function CatalogBoard(
  props: TokenTileContext & { tokens: readonly TokenDefinition[] }
) {
  return (
    <div className="grid gap-3">
      <div className="grid gap-1 rounded-md border bg-muted/20 p-3">
        <p className="font-medium text-sm">Editable token manifest</p>
        <p className="text-muted-foreground text-xs">
          :root and @theme inline variables extracted from
          packages/design-system/styles/globals.css.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
        {props.tokens.map((token) => (
          <TokenTile key={token.id} token={token} {...props}>
            <TokenCatalogPreview token={token} />
          </TokenTile>
        ))}
      </div>
    </div>
  );
}

function TokenCatalogPreview({ token }: { token: TokenDefinition }) {
  if (token.category === TokenCategory.Color) {
    return (
      <span
        className="block h-12 rounded-sm border shadow-inset"
        style={{ background: `var(--${token.cssName})` }}
      />
    );
  }
  if (token.category === TokenCategory.Type) {
    return (
      <span className="block h-12 rounded-sm border bg-muted/30 p-2 leading-snug">
        <span style={typographyPreviewStyle(token)}>Aa</span>
      </span>
    );
  }
  if (token.category === TokenCategory.Shape) {
    return (
      <span
        className="block h-12 border bg-muted/50"
        style={shapePreviewStyle(token)}
      />
    );
  }
  return (
    <span className="flex h-12 items-center rounded-sm border bg-muted/40 p-2">
      <span
        className="block rounded-sm bg-primary"
        style={{
          height: layoutPreviewSize(token),
          width: layoutPreviewWidth(token),
        }}
      />
    </span>
  );
}

function typographyPreviewStyle(token: TokenDefinition) {
  if (token.cssName.startsWith("text-")) {
    return { fontSize: `var(--${token.cssName})` };
  }
  if (token.cssName === "font-weight-bold") {
    return { fontWeight: `var(--${token.cssName})` };
  }
  if (token.cssName === "font-mono" || token.cssName === "font-sans") {
    return { fontFamily: `var(--${token.cssName})` };
  }
  return {};
}

function shapePreviewStyle(token: TokenDefinition) {
  if (token.cssName.includes("shadow")) {
    return { boxShadow: `var(--${token.cssName})` };
  }
  return { borderRadius: `var(--${token.cssName})` };
}

function layoutPreviewSize(token: TokenDefinition): string {
  if (token.cssName.startsWith("density-")) {
    return "0.75rem";
  }
  return `var(--${token.cssName})`;
}

function layoutPreviewWidth(token: TokenDefinition): string {
  if (token.cssName.startsWith("density-")) {
    return `calc(var(--${token.cssName}) * 16)`;
  }
  return "100%";
}
