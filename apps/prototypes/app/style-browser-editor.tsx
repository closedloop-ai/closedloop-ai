"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { FileCode2Icon, PaintbrushIcon, RotateCcwIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ResponsiveLayouts } from "react-grid-layout";
import { StyleCanvas } from "./style-browser-canvas";
import {
  type StyleCatalogItem,
  StyleCatalogPivot,
  StyleCatalogRail,
} from "./style-browser-catalog-rail";
import { buildColorConflictMap } from "./style-browser-color-conflicts";
import {
  primaryTaxonomyGroupForToken,
  type StyleTaxonomyGroup,
  styleCanvasLayouts,
  styleTaxonomyGroups,
  type TokenDefinition,
  type TokenEdits,
  tokensForTaxonomyGroup,
} from "./style-browser-editor-data";
import { ExportPanel } from "./style-browser-export-panel";
import { StyleInspector } from "./style-browser-inspector";
import {
  applyStyleLabPreviewStyle,
  clearPersistedStyleLabSession,
  type PersistedStyleLabSession,
  readPersistedStyleLabSession,
  writePersistedStyleLabSession,
} from "./style-browser-persistence";
import { tokenDefinitions } from "./style-browser-token-manifest.generated";
import {
  type AddedTokenDefinition,
  buildExportPayload,
  buildGeneratedSpec,
  buildPreviewStyle,
  buildTokenChanges,
} from "./style-browser-token-operations";

