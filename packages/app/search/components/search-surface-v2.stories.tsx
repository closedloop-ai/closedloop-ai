import {
  CommandDialog,
  CommandInput,
  CommandList,
} from "@repo/design-system/components/ui/command";
import type { Meta, StoryObj } from "@storybook/react";
import { BookOpenIcon, FileTextIcon, TerminalIcon } from "lucide-react";
import type { ReactNode } from "react";
import { fn } from "storybook/test";
import type { SearchSurfaceResult } from "../lib/search-surface-model";
import { SearchSurfaceV2 } from "./search-surface-v2";
import { SearchSurfaceModeKind } from "./search-surface-v2-props";

const results: SearchSurfaceResult[] = [
  {
    key: "document:doc-1",
    kindLabel: "Document",
    title: "Unified search across artifacts",
    snippet: "one ranked list for <b>search</b> across documents",
    destination: "/prds/unified-search",
    meta: "Updated 4 Aug 2026",
    icon: FileTextIcon,
  },
  {
    key: "document:doc-2",
    kindLabel: "Issue",
    title: "Filter error state reports a stale count",
    snippet: "the strip reported a count for a query that never ran",
    destination: "/issues/iss-4665",
    meta: "Updated 2 Aug 2026",
    icon: FileTextIcon,
  },
  {
    key: "agent_session:ses-1",
    kindLabel: "Session",
    title: "Alpha search rollout session",
    snippet: "rolling the <b>search</b> projection out to the alpha org",
    destination: "/sessions/ses-1",
    meta: "Updated 29 Jul 2026",
    icon: TerminalIcon,
  },
];

/** The desktop palette's corpus: docs pages, with no updated-at to show. */
const docsResults: SearchSurfaceResult[] = [
  {
    key: "getting-started/api-keys#create-a-key",
    kindLabel: "Section",
    title: "API keys",
    snippet: "Create an <b>API key</b> to authenticate…",
    destination: "/help?page=getting-started%2Fapi-keys&heading=create-a-key",
    icon: BookOpenIcon,
  },
  {
    key: "concepts/loops#",
    kindLabel: "Title",
    title: "Loops",
    snippet: "A <b>loop</b> runs your agents…",
    destination: "/help?page=concepts%2Floops",
    icon: BookOpenIcon,
  },
];

const meta = {
  title: "Composites v1.0/Search/Search Surface V2",
  component: SearchSurfaceV2,
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "padded" },
  args: {
    mode: { kind: SearchSurfaceModeKind.Page, onRunExample: fn() },
    query: "search",
    read: {
      hasRun: true,
      isLoading: false,
      isUnavailable: false,
      unavailableReason: null,
      resultCount: results.length,
    },
    results,
    onRetry: fn(),
  },
} satisfies Meta<typeof SearchSurfaceV2>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A settled query with hits, on the `/search` route body. */
export const PageReady: Story = {};

/**
 * The query has NOT run — below the 2-char floor, or never submitted. The page
 * lands its designed on-ramp. Placed beside {@link PageNoResults} because the
 * whole of AC2 is that these two must never look the same: this one claims
 * nothing about the corpus, that one claims the corpus is empty.
 */
export const PageNotRun: Story = {
  args: {
    query: "",
    read: {
      hasRun: false,
      isLoading: false,
      isUnavailable: false,
      unavailableReason: null,
      resultCount: 0,
    },
    results: [],
  },
};

/** A query that ran and matched nothing. The query is echoed back. */
export const PageNoResults: Story = {
  args: {
    read: {
      hasRun: true,
      isLoading: false,
      isUnavailable: false,
      unavailableReason: null,
      resultCount: 0,
    },
    results: [],
  },
};

/** First load: skeleton rows on the result rhythm, so nothing jumps. */
export const PageLoading: Story = {
  args: {
    read: {
      hasRun: true,
      isLoading: true,
      isUnavailable: false,
      unavailableReason: null,
      resultCount: 0,
    },
    results: [],
  },
};

/** The transport failed. An honest message plus a retry — never a dead spinner. */
export const PageUnavailable: Story = {
  args: {
    read: {
      hasRun: true,
      isLoading: false,
      isUnavailable: true,
      unavailableReason: null,
      resultCount: 0,
    },
    results: [],
  },
};

