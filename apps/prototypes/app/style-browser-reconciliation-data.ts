import { TokenCategory } from "./style-browser-editor-data";

export type StyleReconciliationSwatch = {
  name: string;
  value: string;
  sourceLabel?: string;
  overrideCategory?: typeof TokenCategory.Color | typeof TokenCategory.Type;
  overrideValue?: string;
  suggestedTokenName?: string;
  tokenId?: string;
};

export type StyleReconciliationItem = {
  id: string;
  label: string;
  description: string;
  status: string;
  sourcePath: string;
  storyPath: string;
  swatches: readonly StyleReconciliationSwatch[];
};

const tagColorSwatches: readonly StyleReconciliationSwatch[] = [
  {
    name: "red",
    sourceLabel: "bg-red-500",
    suggestedTokenName: "app-tag-red",
    value: "#ef4444",
  },
  {
    name: "rose",
    sourceLabel: "bg-rose-500",
    suggestedTokenName: "app-tag-rose",
    value: "#f43f5e",
  },
  {
    name: "orange",
    sourceLabel: "bg-orange-500",
    suggestedTokenName: "app-tag-orange",
    value: "#f97316",
  },
  {
    name: "amber",
    sourceLabel: "bg-amber-500",
    suggestedTokenName: "app-tag-amber",
    value: "#f59e0b",
  },
  {
    name: "yellow",
    sourceLabel: "bg-yellow-400",
    suggestedTokenName: "app-tag-yellow",
    value: "#eab308",
  },
  {
    name: "lime",
    sourceLabel: "bg-lime-500",
    suggestedTokenName: "app-tag-lime",
    value: "#84cc16",
  },
  {
    name: "green",
    sourceLabel: "bg-green-500",
    suggestedTokenName: "app-tag-green",
    value: "#22c55e",
  },
  {
    name: "emerald",
    sourceLabel: "bg-emerald-500",
    suggestedTokenName: "app-tag-emerald",
    value: "#10b981",
  },
  {
    name: "teal",
    sourceLabel: "bg-teal-500",
    suggestedTokenName: "app-tag-teal",
    value: "#14b8a6",
  },
  {
    name: "cyan",
    sourceLabel: "bg-cyan-500",
    suggestedTokenName: "app-tag-cyan",
    value: "#06b6d4",
  },
  {
    name: "sky",
    sourceLabel: "bg-sky-500",
    suggestedTokenName: "app-tag-sky",
    value: "#0ea5e9",
  },
  {
    name: "blue",
    sourceLabel: "bg-blue-500",
    suggestedTokenName: "app-tag-blue",
    value: "#3b82f6",
  },
  {
    name: "indigo",
    sourceLabel: "bg-indigo-500",
    suggestedTokenName: "app-tag-indigo",
    value: "#6366f1",
  },
  {
    name: "violet",
    sourceLabel: "bg-violet-500",
    suggestedTokenName: "app-tag-violet",
    value: "#8b5cf6",
  },
  {
    name: "purple",
    sourceLabel: "bg-purple-500",
    suggestedTokenName: "app-tag-purple",
    value: "#a855f7",
  },
  {
    name: "pink",
    sourceLabel: "bg-pink-500",
    suggestedTokenName: "app-tag-pink",
    value: "#ec4899",
  },
];

const customFieldColorSwatches: readonly StyleReconciliationSwatch[] = [
  { name: "none", sourceLabel: "bg-gray-300", value: "#d1d5db" },
  { name: "red", sourceLabel: "bg-red-500", value: "#ef4444" },
  { name: "orange", sourceLabel: "bg-orange-500", value: "#f97316" },
  { name: "yellow", sourceLabel: "bg-yellow-400", value: "#facc15" },
  { name: "green", sourceLabel: "bg-green-500", value: "#22c55e" },
  { name: "teal", sourceLabel: "bg-teal-500", value: "#14b8a6" },
  { name: "blue", sourceLabel: "bg-blue-500", value: "#3b82f6" },
  { name: "purple", sourceLabel: "bg-purple-500", value: "#a855f7" },
  { name: "pink", sourceLabel: "bg-pink-500", value: "#ec4899" },
];

const genericArtifactOptionSwatches: readonly StyleReconciliationSwatch[] = [
  { name: "option 1", sourceLabel: "bg-emerald-600", value: "#059669" },
  { name: "option 2", sourceLabel: "bg-orange-600", value: "#ea580c" },
  { name: "option 3", sourceLabel: "bg-blue-600", value: "#2563eb" },
];

const prototypeLocalSwatches: readonly StyleReconciliationSwatch[] = [
  { name: "agent code", sourceLabel: "#41A3FF", value: "#41A3FF" },
  { name: "review", sourceLabel: "#6366F1", value: "#6366F1" },
  { name: "bootstrap", sourceLabel: "#1F8A5B", value: "#1F8A5B" },
  { name: "platform", sourceLabel: "#C08A2F", value: "#C08A2F" },
  { name: "self-learning", sourceLabel: "#8B5CF6", value: "#8B5CF6" },
  { name: "branch blue", sourceLabel: "#4f7df0", value: "#4f7df0" },
  { name: "branch red", sourceLabel: "#c2412d", value: "#c2412d" },
];

