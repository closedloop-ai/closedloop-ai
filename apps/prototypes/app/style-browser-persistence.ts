import type { CSSProperties } from "react";
import type { Layout, ResponsiveLayouts } from "react-grid-layout";
import {
  StyleTokenScope,
  TokenCategory,
  type TokenEdits,
} from "./style-browser-editor-data";
import type { AddedTokenDefinition } from "./style-browser-token-operations";

export type PersistedStyleLabSession = {
  version: 1;
  edits: TokenEdits;
  addedTokens: AddedTokenDefinition[];
  removedTokenIds: string[];
  selectedGroupId?: string;
  selectedTokenId?: string;
  catalogPivot?: string;
  canvasLayouts?: ResponsiveLayouts;
  canvasZoom?: number;
};

export function readPersistedStyleLabSession(): PersistedStyleLabSession | null {
  const storage = getStorage();
  if (!storage) {
    return null;
  }
  const rawSession = storage.getItem(STYLE_LAB_SESSION_STORAGE_KEY);
  if (!rawSession) {
    return null;
  }
  try {
    return normalizePersistedSession(JSON.parse(rawSession));
  } catch {
    removeStoredSession(storage);
    return null;
  }
}

export function writePersistedStyleLabSession(
  session: PersistedStyleLabSession
) {
  const storage = getStorage();
  if (!storage) {
    return;
  }
  try {
    storage.setItem(STYLE_LAB_SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    return;
  }
}

export function clearPersistedStyleLabSession() {
  const storage = getStorage();
  if (!storage) {
    return;
  }
  removeStoredSession(storage);
}

export function applyStyleLabPreviewStyle(style: CSSProperties) {
  const documentRef = globalThis.document;
  if (!documentRef) {
    return;
  }
  const root = documentRef.documentElement;
  const nextNames = Object.keys(style);
  const globalRef = globalThis as StyleLabGlobal;
  const previousNames = globalRef.__styleLabAppliedTokenNames ?? [];
  for (const name of previousNames) {
    if (!nextNames.includes(name)) {
      root.style.removeProperty(name);
    }
  }
  for (const [name, value] of Object.entries(style)) {
    root.style.setProperty(name, String(value));
  }
  globalRef.__styleLabAppliedTokenNames = nextNames;
}

function getStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function normalizePersistedSession(
  value: unknown
): PersistedStyleLabSession | null {
  if (!isRecord(value) || value.version !== 1) {
    return null;
  }
  return {
    addedTokens: normalizeAddedTokens(value.addedTokens),
    canvasLayouts: normalizeCanvasLayouts(value.canvasLayouts),
    canvasZoom: normalizeCanvasZoom(value.canvasZoom),
    catalogPivot:
      typeof value.catalogPivot === "string" ? value.catalogPivot : undefined,
    edits: normalizeTokenEdits(value.edits),
    removedTokenIds: normalizeStringArray(value.removedTokenIds),
    selectedGroupId:
      typeof value.selectedGroupId === "string"
        ? value.selectedGroupId
        : undefined,
    selectedTokenId:
      typeof value.selectedTokenId === "string"
        ? value.selectedTokenId
        : undefined,
    version: 1,
  };
}

function normalizeAddedTokens(value: unknown): AddedTokenDefinition[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((candidate) => {
    if (!isRecord(candidate)) {
      return [];
    }
    if (
      !(
        typeof candidate.category === "string" &&
        isTokenCategory(candidate.category) &&
        typeof candidate.cssName === "string" &&
        typeof candidate.groupId === "string" &&
        typeof candidate.id === "string" &&
        typeof candidate.initialValue === "string" &&
        typeof candidate.label === "string" &&
        typeof candidate.scope === "string" &&
        isStyleTokenScope(candidate.scope)
      )
    ) {
      return [];
    }
    return [
      {
        category: candidate.category,
        cssName: candidate.cssName,
        groupId: candidate.groupId,
        id: candidate.id,
        initialValue: candidate.initialValue,
        label: candidate.label,
        scope: candidate.scope,
      },
    ];
  });
}

function normalizeTokenEdits(value: unknown): TokenEdits {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([tokenId, tokenValue]) => {
      return typeof tokenValue === "string" ? [[tokenId, tokenValue]] : [];
    })
  );
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item) => typeof item === "string");
}

function normalizeCanvasLayouts(value: unknown): ResponsiveLayouts | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const layouts = Object.entries(value).flatMap(([breakpoint, layout]) => {
    if (!Array.isArray(layout)) {
      return [];
    }
    const items = layout.flatMap(normalizeLayoutItem);
    return items.length > 0 ? [[breakpoint, items]] : [];
  });
  if (layouts.length === 0) {
    return undefined;
  }
  return Object.fromEntries(layouts) as ResponsiveLayouts;
}

function normalizeLayoutItem(value: unknown): PersistedLayoutItem[] {
  if (!isRecord(value)) {
    return [];
  }
  const height = finiteNumber(value.h);
  const width = finiteNumber(value.w);
  const x = finiteNumber(value.x);
  const y = finiteNumber(value.y);
  if (
    !(
      typeof value.i === "string" &&
      height !== null &&
      height > 0 &&
      width !== null &&
      width > 0 &&
      x !== null &&
      x >= 0 &&
      y !== null &&
      y >= 0
    )
  ) {
    return [];
  }
  return [
    {
      h: height,
      i: value.i,
      w: width,
      x,
      y,
    },
  ];
}

function normalizeCanvasZoom(value: unknown): number | undefined {
  if (!(typeof value === "number" && Number.isFinite(value))) {
    return undefined;
  }
  return Math.min(1.5, Math.max(0.5, Number(value.toFixed(2))));
}

function isTokenCategory(value: string): value is TokenCategory {
  return Object.values(TokenCategory).includes(value as TokenCategory);
}

function isStyleTokenScope(value: string): value is StyleTokenScope {
  return Object.values(StyleTokenScope).includes(value as StyleTokenScope);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return null;
}

function removeStoredSession(storage: Storage) {
  try {
    storage.removeItem(STYLE_LAB_SESSION_STORAGE_KEY);
  } catch {
    return;
  }
}

const STYLE_LAB_SESSION_STORAGE_KEY =
  "closedloop.prototype.styleLab.session.v1";

type PersistedLayoutItem = Layout[number];

type StyleLabGlobal = typeof globalThis & {
  __styleLabAppliedTokenNames?: string[];
};
