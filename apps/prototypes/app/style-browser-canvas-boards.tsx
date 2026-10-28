"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import {
  GitHubMark,
  GoogleGlyph,
} from "@repo/design-system/components/ui/brand-icons";
import { Button } from "@repo/design-system/components/ui/button";
import { cn } from "@repo/design-system/lib/utils";
import { GripVerticalIcon } from "lucide-react";
import Image from "next/image";
import { brandMarkSrc } from "@/lib/brand-mark";
import {
  desktopGridColumns,
  layoutPreviewSize,
  layoutPreviewWidth,
  logoPreviewStyle,
  mobileGridColumns,
  shapePreviewStyle,
  typographyPreviewStyle,
  typographySample,
} from "./style-browser-canvas-preview-utils";
import {
  TokenTile,
  type TokenTileContext,
} from "./style-browser-canvas-token-tile";
import { CatalogBoard } from "./style-browser-catalog-board";
import type { ColorConflict } from "./style-browser-color-conflicts";
import {
  iconSpecimens,
  type StyleTaxonomyGroup,
  StyleTaxonomyGroupKind,
  type TokenDefinition,
  type TokenEdits,
} from "./style-browser-editor-data";
import { headingSpecimens } from "./style-browser-heading-specimens";
import { ReconciliationBoard } from "./style-browser-reconciliation-board";
import type { AddedTokenDefinition } from "./style-browser-token-operations";

export function StyleBoard({
  group,
  tokens,
  edits,
  selectedToken,
  addedTokenIds,
  removedTokenIds,
  colorConflicts,
  isSelected,
  onAddToken,
  onSelectGroup,
  onSelectToken,
  tokensById,
}: {
  group: StyleTaxonomyGroup;
  tokens: readonly TokenDefinition[];
  edits: TokenEdits;
  selectedToken: TokenDefinition;
  addedTokenIds: ReadonlySet<string>;
  removedTokenIds: ReadonlySet<string>;
  colorConflicts: ReadonlyMap<string, ColorConflict>;
  isSelected: boolean;
  tokensById: Readonly<Record<string, TokenDefinition>>;
  onAddToken: (token: AddedTokenDefinition, value: string) => void;
  onSelectGroup: (groupId: string) => void;
  onSelectToken: (token: TokenDefinition) => void;
}) {
  return (
    <section
      className={cn(
        "flex h-full min-h-0 flex-col rounded-md border bg-background text-foreground shadow-sm",
        isSelected
          ? "border-primary/50 ring-2 ring-primary/15"
          : "border-border"
      )}
    >
      <div className="flex shrink-0 items-start gap-2 border-b px-3 py-2">
        <GripVerticalIcon className="style-lab-drag-handle mt-0.5 size-4 cursor-move text-muted-foreground" />
        <Button
          className="style-lab-control h-auto min-w-0 flex-1 justify-start whitespace-normal p-0 text-left font-normal hover:bg-transparent"
          onClick={() => onSelectGroup(group.id)}
          type="button"
          variant="ghost"
        >
          <span className="block min-w-0">
            <span className="block font-medium text-sm">{group.label}</span>
            <span className="mt-0.5 block text-muted-foreground text-xs">
              {group.description}
            </span>
          </span>
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <BoardContent
          addedTokenIds={addedTokenIds}
          colorConflicts={colorConflicts}
          edits={edits}
          group={group}
          onAddToken={onAddToken}
          onSelectToken={onSelectToken}
          removedTokenIds={removedTokenIds}
          selectedToken={selectedToken}
          tokens={tokens}
          tokensById={tokensById}
        />
      </div>
    </section>
  );
}

function BoardContent({
  group,
  tokens,
  edits,
  selectedToken,
  addedTokenIds,
  removedTokenIds,
  colorConflicts,
  onAddToken,
  onSelectToken,
  tokensById,
}: BoardProps & { group: StyleTaxonomyGroup }) {
  const props = {
    addedTokenIds,
    colorConflicts,
    edits,
    onAddToken,
    onSelectToken,
    removedTokenIds,
    selectedToken,
    tokens,
    tokensById,
  };
  switch (group.kind) {
    case StyleTaxonomyGroupKind.Asset:
      return <AssetBoard {...props} />;
    case StyleTaxonomyGroupKind.Catalog:
      return <CatalogBoard {...props} />;
    case StyleTaxonomyGroupKind.Color:
      return <ColorBoard {...props} />;
    case StyleTaxonomyGroupKind.Grid:
      return <GridBoard {...props} />;
    case StyleTaxonomyGroupKind.Icon:
      return <IconBoard {...props} />;
    case StyleTaxonomyGroupKind.Layout:
      return <LayoutBoard {...props} />;
    case StyleTaxonomyGroupKind.Logo:
      return <LogoBoard {...props} />;
    case StyleTaxonomyGroupKind.Reconciliation:
      return <ReconciliationBoard {...props} />;
    case StyleTaxonomyGroupKind.Shape:
      return <ShapeBoard {...props} />;
    case StyleTaxonomyGroupKind.Type:
      return <TypographyBoard {...props} />;
    default: {
      const exhaustiveCheck: never = group.kind;
      return exhaustiveCheck;
    }
  }
}