export function StyleBrowserEditor() {
  const baseTokensById = useMemo(() => buildTokenIndex(tokenDefinitions), []);
  const [selectedGroupId, setSelectedGroupId] = useState(
    styleTaxonomyGroups[0].id
  );
  const [selectedToken, setSelectedToken] = useState<TokenDefinition>(
    firstTokenForGroup(styleTaxonomyGroups[0], baseTokensById)
  );
  const [edits, setEdits] = useState<TokenEdits>({});
  const [addedTokens, setAddedTokens] = useState<AddedTokenDefinition[]>([]);
  const [removedTokenIds, setRemovedTokenIds] = useState<string[]>([]);
  const [showExport, setShowExport] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [canvasLayouts, setCanvasLayouts] =
    useState<ResponsiveLayouts>(styleCanvasLayouts);
  const [canvasZoom, setCanvasZoom] = useState(1);
  const [isSessionRestored, setIsSessionRestored] = useState(false);
  const [catalogPivot, setCatalogPivot] = useState<StyleCatalogPivot>(
    StyleCatalogPivot.Taxonomy
  );

  const selectedGroup = useMemo(() => {
    return (
      styleTaxonomyGroups.find(
        (candidate) => candidate.id === selectedGroupId
      ) ?? styleTaxonomyGroups[0]
    );
  }, [selectedGroupId]);
  const allTokens = useMemo(
    () => [...tokenDefinitions, ...addedTokens],
    [addedTokens]
  );
  const colorConflicts = useMemo(
    () => buildColorConflictMap({ edits, tokens: allTokens }),
    [allTokens, edits]
  );
  const tokensById = useMemo(() => buildTokenIndex(allTokens), [allTokens]);
  const addedTokenIds = useMemo(
    () => new Set(addedTokens.map((token) => token.id)),
    [addedTokens]
  );
  const removedTokenIdSet = useMemo(
    () => new Set(removedTokenIds),
    [removedTokenIds]
  );
  const tokenChanges = useMemo(
    () =>
      buildTokenChanges({
        addedTokens,
        baseTokens: tokenDefinitions,
        edits,
        removedTokenIds: removedTokenIdSet,
      }),
    [addedTokens, edits, removedTokenIdSet]
  );
  const previewStyle = useMemo(
    () => buildPreviewStyle(tokenChanges),
    [tokenChanges]
  );
  const changedTokenIds = useMemo(
    () => new Set(tokenChanges.map((change) => change.token.id)),
    [tokenChanges]
  );
  const generatedSpec = useMemo(
    () => buildGeneratedSpec(tokenChanges),
    [tokenChanges]
  );
  const exportPayload = useMemo(
    () => buildExportPayload(tokenChanges),
    [tokenChanges]
  );

  useEffect(() => {
    const session = readPersistedStyleLabSession();
    if (session) {
      const restoredTokensById = buildTokenIndex([
        ...tokenDefinitions,
        ...session.addedTokens,
      ]);
      const restoredGroup =
        styleTaxonomyGroups.find((group) => {
          return group.id === session.selectedGroupId;
        }) ?? styleTaxonomyGroups[0];
      setEdits(session.edits);
      setAddedTokens(session.addedTokens);
      setRemovedTokenIds(session.removedTokenIds);
      setSelectedGroupId(restoredGroup.id);
      setSelectedToken(
        restoredTokensById[session.selectedTokenId ?? ""] ??
          firstTokenForGroup(restoredGroup, restoredTokensById)
      );
      setCatalogPivot(parsePersistedCatalogPivot(session.catalogPivot));
      setCanvasLayouts(session.canvasLayouts ?? styleCanvasLayouts);
      setCanvasZoom(session.canvasZoom ?? 1);
    }
    setIsSessionRestored(true);
  }, []);

  useEffect(() => {
    applyStyleLabPreviewStyle(previewStyle);
  }, [previewStyle]);

  useEffect(() => {
    if (!isSessionRestored) {
      return;
    }
    const session = {
      addedTokens,
      canvasLayouts,
      canvasZoom,
      catalogPivot,
      edits,
      removedTokenIds,
      selectedGroupId,
      selectedTokenId: selectedToken.id,
      version: 1,
    } satisfies PersistedStyleLabSession;
    if (isDefaultStyleLabSession(session)) {
      clearPersistedStyleLabSession();
      return;
    }
    writePersistedStyleLabSession(session);
  }, [
    addedTokens,
    canvasLayouts,
    canvasZoom,
    catalogPivot,
    edits,
    isSessionRestored,
    removedTokenIds,
    selectedGroupId,
    selectedToken.id,
  ]);

  const updateToken = (token: TokenDefinition, value: string) => {
    setSelectedToken(token);
    setEdits((current) => {
      if (!addedTokenIds.has(token.id) && value === token.initialValue) {
        const next = { ...current };
        Reflect.deleteProperty(next, token.id);
        return next;
      }
      return { ...current, [token.id]: value };
    });
    setShowExport(false);
  };
  const addToken = (token: AddedTokenDefinition, value: string) => {
    setAddedTokens((current) => [...current, token]);
    setRemovedTokenIds((current) =>
      current.filter((tokenId) => tokenId !== token.id)
    );
    setEdits((current) => ({ ...current, [token.id]: value }));
    setSelectedGroupId(token.groupId);
    setSelectedToken(token);
    setShowExport(false);
    panCanvasToGroup(token.groupId);
  };
  const removeToken = (token: TokenDefinition) => {
    if (addedTokenIds.has(token.id)) {
      discardAddedToken(token);
      return;
    }
    setSelectedToken(token);
    setRemovedTokenIds((current) =>
      current.includes(token.id) ? current : [...current, token.id]
    );
    setEdits((current) => {
      const next = { ...current };
      Reflect.deleteProperty(next, token.id);
      return next;
    });
    setShowExport(false);
  };
  const restoreToken = (token: TokenDefinition) => {
    setSelectedToken(token);
    setRemovedTokenIds((current) =>
      current.filter((tokenId) => tokenId !== token.id)
    );
    setShowExport(false);
  };
  const resetSelectedToken = () => {
    if (addedTokenIds.has(selectedToken.id)) {
      discardAddedToken(selectedToken);
      return;
    }
    if (removedTokenIdSet.has(selectedToken.id)) {
      restoreToken(selectedToken);
      return;
    }
    updateToken(selectedToken, selectedToken.initialValue);
  };
  const resetAll = () => {
    const defaultGroup = styleTaxonomyGroups[0];
    const defaultToken = firstTokenForGroup(defaultGroup, baseTokensById);
    setEdits({});
    setAddedTokens([]);
    setRemovedTokenIds([]);
    setCanvasLayouts(styleCanvasLayouts);
    setCanvasZoom(1);
    setSelectedGroupId(defaultGroup.id);
    setSelectedToken(defaultToken);
    setShowExport(false);
    clearPersistedStyleLabSession();
  };
  const selectGroup = (groupId: string) => {
    const group = styleTaxonomyGroups.find((candidate) => {
      return candidate.id === groupId;
    });
    if (!group) {
      return;
    }
    setSelectedGroupId(group.id);
    setSelectedToken(firstTokenForGroup(group, tokensById));
    setShowExport(false);
    panCanvasToGroup(group.id);
  };
  const selectToken = (token: TokenDefinition) => {
    setSelectedToken(token);
    const owningGroup = primaryTaxonomyGroupForToken(token);
    if (owningGroup) {
      setSelectedGroupId(owningGroup.id);
      panCanvasToGroup(owningGroup.id);
    }
    setShowExport(false);
  };
  const selectCatalogItem = (item: StyleCatalogItem) => {
    const firstToken = item.tokens[0];
    if (firstToken) {
      selectToken(firstToken);
      return;
    }
    selectGroup(item.groupId);
  };
  const discardAddedToken = (token: TokenDefinition) => {
    const fallbackGroupId = token.groupId ?? selectedGroup.id;
    const fallbackGroup =
      styleTaxonomyGroups.find((group) => group.id === fallbackGroupId) ??
      selectedGroup;
    setAddedTokens((current) =>
      current.filter((candidate) => candidate.id !== token.id)
    );
    setEdits((current) => {
      const next = { ...current };
      Reflect.deleteProperty(next, token.id);
      return next;
    });
    setSelectedToken(firstTokenForGroup(fallbackGroup, baseTokensById));
    setShowExport(false);
  };

  return (
    <section
      aria-label="Style taxonomy editor"
      className="flex min-h-[calc(100vh-4.25rem)] flex-col overflow-hidden bg-background lg:h-[calc(100vh-4.25rem)]"
      style={previewStyle}
    >
      <div className="flex flex-col gap-3 border-b px-3 py-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid size-8 shrink-0 place-items-center rounded-md border bg-muted/50">
            <PaintbrushIcon className="size-4 text-muted-foreground" />
          </span>
          <div className="min-w-0">
            <h2 className="truncate font-medium text-sm">Closedloop styles</h2>
            <p className="truncate text-muted-foreground text-xs">
              A direct-to-code atlas for typography, color, shape, density,
              assets, and Storybook style reconciliation.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-xs">
            {tokenChanges.length} changes
          </span>
          <Button
            className="style-lab-control"
            disabled={tokenChanges.length === 0}
            onClick={resetAll}
            size="sm"
            type="button"
            variant="outline"
          >
            <RotateCcwIcon />
            Reset all
          </Button>
          <Button
            className="style-lab-control"
            onClick={() => setShowExport((current) => !current)}
            size="sm"
            type="button"
            variant={showExport ? "default" : "outline"}
          >
            <FileCode2Icon />
            Export PR
          </Button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[15rem_minmax(0,1fr)_22rem]">
        <StyleCatalogRail
          catalogPivot={catalogPivot}
          changedTokenIds={changedTokenIds}
          groups={styleTaxonomyGroups}
          onCatalogPivotChange={setCatalogPivot}
          onQueryChange={setSearchQuery}
          onSelectCatalogItem={selectCatalogItem}
          query={searchQuery}
          selectedGroupId={selectedGroupId}
          tokensById={tokensById}
        />
        <StyleCanvas
          addedTokenIds={addedTokenIds}
          colorConflicts={colorConflicts}
          edits={edits}
          groups={styleTaxonomyGroups}
          layouts={canvasLayouts}
          onAddToken={addToken}
          onLayoutsChange={setCanvasLayouts}
          onSelectGroup={selectGroup}
          onSelectToken={selectToken}
          onZoomChange={setCanvasZoom}
          previewStyle={previewStyle}
          removedTokenIds={removedTokenIdSet}
          selectedGroupId={selectedGroupId}
          selectedToken={selectedToken}
          tokensById={tokensById}
          zoom={canvasZoom}
        />
        <aside className="min-h-0 overflow-auto border-t bg-background lg:border-t-0 lg:border-l">
          {showExport ? (
            <ExportPanel
              exportPayload={exportPayload}
              generatedSpec={generatedSpec}
              tokenChanges={tokenChanges}
            />
          ) : (
            <StyleInspector
              addedTokenIds={addedTokenIds}
              colorConflicts={colorConflicts}
              edits={edits}
              onAddToken={addToken}
              onRemoveToken={removeToken}
              onResetToken={resetSelectedToken}
              onRestoreToken={restoreToken}
              onTokenChange={updateToken}
              removedTokenIds={removedTokenIdSet}
              selectedGroup={selectedGroup}
              selectedToken={selectedToken}
              tokensById={tokensById}
            />
          )}
        </aside>
      </div>
    </section>
  );
}

