import { SESSION_STATUS_SYNC_BADGE_TEST_ID } from "@repo/app/agents/lib/session-sync-presentation";
import { A11yTheme } from "@repo/app/test/a11y/contrast";
import { type RenderResult, render, screen } from "@testing-library/react";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import { useAgentSessions } from "../../../hooks/use-agent-sessions";
import { AgentSessionsListContent } from "../agent-sessions-list";

// Shared fixtures and DOM-navigation helpers for the `SyncedSessionsTable` test
// suite, which is split by concern across sibling `*.test.tsx` files (rendering,
// states/a11y/overflow, and the ISS-4774 status-pill fold). Keeping these here
// avoids duplicating the render wrappers and grid-cell lookups per file. The
// tooltip `vi.mock` stays in each test file — it is module-scoped and hoisted,
// so it cannot live in a shared import.

export const REPOSITORY_HEADER_NAME_REGEX = /Repository/i;
export const OWNER_HEADER_NAME_REGEX = /Owner/i;
export const GRID_EMPTY_VALUE_TEXT_REGEX = /^—$/;
/**
 * The MALFORMED repository cell (#4324 review). It still LEADS with the word
 * "Unknown", but now carries an explanation of what the word means, so an exact
 * match would fail on the very copy the review asked for. (These suites mock the
 * tooltip to render its content inline, so the cell's `textContent` is the label
 * followed by the explanation — hence a prefix match, not a word boundary.)
 */
export const REPOSITORY_MALFORMED_TEXT_REGEX = /^Unknown/;
export const MULTI_OPEN_PR_TOOLTIP_REGEX = /#19 open · Wire PR list/;
export const MULTI_MERGED_PR_TOOLTIP_REGEX =
  /#20 merged · Merge trusted lifecycle/;
export const LONG_SESSION_NAME_REGEX = /A very long session name/;
export const LONG_BRANCH_NAME =
  "kaiticarp/feature/some-very-long-descriptive-branch-name";
export const A11Y_THEMES = [A11yTheme.Light, A11yTheme.Dark] as const;
export const SYNCING_STATUS_LABEL_REGEX = /^Syncing$/;
export const LOCAL_ONLY_LABEL_REGEX = /^Local only$/;
// ISS-4846 (WCAG 2.5.3 Label in Name): the folded pill's accessible name must
// LEAD with its VISIBLE word, so a voice-control user saying what they see has
// something to match. ISS-5279 stopped replacing that word: the pill keeps its
// lifecycle label and pulses, so the name now leads with "Active" and the sync
// clause follows it.
export const SYNCING_ARIA_LABEL_LEADS_RE = /^Active,/;
// ISS-5279: the pulse and the reduced-motion opt-out it is never applied
// without. `motion-safe:` emits no animation at all under a reduce-motion
// preference, rather than emitting one and then overriding it.
export const PULSE_RING_CLASS_RE = /motion-safe:animate-status-pulse-ring/;
// ISS-5279: the row's own Status pill, marked as carrying a sync presentation.
// There is no separate "Syncing" badge any more — that WAS the duplicate.
// Re-exported from the production constant, never retyped (PR review).
export const STATUS_BADGE_TEST_ID = SESSION_STATUS_SYNC_BADGE_TEST_ID;
// ISS-5279: a `ToneBadge`'s own geometry, used to COUNT pills. `data-slot`
// cannot serve here: Radix's `TooltipTrigger asChild` spreads
// `data-slot="tooltip-trigger"` over the badge's own value, so a tooltip-carrying
// pill stops answering to `[data-slot="badge"]` — and this suite exists to count
// exactly the pill that carries a tooltip.
export const TONE_BADGE_SELECTOR = '[class~="h-6"][class~="rounded-full"]';

// The session name is now a navigation-port `Link` (FEA-4051), which needs the
// navigation adapter context. Render through `AppCoreStoryProviders` (its memory
// adapter) as a testing-library `wrapper` so the Link resolves — and so
// `rerender` keeps the same provider tree instead of dropping the context.
export function renderWithNav(node: React.ReactNode): RenderResult {
  return render(node, { wrapper: AppCoreStoryProviders });
}

// ISS-4774: render through the provider tree with a specific set of feature
// flags reported enabled, so a test can drive both the flag-off (today's
// behavior) and flag-on (folded Status pill) branches of the shared table.
export function renderWithFlags(
  node: React.ReactNode,
  enabledFlags: readonly string[] = []
): RenderResult {
  return render(node, {
    wrapper: ({ children }) => (
      <AppCoreStoryProviders enabledFlags={enabledFlags}>
        {children}
      </AppCoreStoryProviders>
    ),
  });
}

export function HookBackedListProbe() {
  const query = useAgentSessions({ limit: 25, offset: 0 });

  return (
    <AgentSessionsListContent
      getSessionHref={(item) => `/sessions/${item.id}`}
      isLoading={query.isLoading}
      items={query.data?.items ?? []}
    />
  );
}

export function getBranchCellForSessionName(sessionName: string): HTMLElement {
  // ISS-5315: the column is now "Linked branches"; the helper name stays
  // branch-shaped because the FACT it reads is still the row's branch.
  return getGridCellForSessionName(sessionName, "Linked branches");
}

export function getRepoCellForSessionName(sessionName: string): HTMLElement {
  return getGridCellForSessionName(sessionName, "Repository");
}

export function getPrCellForSessionName(sessionName: string): HTMLElement {
  return getGridCellForSessionName(sessionName, "PR");
}

export function getOwnerCellForSessionName(sessionName: string): HTMLElement {
  return getGridCellForSessionName(sessionName, "Owner");
}

export function getMergeCellForSessionName(sessionName: string): HTMLElement {
  return getGridCellForSessionName(sessionName, "Merge");
}

/**
 * The row's `Signals` cell — where ISS-5282 put the row QUALIFIERS and where,
 * since ISS-5666 retired that ticket's gate, they render on every surface. The
 * Session Name cell is the name alone, so any "the verdict is still disclosed"
 * assertion reads from HERE.
 *
 * The header label comes from the canonical constant rather than the literal
 * "Signals", so a copy change fails the lookup instead of silently matching
 * nothing.
 */
// Resolve the grid-column child index for a header label directly from the
// rendered header row, so these cell lookups stay correct regardless of the
// column order the table renders (FEA-4006 reordered the column set). The lead
// "Session" column is child 0; each data column follows in header order.
function columnChildIndexByHeader(headerLabel: string): number {
  const headerRow = screen.getByText("Session").closest(".grid");
  if (!(headerRow instanceof HTMLElement)) {
    throw new Error("Could not find the sessions table header row");
  }
  const index = [...headerRow.children].findIndex(
    (cell) => cell.textContent?.trim() === headerLabel
  );
  if (index === -1) {
    throw new Error(`Could not find the "${headerLabel}" column header`);
  }
  return index;
}

export function getGridCellForSessionName(
  sessionName: string,
  headerLabel: string
): HTMLElement {
  const childIndex = columnChildIndexByHeader(headerLabel);
  const row = screen.getByText(sessionName).closest(".group.grid");
  if (!(row instanceof HTMLElement)) {
    throw new Error(`Could not find sessions table row for ${sessionName}`);
  }
  const cell = row.children[childIndex];
  if (!(cell instanceof HTMLElement)) {
    throw new Error(`Could not find cell ${childIndex} for ${sessionName}`);
  }
  return cell;
}