const shadcnRecipeSwatches: readonly StyleReconciliationSwatch[] = [
  {
    name: "button",
    sourceLabel: "bg-primary",
    tokenId: "root:primary",
    value: "var(--primary)",
  },
  {
    name: "outline",
    sourceLabel: "border-input-border",
    tokenId: "root:input-border",
    value: "var(--input-border)",
  },
  {
    name: "focus",
    sourceLabel: "ring-ring",
    tokenId: "root:ring",
    value: "var(--ring)",
  },
  {
    name: "popover",
    sourceLabel: "bg-popover",
    tokenId: "root:popover",
    value: "var(--popover)",
  },
  {
    name: "muted",
    sourceLabel: "bg-muted",
    tokenId: "root:muted",
    value: "var(--muted)",
  },
  {
    name: "danger",
    sourceLabel: "bg-destructive",
    tokenId: "root:destructive",
    value: "var(--destructive)",
  },
  {
    name: "success",
    sourceLabel: "bg-success/12",
    tokenId: "root:success",
    value: "var(--success)",
  },
  {
    name: "warning",
    sourceLabel: "bg-warning/14",
    tokenId: "root:warning",
    value: "var(--warning)",
  },
];

const headingUtilitySwatches: readonly StyleReconciliationSwatch[] = [
  {
    name: "H1",
    overrideCategory: TokenCategory.Type,
    overrideValue: "600 1.5rem/1.2 var(--font-sans)",
    sourceLabel: "text-2xl",
    suggestedTokenName: "heading-h1",
    value: "var(--foreground)",
  },
  {
    name: "H1 desktop",
    overrideCategory: TokenCategory.Type,
    overrideValue: "600 1.75rem/1.2 var(--font-sans)",
    sourceLabel: "text-[1.75rem]",
    suggestedTokenName: "heading-h1-desktop",
    value: "var(--foreground)",
  },
  {
    name: "H2",
    overrideCategory: TokenCategory.Type,
    overrideValue: "600 1.25rem/1.25 var(--font-sans)",
    sourceLabel: "text-xl",
    suggestedTokenName: "heading-h2",
    value: "var(--foreground)",
  },
  {
    name: "H3",
    overrideCategory: TokenCategory.Type,
    overrideValue: "600 1rem/1.35 var(--font-sans)",
    sourceLabel: "text-lg",
    suggestedTokenName: "heading-h3",
    value: "var(--foreground)",
  },
  {
    name: "H4",
    overrideCategory: TokenCategory.Type,
    overrideValue: "500 0.8125rem/1.4 var(--font-sans)",
    sourceLabel: "text-sm uppercase",
    suggestedTokenName: "heading-h4",
    value: "var(--muted-foreground)",
  },
  {
    name: "H5",
    overrideCategory: TokenCategory.Type,
    overrideValue: "500 0.8125rem/1.4 var(--font-sans)",
    sourceLabel: "text-sm",
    suggestedTokenName: "heading-h5",
    value: "var(--foreground)",
  },
];