function buildTokenIndex(tokens: readonly TokenDefinition[]) {
  return Object.fromEntries(tokens.map((token) => [token.id, token])) as Record<
    string,
    TokenDefinition
  >;
}

function firstTokenForGroup(
  group: StyleTaxonomyGroup,
  tokensById: Readonly<Record<string, TokenDefinition>>
): TokenDefinition {
  const firstToken = tokensForTaxonomyGroup(group, tokensById)[0];
  const fallbackToken = tokenDefinitions[0];
  if (!fallbackToken) {
    throw new Error("Style Lab token manifest is empty.");
  }
  return firstToken ?? fallbackToken;
}

function parsePersistedCatalogPivot(value: string | undefined) {
  if (value === StyleCatalogPivot.Category) {
    return StyleCatalogPivot.Category;
  }
  if (value === StyleCatalogPivot.Scope) {
    return StyleCatalogPivot.Scope;
  }
  if (value === StyleCatalogPivot.Source) {
    return StyleCatalogPivot.Source;
  }
  return StyleCatalogPivot.Taxonomy;
}

function panCanvasToGroup(groupId: string) {
  globalThis.setTimeout(() => {
    const documentRef = globalThis.document;
    if (!documentRef) {
      return;
    }
    const canvasElement =
      documentRef.querySelector<HTMLDivElement>(".style-lab-canvas");
    const groupElement = documentRef.querySelector<HTMLElement>(
      `[data-style-group-id="${groupId}"]`
    );
    if (!(canvasElement && groupElement)) {
      return;
    }
    const canvasRect = canvasElement.getBoundingClientRect();
    const groupRect = groupElement.getBoundingClientRect();
    canvasElement.scrollTo({
      behavior: "auto",
      left: Math.max(
        0,
        canvasElement.scrollLeft +
          groupRect.left -
          canvasRect.left -
          STYLE_CANVAS_PAN_OFFSET
      ),
      top: Math.max(
        0,
        canvasElement.scrollTop +
          groupRect.top -
          canvasRect.top -
          STYLE_CANVAS_PAN_OFFSET
      ),
    });
  }, 50);
}

const STYLE_CANVAS_PAN_OFFSET = 84;

function isDefaultStyleLabSession(session: PersistedStyleLabSession): boolean {
  const defaultGroup = styleTaxonomyGroups[0];
  const defaultTokenId = defaultGroup.tokenIds[0] ?? tokenDefinitions[0]?.id;
  return (
    session.addedTokens.length === 0 &&
    Object.keys(session.edits).length === 0 &&
    session.removedTokenIds.length === 0 &&
    session.selectedGroupId === defaultGroup.id &&
    session.selectedTokenId === defaultTokenId &&
    session.catalogPivot === StyleCatalogPivot.Taxonomy &&
    session.canvasZoom === 1 &&
    JSON.stringify(session.canvasLayouts) === JSON.stringify(styleCanvasLayouts)
  );
}
