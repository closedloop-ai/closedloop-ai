import {
  AppWindowIcon,
  CaseSensitiveIcon,
  CircleIcon,
  Layers3Icon,
  PaintbrushIcon,
  SparklesIcon,
  SquareIcon,
  TypeIcon,
} from "lucide-react";
import type { ResponsiveLayouts } from "react-grid-layout";

export const TokenCategory = {
  Color: "color",
  Type: "type",
  Shape: "shape",
  Layout: "layout",
  Icon: "icon",
} as const;

export type TokenCategory = (typeof TokenCategory)[keyof typeof TokenCategory];

export const StyleTokenScope = {
  Root: "root",
  Theme: "theme",
} as const;

export type StyleTokenScope =
  (typeof StyleTokenScope)[keyof typeof StyleTokenScope];

export const StyleTaxonomyGroupKind = {
  Asset: "asset",
  Catalog: "catalog",
  Color: "color",
  Grid: "grid",
  Logo: "logo",
  Reconciliation: "reconciliation",
  Type: "type",
  Shape: "shape",
  Layout: "layout",
  Icon: "icon",
} as const;

export type StyleTaxonomyGroupKind =
  (typeof StyleTaxonomyGroupKind)[keyof typeof StyleTaxonomyGroupKind];

export type TokenDefinition = {
  id: string;
  label: string;
  cssName: string;
  initialValue: string;
  category: TokenCategory;
  groupId?: string;
  scope: StyleTokenScope;
};

export type EditedToken = TokenDefinition & {
  currentValue: string;
};

export type TokenEdits = Record<string, string>;

export type StyleTaxonomyGroup = {
  id: string;
  label: string;
  description: string;
  kind: StyleTaxonomyGroupKind;
  tokenIds: readonly string[];
  includeAllTokens?: boolean;
};

export const allDesignSystemTokensGroupId = "all-design-system-tokens";
export const styleReconciliationGroupId = "storybook-reconciliation";

