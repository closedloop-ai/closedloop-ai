/**
 * ISS-5464: bounding the `sessionsTab` payload must not cost the Evidence tab
 * its session links.
 *
 * `AgentDetail` builds the invocation -> session href map. It used to build that
 * map ONLY from `data.sessionsTab`, which was fine while that array carried up
 * to 1000 sessions — but ISS-5464 bounds it to the 50 the Sessions tab renders,
 * and an invocation row can belong to ANY of the component's sessions. Measured
 * against the seeded profiling database, the bound took `tool::Bash` from 390 of
 * 500 Evidence rows navigable (78%) to 0 of 500.
 *
 * The fix resolves the href from the invocation's own canonical `sessionId` and
 * uses `usageSessions` — one row per session that used this component, NOT
 * bounded — as the existence guard, so links survive the bound without ever
 * pointing at a session the component did not run in.
 *
 * Driven through the real `AgentDetail` render path so the assertion covers the
 * production wiring, not a synthetic prop bundle.
 */

import type { AgentComponentDetail } from "@repo/api/src/types/agent-component";
import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  type AgentComponentInvocationReadRow,
  AgentComponentInvocationRelationship,
} from "@repo/api/src/types/agent-component-invocation";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import type { AgentComponentsDataSource } from "../../../data-source/agent-components-data-source";
import { AgentComponentsDataSourceProvider } from "../../../data-source/provider";
import { createAgentSessionListItemFixture } from "../../sessions/session-list-fixtures";
import { makeDetail } from "../agent-component-fixtures";
import { AgentDetail } from "../agent-detail";

/** In `sessionsTab` — inside the payload bound. */
const RECENT_SESSION = "session-recent";
/** Used the component, but outside the bounded `sessionsTab` payload. */
const OLDER_SESSION = "session-older";
/** Referenced by an invocation but absent from `usageSessions` entirely. */
const FOREIGN_SESSION = "session-foreign";

const RE_EVIDENCE_TAB = /evidence/i;
/** A session link carries transcript params, so match on the path prefix. */
function linksTo(hrefs: readonly string[], sessionId: string): boolean {
  return hrefs.some((href) => href.startsWith(`/acme/sessions/${sessionId}`));
}

function invocationRow(
  id: string,
  sessionId: string
): AgentComponentInvocationReadRow {
  return {
    id,
    externalInvocationId: `toolu_${id}`,
    sessionId,
    externalSessionId: `external-${sessionId}`,
    sourceSessionId: `external-${sessionId}`,
    kind: AgentComponentInvocationKind.Skill,
    componentKey: "review",
    normalizedName: "review",
    relationship: AgentComponentInvocationRelationship.Associated,
    invokedAt: "2026-07-22T12:00:00.000Z",
    sequence: 1,
    anchor: {
      kind: AgentComponentInvocationAnchorKind.Event,
      eventId: `event-${id}`,
    },
    status: AgentComponentInvocationAttributionStatus.Matched,
    evidenceClass: AgentComponentInvocationEvidenceClass.TranscriptSnapshot,
  };
}

function detailFixture(
  overrides: Partial<AgentComponentDetail> = {}
): AgentComponentDetail {
  return makeDetail({
    id: "uuid-evidence-links",
    slug: "skill::review",
    name: "Review",
    // The TRUE total: more sessions than the bounded payload carries.
    sessions: 2,
    // The BOUNDED payload: only the most recent session travels.
    sessionsTab: [
      createAgentSessionListItemFixture({
        id: RECENT_SESSION,
        externalSessionId: `external-${RECENT_SESSION}`,
        name: "Recent session",
      }),
    ],
    // The UNBOUNDED truth: both sessions used this component.
    usageSessions: [
      { sessionId: RECENT_SESSION, invocationCount: 1 },
      { sessionId: OLDER_SESSION, invocationCount: 1 },
    ],
    invocationRows: {
      items: [
        invocationRow("inv-recent", RECENT_SESSION),
        invocationRow("inv-older", OLDER_SESSION),
        invocationRow("inv-foreign", FOREIGN_SESSION),
      ],
      total: 3,
      hasMore: false,
      unmatchedCount: 0,
      ambiguousCount: 0,
    },
    ...overrides,
  });
}

function detailSource(detail: AgentComponentDetail): AgentComponentsDataSource {
  return {
    scope: "test-evidence-session-links",
    list: () => Promise.reject(new Error("list unused in these tests")),
    detail: () => Promise.resolve(detail),
  };
}

async function renderEvidenceTab(
  overrides: Partial<AgentComponentDetail> = {}
): Promise<void> {
  const detail = detailFixture(overrides);
  // The Evidence tab is URL-driven (`useTabParam`), so deep-link it rather than
  // clicking: the tab state is a permalink, and this keeps the test on the
  // production selection path.
  const navigation = createMemoryNavigation({
    initialPath: `/agents/${detail.id}?tab=evidence`,
    orgSlug: "org-test",
  });
  render(
    <AppCoreStoryProviders>
      <NavigationProvider adapter={navigation.adapter}>
        <AgentComponentsDataSourceProvider dataSource={detailSource(detail)}>
          <AgentDetail
            backHref="/acme/agents"
            getSessionHref={(session) => `/acme/sessions/${session.id}`}
            slug={detail.id}
          />
        </AgentComponentsDataSourceProvider>
      </NavigationProvider>
    </AppCoreStoryProviders>
  );
  // Wait for the detail read to settle and the Evidence panel to mount.
  await screen.findByRole("tab", { name: RE_EVIDENCE_TAB, selected: true });
}

function hrefsOnScreen(): string[] {
  return Array.from(document.querySelectorAll("a[href]")).map(
    (a) => a.getAttribute("href") ?? ""
  );
}

describe("AgentDetail Evidence tab — session links survive the payload bound (ISS-5464)", () => {
  it("links an invocation whose session is OUTSIDE the bounded sessionsTab", async () => {
    await renderEvidenceTab();

    // This is the assertion the pre-fix resolver fails: `session-older` used the
    // component but did not travel in the bounded payload, so a map built only
    // from `sessionsTab` left its invocation row non-navigable.
    expect(linksTo(hrefsOnScreen(), OLDER_SESSION)).toBe(true);
  });

  it("still links an invocation whose session IS in the bounded payload", async () => {
    await renderEvidenceTab();

    expect(linksTo(hrefsOnScreen(), RECENT_SESSION)).toBe(true);
  });

  it("links every Evidence row on the desktop shape, where sessionsTab is empty", async () => {
    // Desktop's local reader routinely returns `sessionsTab: []` while still
    // populating `usageSessions` (`shared-agent-components-api.ts`; the same
    // asymmetry `detail-sessions-tab.tsx` documents for its empty state). Under
    // the old `sessionsTab`-only map that meant NO Evidence row on desktop could
    // ever link. The `usageSessions` existence set is what makes the surface
    // work, so it gets its own case rather than riding on the web shape.
    await renderEvidenceTab({ sessionsTab: [] });

    const hrefs = hrefsOnScreen();
    expect(linksTo(hrefs, RECENT_SESSION)).toBe(true);
    expect(linksTo(hrefs, OLDER_SESSION)).toBe(true);
    expect(linksTo(hrefs, FOREIGN_SESSION)).toBe(false);
  });

  it("does NOT link a session this component never ran in", async () => {
    await renderEvidenceTab();

    // `usageSessions` is the existence guard. Dropping it in favour of "link
    // whatever id the row carries" would render a confident link to a session
    // outside this component's usage — a dead link instead of a missing one.
    expect(linksTo(hrefsOnScreen(), FOREIGN_SESSION)).toBe(false);
  });
});