function ColorBoard(props: BoardProps) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
      {props.tokens.map((token) => (
        <TokenTile key={token.id} token={token} {...props}>
          <span
            className="block h-20 rounded-sm border shadow-inset"
            style={{ background: `var(--${token.cssName})` }}
          />
        </TokenTile>
      ))}
    </div>
  );
}

function TypographyBoard(props: BoardProps) {
  return (
    <div className="grid gap-3">
      <div className="grid gap-2 rounded-md border bg-muted/20 p-3">
        <p className="text-muted-foreground text-xs">Live type specimen</p>
        <p
          className="leading-tight"
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: "calc(var(--text-lg) * 1.2)",
            fontWeight: "var(--font-weight-bold)",
          }}
        >
          Branch review summary
        </p>
        <p
          className="text-foreground leading-snug"
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-base)",
          }}
        >
          Product text should stay readable in dense tables, cards, and nested
          review panels without designers leaving the code-backed catalog.
        </p>
        <div className="grid gap-1 rounded-sm border bg-background p-2">
          <p
            className="text-muted-foreground"
            style={{ fontSize: "var(--text-xs)" }}
          >
            Metadata label - updated 2m ago
          </p>
          <p
            className="text-foreground"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-sm)",
            }}
          >
            feature/prototype-style-lab
          </p>
        </div>
      </div>
      <div className="grid gap-2 rounded-md border bg-muted/20 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-medium text-sm">Production heading scale</p>
          <Badge variant="outline">Raw utilities</Badge>
        </div>
        <p className="text-muted-foreground text-xs">
          These H1-H5 recipes are used in app, desktop, and Storybook surfaces
          but are not tokenized as named typography variants yet.
        </p>
        <div className="grid gap-2">
          {headingSpecimens.map((specimen) => (
            <div
              className="grid gap-1 rounded-sm border bg-background p-2"
              key={specimen.level}
            >
              <div className="flex min-w-0 items-start justify-between gap-2">
                <p className={cn("min-w-0 break-words", specimen.className)}>
                  {specimen.sample}
                </p>
                <Badge className="shrink-0" variant="outline">
                  {specimen.level}
                </Badge>
              </div>
              <code className="break-words text-muted-foreground text-xs">
                {specimen.source}
              </code>
            </div>
          ))}
        </div>
      </div>
      <div className="grid gap-2">
        {props.tokens.map((token) => (
          <TokenTile key={token.id} token={token} {...props}>
            <span
              className="block leading-snug"
              style={typographyPreviewStyle(token)}
            >
              {typographySample(token)}
            </span>
          </TokenTile>
        ))}
      </div>
    </div>
  );
}