export const styleReconciliationItems: readonly StyleReconciliationItem[] = [
  {
    id: "tag-colors",
    label: "Tag colors",
    description:
      "Tag values come from the API TagColor vocabulary. Picker swatches and chips still use app-owned Tailwind class maps instead of design-system tokens.",
    sourcePath:
      "packages/api/src/types/tag.ts + packages/app/shared/components/tag-color-picker.tsx + packages/app/shared/components/tag-chip.tsx",
    status: "App-owned, not tokenized",
    storyPath: "packages/app/shared/components/tag-color-picker.stories.tsx",
    swatches: tagColorSwatches,
  },
  {
    id: "custom-field-colors",
    label: "Custom-field colors",
    description:
      "The custom-field picker ships a fixed Tailwind palette through a shared app color swatch picker. It is deterministic, but it is not a design-system token set.",
    sourcePath: "packages/app/custom-fields/components/color-picker.tsx",
    status: "App-owned, not tokenized",
    storyPath: "packages/app/custom-fields/components/color-picker.tsx",
    swatches: customFieldColorSwatches,
  },
  {
    id: "generic-artifact-option-colors",
    label: "Generic artifact option colors",
    description:
      "The custom field dialog in the generic artifact prototype has a separate three-color option palette. It should either map to existing tokens or be promoted deliberately.",
    sourcePath:
      "packages/design-system/components/ui/table-add-field-dialog.tsx",
    status: "Prototype-local palette",
    storyPath: "apps/prototypes/app/p/generic-artifact",
    swatches: genericArtifactOptionSwatches,
  },
  {
    id: "prototype-local-overrides",
    label: "Prototype local overrides",
    description:
      "Several prototypes still carry literal brand, actor, branch, and pack colors. These are not random, but they are outside the base design-system package.",
    sourcePath:
      "apps/prototypes/app/p/agents/component-meta.tsx + apps/prototypes/app/p/agents/mock.ts + packages/app/branches/components/prototype-preview/mock-detail.ts",
    status: "Prototype-owned literals",
    storyPath: "apps/prototypes/app/p",
    swatches: prototypeLocalSwatches,
  },
  {
    id: "shadcn-recipes",
    label: "Shadcn/Radix recipes",
    description:
      "The design-system package contains shadcn and Radix primitive recipes. They are part of the effective style surface even when the row is a component variant, not a raw token.",
    sourcePath: "packages/design-system/components/ui/*.tsx",
    status: "DS recipe, token backed",
    storyPath: "apps/storybook/stories",
    swatches: shadcnRecipeSwatches,
  },
  {
    id: "heading-utilities",
    label: "Production heading utilities",
    description:
      "Page and panel headings use Tailwind utility recipes today. They should be visible here so designers can normalize heading variants instead of hunting through Figma.",
    sourcePath:
      "apps/app branch pages + apps/desktop layout/page-shell.tsx + apps/storybook/stories/catalog.stories.tsx",
    status: "Raw utilities",
    storyPath: "apps/storybook/stories/catalog.stories.tsx",
    swatches: headingUtilitySwatches,
  },
  {
    id: "badge-variants",
    label: "Badge variants",
    description:
      "Badge variants are in the design-system package and read semantic CSS variables such as --success, --warning, --info, and --ai.",
    sourcePath: "packages/design-system/components/ui/badge.tsx",
    status: "Design-system component, token backed",
    storyPath: "apps/storybook/stories/badge.stories.tsx",
    swatches: [
      { name: "success", tokenId: "root:success", value: "var(--success)" },
      { name: "warning", tokenId: "root:warning", value: "var(--warning)" },
      { name: "info", tokenId: "root:info", value: "var(--info)" },
      {
        name: "destructive",
        tokenId: "root:destructive",
        value: "var(--destructive)",
      },
      { name: "ai", tokenId: "root:ai", value: "var(--ai)" },
    ],
  },
  {
    id: "storybook-fixture-tags",
    label: "Storybook fixture tags",
    description:
      "Filter and active-filter stories still seed sample tag colors as literal hex values for fixtures, separate from the canonical TagColor list.",
    sourcePath:
      "apps/storybook/stories/filter-popover.stories.tsx + apps/storybook/stories/active-filters-bar.stories.tsx",
    status: "Storybook fixture literals",
    storyPath:
      "apps/storybook/stories/filter-popover.stories.tsx + apps/storybook/stories/active-filters-bar.stories.tsx",
    swatches: [
      {
        name: "quality",
        sourceLabel: "#22c55e",
        suggestedTokenName: "storybook-filter-quality",
        value: "#22c55e",
      },
      {
        name: "customer",
        sourceLabel: "#3b82f6",
        suggestedTokenName: "storybook-filter-customer",
        value: "#3b82f6",
      },
      {
        name: "design",
        sourceLabel: "#ec4899",
        suggestedTokenName: "storybook-filter-design",
        value: "#ec4899",
      },
    ],
  },
  {
    id: "dark-overrides",
    label: "Dark overrides",
    description:
      ".dark variables ship in globals.css separately from the light :root set. Clicking one creates an explicit override token so dark-mode work is not hidden.",
    sourcePath: "packages/design-system/styles/globals.css (.dark block)",
    status: "Tokenizable override",
    storyPath: "packages/design-system/providers/theme.tsx",
    swatches: [
      {
        name: "background",
        suggestedTokenName: "dark-background",
        value: "oklch(0.145 0 0)",
      },
      {
        name: "foreground",
        suggestedTokenName: "dark-foreground",
        value: "oklch(0.985 0 0)",
      },
      {
        name: "primary",
        suggestedTokenName: "dark-primary",
        value: "oklch(0.922 0 0)",
      },
      {
        name: "ring",
        suggestedTokenName: "dark-ring",
        value: "oklch(0.708 0 0)",
      },
    ],
  },
  {
    id: "prose-utility",
    label: "Prose utility variables",
    description:
      "@utility prose maps documentation typography colors to token references. Token-backed rows jump to the canonical color token instead of creating a duplicate.",
    sourcePath: "packages/design-system/styles/globals.css (@utility prose)",
    status: "DS utility, token backed",
    storyPath: "apps/web /docs prose surfaces",
    swatches: [
      {
        name: "body",
        tokenId: "theme:color-foreground",
        value: "var(--color-foreground)",
      },
      {
        name: "links",
        tokenId: "theme:color-primary",
        value: "var(--color-primary)",
      },
      {
        name: "code",
        tokenId: "theme:color-foreground",
        value: "var(--color-foreground)",
      },
      {
        name: "hr",
        tokenId: "theme:color-muted-foreground",
        value: "var(--color-muted-foreground)",
      },
    ],
  },
];