/**
 * The server REFUSED the query (the malformed-filter 400). Its own reason is
 * the whole story and there is no retry, because retrying an unchanged bad
 * query cannot fix it. Rendered beside {@link PageUnavailable} so the two
 * failures are visibly different on sight.
 */
export const PageRejectedQuery: Story = {
  args: {
    query: "priority>=huge",
    read: {
      hasRun: true,
      isLoading: false,
      isUnavailable: true,
      unavailableReason: "Unknown priority value: huge",
      resultCount: 0,
    },
    results: [],
  },
};

/** A result the host could not build a safe route for renders as a plain row. */
export const PageRouteless: Story = {
  args: {
    results: [{ ...results[0], destination: null }, results[1], results[2]],
  },
};

const OVERLAY_MODE = {
  kind: SearchSurfaceModeKind.Overlay,
  groupHeading: "Docs",
  notRunPrompt: "Type to search the documentation.",
} as const;

/**
 * The palette chrome the product actually ships — `CommandDialog`, not a bare
 * `Command`. The dialog is where the per-item padding and icon sizing live, so
 * a story that skipped it would render a palette nobody ever sees and hide any
 * density problem the overlay rows have.
 */
function paletteDecorator(value: string) {
  return (Story: () => ReactNode) => (
    <CommandDialog
      commandProps={{ shouldFilter: false }}
      description="Search the docs and jump to a page."
      onOpenChange={() => undefined}
      open
      title="Command palette"
    >
      <CommandInput placeholder="Search documentation…" value={value} />
      <CommandList>
        <Story />
      </CommandList>
    </CommandDialog>
  );
}

/**
 * The desktop ⌘K palette. Same model, same rows, same destinations — a denser
 * container, inside the shell's own `cmdk` dialog, whose arrow keys drive the
 * selection. The shell owns the input and Escape; the surface owns the list.
 */
export const OverlayReady: Story = {
  args: {
    mode: OVERLAY_MODE,
    query: "api key",
    read: {
      hasRun: true,
      isLoading: false,
      isUnavailable: false,
      unavailableReason: null,
      resultCount: docsResults.length,
    },
    results: docsResults,
  },
  decorators: [paletteDecorator("api key")],
};

/** The palette before anything is typed: one line, not a page's on-ramp. */
export const OverlayNotRun: Story = {
  args: {
    mode: OVERLAY_MODE,
    query: "",
    read: {
      hasRun: false,
      isLoading: false,
      isUnavailable: false,
      unavailableReason: null,
      resultCount: 0,
    },
    results: [],
  },
  decorators: [paletteDecorator("")],
};

/** The palette's own no-results line, distinct from its empty-query prompt. */
export const OverlayNoResults: Story = {
  args: {
    mode: OVERLAY_MODE,
    query: "zzz",
    read: {
      hasRun: true,
      isLoading: false,
      isUnavailable: false,
      unavailableReason: null,
      resultCount: 0,
    },
    results: [],
  },
  decorators: [paletteDecorator("zzz")],
};

/** The docs index could not answer at all — a retry, not a "no matches" line. */
export const OverlayUnavailable: Story = {
  args: {
    mode: OVERLAY_MODE,
    query: "api key",
    read: {
      hasRun: true,
      isLoading: false,
      isUnavailable: true,
      unavailableReason: null,
      resultCount: 0,
    },
    results: [],
  },
  decorators: [paletteDecorator("api key")],
};

/** The palette mid-search: a spinner that actually spins, not a frozen glyph. */
export const OverlayLoading: Story = {
  args: {
    mode: OVERLAY_MODE,
    query: "api key",
    read: {
      hasRun: true,
      isLoading: true,
      isUnavailable: false,
      unavailableReason: null,
      resultCount: 0,
    },
    results: [],
  },
  decorators: [paletteDecorator("api key")],
};

/**
 * The palette's rejected-query line. Beside {@link OverlayUnavailable} because
 * the two failures must look different at a glance here too, and this is the
 * one that joins a title and a server sentence on a single truncating line.
 */
export const OverlayRejectedQuery: Story = {
  args: {
    mode: OVERLAY_MODE,
    query: "priority>=huge",
    read: {
      hasRun: true,
      isLoading: false,
      isUnavailable: true,
      unavailableReason: "Unknown priority value: huge",
      resultCount: 0,
    },
    results: [],
  },
  decorators: [paletteDecorator("priority>=huge")],
};