function GridBoard(props: BoardProps) {
  return (
    <div className="grid gap-3">
      <div className="rounded-md border bg-muted/20 p-3">
        <div className="grid grid-cols-12 gap-1">
          {desktopGridColumns.map((column) => (
            <span
              className="h-16 rounded-sm border bg-primary/10"
              key={column}
            />
          ))}
        </div>
        <div className="mt-2 grid grid-cols-4 gap-1">
          {mobileGridColumns.map((column) => (
            <span className="h-8 rounded-sm border bg-info/10" key={column} />
          ))}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {["sticky", "overlay", "modal", "popover", "toast"].map((layer) => (
          <div className="rounded-sm border bg-background p-2" key={layer}>
            <p className="text-muted-foreground text-xs">{layer}</p>
            <div
              className="mt-2 h-7 rounded-sm bg-primary/15"
              style={{ zIndex: `var(--z-${layer})` }}
            />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {props.tokens.map((token) => (
          <TokenTile key={token.id} token={token} {...props}>
            <span className="flex h-14 items-center rounded-sm border bg-muted/40 p-2">
              <span
                className="block rounded-sm bg-primary"
                style={{
                  height: layoutPreviewSize(token),
                  width: layoutPreviewWidth(token),
                }}
              />
            </span>
          </TokenTile>
        ))}
      </div>
    </div>
  );
}

function LogoBoard(props: BoardProps) {
  return (
    <div className="grid gap-3">
      <div
        className="rounded-md border p-4 text-white"
        style={{ background: "var(--brand-gradient)" }}
      >
        <div className="flex items-center gap-3">
          <Image
            alt=""
            className="rounded-md"
            height={48}
            src={brandMarkSrc}
            width={48}
          />
          <div>
            <p className="font-semibold text-lg leading-none">Closedloop</p>
            <p className="mt-1 text-white/80 text-xs">Brand gradient lockup</p>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="grid h-20 place-items-center rounded-md border bg-background">
          <GoogleGlyph height={28} width={28} />
        </div>
        <div className="grid h-20 place-items-center rounded-md border bg-background text-foreground">
          <GitHubMark height={28} width={28} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {props.tokens.map((token) => (
          <TokenTile key={token.id} token={token} {...props}>
            <span
              className="block h-14 rounded-sm border shadow-inset"
              style={logoPreviewStyle(token)}
            />
          </TokenTile>
        ))}
      </div>
    </div>
  );
}

function AssetBoard(props: BoardProps) {
  return (
    <div className="grid gap-3">
      <div
        className="flex h-24 items-end rounded-md border p-3 text-white"
        style={{ background: "var(--brand-gradient)" }}
      >
        <span className="rounded-full border border-white/40 bg-white/10 px-2 py-1 text-xs">
          Hero gradient asset
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-md border p-3">
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <span
              className="block h-full w-2/3 rounded-full"
              style={{ background: "var(--progress-foreground)" }}
            />
          </div>
          <Badge className="mt-3" variant="outline">
            Progress badge
          </Badge>
        </div>
        <div
          className="rounded-md border p-3"
          style={{
            background: "var(--sidebar)",
            color: "var(--sidebar-foreground)",
          }}
        >
          <div className="rounded-sm border px-2 py-1 text-xs">
            Sidebar chrome
          </div>
          <div className="mt-2 h-7 rounded-sm bg-sidebar-accent" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
        {props.tokens.map((token) => (
          <TokenTile key={token.id} token={token} {...props}>
            <span
              className="block h-14 rounded-sm border shadow-inset"
              style={{ background: `var(--${token.cssName})` }}
            />
          </TokenTile>
        ))}
      </div>
    </div>
  );
}

function ShapeBoard(props: BoardProps) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {props.tokens.map((token) => (
        <TokenTile key={token.id} token={token} {...props}>
          <span
            className="block h-16 border bg-muted/50"
            style={shapePreviewStyle(token)}
          />
        </TokenTile>
      ))}
    </div>
  );
}

function LayoutBoard(props: BoardProps) {
  return (
    <div className="grid gap-3">
      {props.tokens.map((token) => (
        <TokenTile key={token.id} token={token} {...props}>
          <span className="flex h-14 items-center rounded-sm border bg-muted/40 p-2">
            <span
              className="block rounded-sm bg-primary"
              style={{
                height: layoutPreviewSize(token),
                width: layoutPreviewWidth(token),
              }}
            />
          </span>
        </TokenTile>
      ))}
    </div>
  );
}

function IconBoard(props: BoardProps) {
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-2">
        {iconSpecimens.map((Icon) => (
          <span
            className="grid size-10 place-items-center rounded-sm border bg-muted/40 text-foreground"
            key={Icon.displayName ?? Icon.name}
          >
            <Icon className="size-icon-md" />
          </span>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {props.tokens.map((token) => (
          <TokenTile key={token.id} token={token} {...props}>
            <span className="grid h-16 place-items-center rounded-sm border bg-muted/40">
              <SquareIconPreview token={token} />
            </span>
          </TokenTile>
        ))}
      </div>
    </div>
  );
}

function SquareIconPreview({ token }: { token: TokenDefinition }) {
  return (
    <span
      className="block rounded-sm bg-primary"
      style={{
        height: `var(--${token.cssName})`,
        width: `var(--${token.cssName})`,
      }}
    />
  );
}

type BoardProps = TokenTileContext & {
  tokens: readonly TokenDefinition[];
  tokensById: Readonly<Record<string, TokenDefinition>>;
  onAddToken: (token: AddedTokenDefinition, value: string) => void;
};