export const styleTaxonomyGroups: readonly StyleTaxonomyGroup[] = [
  {
    id: "foundation",
    label: "Foundation",
    description: "Page defaults, text, outlines, and focus rings.",
    kind: StyleTaxonomyGroupKind.Color,
    tokenIds: [
      "root:background",
      "root:foreground",
      "root:border",
      "root:input-border",
      "root:ring",
      "root:link",
    ],
  },
  {
    id: "surfaces",
    label: "Surfaces",
    description: "Cards, popovers, muted fills, accents, and surface ramps.",
    kind: StyleTaxonomyGroupKind.Color,
    tokenIds: [
      "root:card",
      "root:card-foreground",
      "root:popover",
      "root:popover-foreground",
      "root:muted",
      "root:muted-foreground",
      "root:accent",
      "root:accent-foreground",
      "root:surface-0",
      "root:surface-1",
      "root:surface-2",
      "root:surface-3",
      "root:surface-4",
      "root:surface-5",
    ],
  },
  {
    id: "actions",
    label: "Actions",
    description:
      "Primary and secondary action fills with readable foregrounds.",
    kind: StyleTaxonomyGroupKind.Color,
    tokenIds: [
      "root:primary",
      "root:primary-foreground",
      "root:secondary",
      "root:secondary-foreground",
      "root:closedloop-violet",
      "root:highlight",
    ],
  },
  {
    id: "state",
    label: "State",
    description: "Destructive, success, warning, info, and AI state colors.",
    kind: StyleTaxonomyGroupKind.Color,
    tokenIds: [
      "root:destructive",
      "root:destructive-foreground",
      "root:success",
      "root:success-foreground",
      "root:warning",
      "root:warning-foreground",
      "root:info",
      "root:info-foreground",
      "root:ai",
      "root:ai-foreground",
    ],
  },
  {
    id: "charts",
    label: "Charts",
    description: "Series colors, axes, and label tones for data surfaces.",
    kind: StyleTaxonomyGroupKind.Color,
    tokenIds: [
      "root:chart-1",
      "root:chart-2",
      "root:chart-3",
      "root:chart-4",
      "root:chart-5",
      "root:chart-6",
      "root:chart-7",
      "root:chart-8",
      "root:chart-9",
      "root:chart-10",
      "root:chart-axis",
      "root:chart-axis-label",
    ],
  },
  {
    id: "typography",
    label: "Typography",
    description: "Fonts, weights, and readable product text scale.",
    kind: StyleTaxonomyGroupKind.Type,
    tokenIds: [
      "theme:text-xs",
      "theme:text-sm",
      "theme:text-base",
      "theme:text-lg",
      "root:font-weight-bold",
      "theme:font-sans",
      "theme:font-mono",
    ],
  },
  {
    id: allDesignSystemTokensGroupId,
    label: "Editable Token Manifest",
    description: ":root and @theme inline variables with PR export support.",
    includeAllTokens: true,
    kind: StyleTaxonomyGroupKind.Catalog,
    tokenIds: [],
  },
  {
    id: "grids",
    label: "Grids",
    description: "Responsive columns, density rhythm, and stacking layers.",
    kind: StyleTaxonomyGroupKind.Grid,
    tokenIds: [
      "theme:breakpoint-xs",
      "root:density-compact",
      "root:density-cozy",
      "root:density-comfortable",
      "root:z-sticky",
      "root:z-overlay",
      "root:z-modal",
      "root:z-popover",
      "root:z-toast",
    ],
  },
  {
    id: "logos",
    label: "Logos",
    description: "Closedloop mark, wordmark lockups, and brand partner marks.",
    kind: StyleTaxonomyGroupKind.Logo,
    tokenIds: [
      "root:closedloop-violet",
      "root:brand-gradient",
      "root:primary",
      "root:foreground",
      "root:icon-sm",
      "root:icon-md",
      "root:icon-lg",
    ],
  },
  {
    id: "assets",
    label: "Assets",
    description: "Gradients, status badges, progress fills, and app chrome.",
    kind: StyleTaxonomyGroupKind.Asset,
    tokenIds: [
      "root:brand-gradient",
      "root:highlight",
      "root:progress",
      "root:progress-foreground",
      "root:progress-badge-bg",
      "root:progress-badge-border",
      "root:progress-badge-text",
      "root:sidebar",
      "root:sidebar-foreground",
      "root:sidebar-accent",
      "root:sidebar-border",
    ],
  },
  {
    id: "font-utilities",
    label: "Font Utilities",
    description: "Tailwind-published type utilities and font family tokens.",
    kind: StyleTaxonomyGroupKind.Type,
    tokenIds: [
      "theme:font-sans",
      "theme:font-mono",
      "theme:text-xs",
      "theme:text-sm",
      "theme:text-base",
      "theme:text-lg",
    ],
  },
  {
    id: styleReconciliationGroupId,
    label: "Storybook Reconciliation",
    description:
      "Storybook, app, dark-mode, and prose styles that need owners.",
    kind: StyleTaxonomyGroupKind.Reconciliation,
    tokenIds: [
      "root:primary",
      "root:secondary",
      "root:muted",
      "root:success",
      "root:warning",
      "root:info",
      "root:destructive",
      "root:ai",
    ],
  },
  {
    id: "shape",
    label: "Radius and Shadows",
    description: "Corners and elevation for app surfaces.",
    kind: StyleTaxonomyGroupKind.Shape,
    tokenIds: [
      "root:radius",
      "theme:radius-sm",
      "theme:radius-md",
      "theme:radius-lg",
      "theme:radius-xl",
      "theme:radius-full",
      "root:shadow-inset",
      "theme:shadow-inset",
    ],
  },
  {
    id: "density",
    label: "Density",
    description: "Touch targets, row rhythm, and mobile spacing.",
    kind: StyleTaxonomyGroupKind.Layout,
    tokenIds: [
      "root:tap-min",
      "root:tap-comfortable",
      "root:density-compact",
      "root:density-cozy",
      "root:density-comfortable",
      "root:bottom-nav-height",
    ],
  },
  {
    id: "icons",
    label: "Icons",
    description: "Icon scale and source-owned SVG specimens.",
    kind: StyleTaxonomyGroupKind.Icon,
    tokenIds: [
      "root:icon-sm",
      "root:icon-md",
      "root:icon-lg",
      "theme:spacing-icon-sm",
      "theme:spacing-icon-md",
      "theme:spacing-icon-lg",
    ],
  },
];

export const styleCanvasLayouts: ResponsiveLayouts = {
  lg: [
    { i: "foundation", x: 0, y: 0, w: 4, h: 4 },
    { i: "surfaces", x: 4, y: 0, w: 5, h: 5 },
    { i: "actions", x: 9, y: 0, w: 3, h: 4 },
    { i: "state", x: 0, y: 4, w: 4, h: 5 },
    { i: "charts", x: 4, y: 5, w: 8, h: 4 },
    { i: "typography", x: 0, y: 9, w: 6, h: 4 },
    { i: "all-design-system-tokens", x: 6, y: 9, w: 6, h: 6 },
    { i: "grids", x: 0, y: 15, w: 6, h: 4 },
    { i: "logos", x: 6, y: 15, w: 6, h: 4 },
    { i: "assets", x: 0, y: 19, w: 7, h: 4 },
    { i: "font-utilities", x: 7, y: 19, w: 5, h: 4 },
    { i: "storybook-reconciliation", x: 0, y: 23, w: 8, h: 5 },
    { i: "shape", x: 8, y: 23, w: 4, h: 4 },
    { i: "density", x: 0, y: 28, w: 4, h: 4 },
    { i: "icons", x: 4, y: 28, w: 4, h: 3 },
  ],
  md: [
    { i: "foundation", x: 0, y: 0, w: 4, h: 4 },
    { i: "surfaces", x: 4, y: 0, w: 4, h: 5 },
    { i: "actions", x: 0, y: 4, w: 4, h: 4 },
    { i: "state", x: 4, y: 5, w: 4, h: 5 },
    { i: "charts", x: 0, y: 9, w: 8, h: 4 },
    { i: "typography", x: 0, y: 13, w: 8, h: 4 },
    { i: "all-design-system-tokens", x: 0, y: 17, w: 8, h: 6 },
    { i: "grids", x: 0, y: 23, w: 8, h: 4 },
    { i: "logos", x: 0, y: 27, w: 4, h: 4 },
    { i: "assets", x: 4, y: 27, w: 4, h: 4 },
    { i: "font-utilities", x: 0, y: 31, w: 4, h: 4 },
    { i: "storybook-reconciliation", x: 4, y: 31, w: 4, h: 5 },
    { i: "shape", x: 0, y: 36, w: 4, h: 4 },
    { i: "density", x: 4, y: 36, w: 4, h: 4 },
    { i: "icons", x: 0, y: 40, w: 4, h: 3 },
  ],
  sm: styleTaxonomyGroups.map((group, index) => ({
    i: group.id,
    x: 0,
    y: index * 4,
    w: 1,
    h: group.id === "typography" ? 5 : 4,
  })),
};

export const iconSpecimens = [
  AppWindowIcon,
  CaseSensitiveIcon,
  CircleIcon,
  Layers3Icon,
  PaintbrushIcon,
  SparklesIcon,
  SquareIcon,
  TypeIcon,
] as const;

export function tokensForTaxonomyGroup(
  group: StyleTaxonomyGroup,
  tokensById: Readonly<Record<string, TokenDefinition>>
): TokenDefinition[] {
  if (group.includeAllTokens) {
    return Object.values(tokensById);
  }
  const groupTokenIds = new Set(group.tokenIds);
  const baseTokens = group.tokenIds.flatMap((tokenId) => {
    const token = tokensById[tokenId];
    return token ? [token] : [];
  });
  const addedTokens = Object.values(tokensById).filter((token) => {
    return token.groupId === group.id && !groupTokenIds.has(token.id);
  });
  return [...baseTokens, ...addedTokens];
}

export function primaryTaxonomyGroupForToken(
  token: TokenDefinition | undefined
): StyleTaxonomyGroup | undefined {
  if (!token) {
    return undefined;
  }
  return (
    styleTaxonomyGroups.find((group) => {
      return token.groupId === group.id || group.tokenIds.includes(token.id);
    }) ??
    styleTaxonomyGroups.find(
      (group) => group.id === allDesignSystemTokensGroupId
    ) ??
    styleTaxonomyGroups[0]
  );
}
