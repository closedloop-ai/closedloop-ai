import {
  SourceAccessState,
  type SourceOccurrence,
  SourceOccurrenceType,
} from "@repo/api/src/types/agent-component";
import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  type AgentComponentInvocationReadPage,
  AgentComponentInvocationRelationship,
} from "@repo/api/src/types/agent-component-invocation";
import { formatNumber } from "@repo/app/shared/lib/format-utils";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { AGENTS_PAGE_SIZE } from "../../../lib/agents-timeframe";
import { InvocationEvidenceList } from "../invocation-evidence-list";

const RE_ATTRIBUTION_EXCEPTIONS = /Attribution exceptions:/;

function invocationPage(
  overrides: Partial<AgentComponentInvocationReadPage> = {}
): AgentComponentInvocationReadPage {
  return {
    items: [
      {
        id: "invocation-1",
        externalInvocationId: "toolu_1",
        sessionId: "session-1",
        externalSessionId: "external-session-1",
        sourceSessionId: "external-session-1",
        externalAgentId: "agent-native-1",
        kind: AgentComponentInvocationKind.Skill,
        componentKey: "review",
        normalizedName: "review",
        relationship: AgentComponentInvocationRelationship.Associated,
        invokedAt: "2026-07-22T12:00:00.000Z",
        sequence: 3,
        anchor: {
          kind: AgentComponentInvocationAnchorKind.Event,
          eventId: "event-1",
        },
        providerInvocationId: "toolu_1",
        status: AgentComponentInvocationAttributionStatus.Matched,
        evidenceClass: AgentComponentInvocationEvidenceClass.TranscriptSnapshot,
        definitionVersionId: "definition-version-1",
        definitionHash: "exact-definition-hash",
        repositoryFullName: "context/repo-must-not-render",
        sourcePath: "/context/path-must-not-render",
        branchName: "feat/evidence",
      },
    ],
    total: 1,
    hasMore: false,
    unmatchedCount: 2,
    ambiguousCount: 1,
    ...overrides,
  };
}

function renderWithNavigation(children: ReactNode) {
  const navigation = createMemoryNavigation({
    initialPath: "/agents",
    orgSlug: "org-test",
  });
  return render(
    <NavigationProvider adapter={navigation.adapter}>
      {children}
    </NavigationProvider>
  );
}

describe("InvocationEvidenceList", () => {
  it("renders exact attribution fields and a file-plus-anchor session link", () => {
    renderWithNavigation(
      <InvocationEvidenceList
        getSessionHref={(sessionId) => `/sessions/${sessionId}`}
        page={invocationPage()}
      />
    );

    expect(screen.getByText("1 recorded")).toBeInTheDocument();
    expect(
      screen.getByText("Attribution exceptions: 2 unmatched · 1 ambiguous")
    ).toBeInTheDocument();
    expect(
      screen.getByText((content) => content.startsWith("Skill ·"))
    ).toBeInTheDocument();
    expect(screen.getByText("sha256:exact-defi…hash")).toHaveAttribute(
      "title",
      "exact-definition-hash"
    );
    expect(
      screen.getByRole("button", { name: "Copy hash" })
    ).toBeInTheDocument();
    expect(screen.queryByText("definition-version-1")).not.toBeInTheDocument();
    expect(screen.getByText("Matched")).toBeInTheDocument();
    expect(screen.getByText("Transcript snapshot")).toBeInTheDocument();
    expect(screen.getByText("feat/evidence")).toBeInTheDocument();

    const link = screen.getByRole("link", { name: "external-session-1" });
    const href = link.getAttribute("href") ?? "";
    const params = new URLSearchParams(href.split("?")[1]);
    expect(params.get("file")).toBe("subagent:agent-native-1");
    expect(params.get("invocationAnchor")).toContain("toolu_1");
  });

  it("renders the shared DS empty state when no evidence rows are recorded", () => {
    renderWithNavigation(
      <InvocationEvidenceList
        page={invocationPage({ items: [], total: 0, hasMore: false })}
      />
    );

    expect(screen.getByText("No evidence recorded")).toBeInTheDocument();
    expect(
      screen.getByText(
        "No exact invocation evidence has been recorded for this component yet."
      )
    ).toBeInTheDocument();
    // Design review (#3688): with zero rows the stats strip is suppressed so
    // the empty state stands alone — not stacked under "0 recorded" +
    // "Attribution exceptions: 0 unmatched · 0 ambiguous".
    expect(screen.queryByText("0 recorded")).toBeNull();
    expect(screen.queryByText(RE_ATTRIBUTION_EXCEPTIONS)).toBeNull();
  });

  it("does not present session context as genuine transcript-snapshot provenance", () => {
    const { container } = renderWithNavigation(
      <InvocationEvidenceList page={invocationPage()} />
    );
    expect(screen.getByText("Not captured")).toBeInTheDocument();
    expect(container).not.toHaveTextContent("context/repo-must-not-render");
    expect(container).not.toHaveTextContent("/context/path-must-not-render");
  });

  it("emphasizes unmatched attribution as a warning", () => {
    const page = invocationPage();
    const item = page.items[0];
    if (!item) {
      throw new Error("missing invocation fixture");
    }
    page.items = [
      {
        ...item,
        status: AgentComponentInvocationAttributionStatus.Unmatched,
      },
    ];

    renderWithNavigation(<InvocationEvidenceList page={page} />);

    expect(screen.getByText("Unmatched")).toHaveClass("bg-warning/14");
  });

  it("uses the file-aligned Claude subagent id without replacing provider identity", () => {
    const page = invocationPage();
    const item = page.items[0];
    if (!item) {
      throw new Error("missing invocation fixture");
    }
    page.items = [
      {
        ...item,
        externalInvocationId: "subagent:agent-provider-1",
        externalAgentId: "provider-1",
        kind: AgentComponentInvocationKind.Subagent,
        componentKey: "reviewer",
        relationship: AgentComponentInvocationRelationship.Direct,
        anchor: {
          kind: AgentComponentInvocationAnchorKind.Agent,
          agentId: "session-1-parser-sub-agent-provider-1",
          transcriptFileId: "agent-provider-1",
        },
      },
    ];

    renderWithNavigation(
      <InvocationEvidenceList
        getSessionHref={(sessionId) => `/sessions/${sessionId}`}
        page={page}
      />
    );

    const link = screen.getByRole("link", { name: "external-session-1" });
    const href = link.getAttribute("href") ?? "";
    const params = new URLSearchParams(href.split("?")[1]);
    expect(params.get("file")).toBe("subagent:agent-provider-1");
    expect(params.get("invocationAnchor")).toContain(
      '"externalAgentId":"provider-1"'
    );
  });

  it("labels every source-occurrence type explicitly instead of defaulting new kinds to 'Pack source' (FEA-3982)", () => {
    const baseOccurrence: SourceOccurrence = {
      occurrenceType: SourceOccurrenceType.Local,
      accessState: SourceAccessState.Accessible,
      repoFullName: null,
      repoPath: null,
      repoCommit: null,
      computeTargetId: null,
      localPath: null,
      packId: null,
      firstSeenAt: "2026-07-22T12:00:00.000Z",
      lastSeenAt: "2026-07-22T12:00:00.000Z",
    };
    const cases: { occurrence: SourceOccurrence; label: string }[] = [
      {
        occurrence: {
          ...baseOccurrence,
          occurrenceType: SourceOccurrenceType.StaticFile,
          localPath: "/repo/.claude/skills/review.md",
        },
        // ISS-4805: the absolute capture is published as its PORTABLE TAIL —
        // this list is the org-shared surface the detail header was redacted
        // for, so it must not print the machine-rooted prefix either.
        label: "Static file · .claude/skills/review.md",
      },
      {
        occurrence: {
          ...baseOccurrence,
          occurrenceType: SourceOccurrenceType.Distributed,
          packId: "dist-pack-1",
        },
        label: "Distributed · dist-pack-1",
      },
      {
        occurrence: {
          ...baseOccurrence,
          occurrenceType: SourceOccurrenceType.BuiltinClaude,
        },
        label: "Built-in (Claude)",
      },
      {
        occurrence: {
          ...baseOccurrence,
          occurrenceType: SourceOccurrenceType.BuiltinCodex,
        },
        label: "Built-in (Codex)",
      },
    ];

    for (const { occurrence, label } of cases) {
      const page = invocationPage();
      const item = page.items[0];
      if (!item) {
        throw new Error("missing invocation fixture");
      }
      page.items = [{ ...item, sourceOccurrence: occurrence }];

      const { unmount } = renderWithNavigation(
        <InvocationEvidenceList page={page} />
      );
      // The genuine-source column renders the explicit label, never "Pack source".
      expect(screen.getByText(label)).toBeInTheDocument();
      expect(screen.queryByText("Pack source")).not.toBeInTheDocument();
      unmount();
    }
  });

  /**
   * ISS-4805 — the evidence list is the SAME org-shared surface as the detail
   * header it sits under, so it obeys the same disclosure rule. Before this,
   * redacting the header alone left the page making two different claims about
   * where one definition lives: an identity key above, a full
   * `/Users/<someone>/…` path in the row below it.
   */
  describe("machine-path disclosure (ISS-4805)", () => {
    const occurrence = (
      overrides: Partial<SourceOccurrence>
    ): SourceOccurrence => ({
      occurrenceType: SourceOccurrenceType.Local,
      accessState: SourceAccessState.Accessible,
      repoFullName: null,
      repoPath: null,
      repoCommit: null,
      computeTargetId: null,
      localPath: null,
      packId: null,
      firstSeenAt: "2026-07-22T12:00:00.000Z",
      lastSeenAt: "2026-07-22T12:00:00.000Z",
      ...overrides,
    });

    const renderOccurrence = (source: SourceOccurrence) => {
      const page = invocationPage();
      const item = page.items[0];
      if (!item) {
        throw new Error("missing invocation fixture");
      }
      page.items = [{ ...item, sourceOccurrence: source }];
      return renderWithNavigation(<InvocationEvidenceList page={page} />);
    };

    it("publishes only the portable tail of a local occurrence's path", () => {
      renderOccurrence(
        occurrence({
          computeTargetId: "target-1",
          localPath: "/Users/someone/Code/proj/.claude/skills/foo/SKILL.md",
        })
      );

      expect(
        screen.getByText("target-1 · .claude/skills/foo/SKILL.md")
      ).toBeInTheDocument();
      expect(screen.queryByText(RE_MACHINE_ROOTED_PATH)).toBeNull();
    });

    it("omits a path with no portable part rather than printing it raw", () => {
      renderOccurrence(
        occurrence({
          computeTargetId: "target-1",
          localPath: "/Users/someone/scratch/notes.md",
        })
      );

      // The occurrence still renders the evidence that IS portable.
      expect(screen.getByText("target-1")).toBeInTheDocument();
      expect(screen.queryByText(RE_MACHINE_ROOTED_PATH)).toBeNull();
    });

    it("falls back to the bare label when a static file has no portable path", () => {
      renderOccurrence(
        occurrence({
          occurrenceType: SourceOccurrenceType.StaticFile,
          localPath: "/Users/someone/scratch/notes.md",
        })
      );

      expect(screen.getByText("Static file")).toBeInTheDocument();
      expect(screen.queryByText(RE_MACHINE_ROOTED_PATH)).toBeNull();
    });
  });
});

/**
 * ISS-4805: any rendered text still rooted on the capturing machine. Asserting
 * the ABSENCE of this shape (rather than of one literal) is what makes the
 * disclosure guard hold for a path the fixture did not anticipate.
 */
const RE_MACHINE_ROOTED_PATH = /(^|\s)(\/Users\/|\/home\/|~\/|[A-Za-z]:\\)/;

/**
 * ISS-5520 — the Evidence caption's total marked as a floor. `page.total` is an
 * exact count on BOTH producers, so this shape is always wrong here.
 */
const RE_FLOOR_MARKED_TOTAL = /Showing [\d,]+ of [\d,]+\+ invocations/;

/** Any Evidence truncation caption at all, for the nothing-omitted regime. */
const RE_ANY_EVIDENCE_NOTICE = /Showing [\d,]+ of /;

/** The self-contradicting caption an incredible (racy) count would produce. */
const RE_TOTAL_BELOW_RENDERED = /Showing 10 of 4 invocations/;

/** The `tool::bash`-scale population from the ISS-5520 report. */
const EXACT_INVOCATION_TOTAL = 1218;

/** The revived-Date fixture's row names, in render order. */
const RE_REVIVED_INVOCATION = /^revived-invocation-\d+$/;

/** The stats strip's population claim, capturing the `+` when it is a floor. */
const RE_STATS_STRIP = /^([\d,]+\+?) recorded$/;
/** The caption's population claim, same capture. */
const RE_CAPTION_TOTAL = /^Showing [\d,]+ of ([\d,]+\+?) invocations$/;

/**
 * The two population claims this panel puts on screen: the stats strip above the
 * table, and the truncation caption below it (`null` when nothing was omitted
 * and the caption is correctly silent).
 *
 * Read structurally, `+` included, so a test can assert the panel does not
 * CONTRADICT ITSELF rather than pinning two literals that happen to agree in one
 * fixture. The captured group is the population each one names.
 */
function renderedPopulationClaims(): {
  strip: string | undefined;
  caption: string | undefined | null;
} {
  const strip = screen.getByText(RE_STATS_STRIP).textContent ?? "";
  const caption = screen.queryByText(RE_CAPTION_TOTAL)?.textContent;
  return {
    strip: RE_STATS_STRIP.exec(strip)?.[1],
    caption: caption === undefined ? null : RE_CAPTION_TOTAL.exec(caption)?.[1],
  };
}

/**
 * ISS-5520 — the Evidence tab must state the population it actually knows.
 *
 * The caption took `isTotalPartial: page.hasMore`, on the premise that
 * `hasMore` meant the read was bounded and so the total was only a floor. That
 * premise is false on both producers: the cloud read sums an UNCAPPED `groupBy`
 * COUNT and desktop a bare `COUNT(*)`, then derive `hasMore: total >
 * rows.length` from it — only the ROW LIST is capped (at 500). So once that cap
 * bound, the tab rendered "Showing 50 of 1,218+ invocations" for a population
 * known to be exactly 1,218, one line below a stats strip printing that same
 * 1,218 flatly. Nothing covered the `+` arm: every pre-existing case here builds
 * `total: 1, hasMore: false` or `total: 0`.
 *
 * This is ISS-5520's defect in the opposite direction — the Sessions tab printed
 * a page cap as the population, this printed a known population as a floor — and
 * both are the caption failing to say exactly what the data supports.
 */
describe("InvocationEvidenceList truncation caption (ISS-5520)", () => {
  /**
   * A page whose row list was capped by the producer while its count was not:
   * `delivered` rows stand in for the server's bounded read, `total` for the
   * uncapped COUNT beside it.
   */
  function cappedPage(
    delivered: number,
    total: number
  ): AgentComponentInvocationReadPage {
    const base = invocationPage();
    const item = base.items[0];
    if (!item) {
      throw new Error("missing invocation fixture");
    }
    return {
      ...base,
      items: Array.from({ length: delivered }, (_, index) => ({
        ...item,
        id: `invocation-${index + 1}`,
        externalInvocationId: `toolu_${index + 1}`,
        sequence: index + 1,
      })),
      total,
      hasMore: total > delivered,
    };
  }

  it("states the exact total when the row read was capped but the count was not", () => {
    renderWithNavigation(
      <InvocationEvidenceList
        page={cappedPage(AGENTS_PAGE_SIZE + 10, EXACT_INVOCATION_TOTAL)}
      />
    );

    expect(
      screen.getByText(
        `Showing ${formatNumber(AGENTS_PAGE_SIZE)} of ${formatNumber(EXACT_INVOCATION_TOTAL)} invocations`
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(RE_FLOOR_MARKED_TOTAL)).toBeNull();
    // The strip states the same population, with the caption's separators — it
    // printed the raw integer ("1218 recorded") before this change — and the
    // caption agrees with it.
    const claims = renderedPopulationClaims();
    expect(claims.strip).toBe(formatNumber(EXACT_INVOCATION_TOTAL));
    expect(claims.caption).toBe(claims.strip);
  });

  it("does not call a count exact when the delivered rows already exceed it", () => {
    // ISS-5520 (wongk review, #4716): the credibility test must weigh the count
    // against the rows the producer DELIVERED, not the 50 this list renders.
    // `items` carries up to 500, so a count of 55 beside 60 delivered rows
    // clears a `>= rows.length` test and is accepted as exact — while the
    // payload in hand already proves at least 60. Only the between-rendered-
    // and-delivered band exposes that; the 10-vs-4 race below does not, because
    // there the count falls under the rendered count too.
    const delivered = AGENTS_PAGE_SIZE + 10;
    const racyCount = AGENTS_PAGE_SIZE + 5;
    renderWithNavigation(
      <InvocationEvidenceList page={cappedPage(delivered, racyCount)} />
    );

    // The count is not believable, so it must not be stated as the population...
    expect(
      screen.queryByText(
        `Showing ${formatNumber(AGENTS_PAGE_SIZE)} of ${formatNumber(racyCount)} invocations`
      )
    ).toBeNull();
    // ...and the floor is what the payload proves: the delivered rows.
    expect(
      screen.getByText(
        `Showing ${formatNumber(AGENTS_PAGE_SIZE)} of ${formatNumber(delivered)}+ invocations`
      )
    ).toBeInTheDocument();
    const claims = renderedPopulationClaims();
    expect(claims.strip).toBe(`${formatNumber(delivered)}+`);
    expect(claims.caption).toBe(claims.strip);
  });

  it("says nothing when every invocation is already on screen", () => {
    // The other regime. A caption here would imply a truncation that did not
    // happen; asserting only the capped case would pass on a build that always
    // prints a notice.
    renderWithNavigation(<InvocationEvidenceList page={cappedPage(3, 3)} />);

    expect(screen.queryByText(RE_ANY_EVIDENCE_NOTICE)).toBeNull();
    // No caption to agree with, but the strip must still state the exact count
    // rather than mark a floor on a complete page.
    const claims = renderedPopulationClaims();
    expect(claims.caption).toBeNull();
    expect(claims.strip).toBe("3");
  });

  it("sorts a payload whose dates the web client already revived into Date objects", () => {
    // ISS-5520 (#4716) — the WEB adapter's former runtime shape, and a crash
    // this suite could not see.
    //
    // `use-api-client.ts` reads every response with
    // `JSON.parse(rawBody, reviveWithDates)`, which USED TO replace any ISO-8601
    // string with a `Date` whatever the key. `invokedAt` is DECLARED
    // `string | null`, so the comparator called `.localeCompare` on it — a method
    // `Date` does not have — and sorting threw, taking the whole detail page into
    // its error boundary.
    //
    // Nothing caught it because `Array.prototype.sort` never calls the
    // comparator for fewer than two elements, and every other fixture here
    // carries ONE row. Two rows plus the revived shape is the whole reproduction.
    //
    // ISS-5771 gated revival to the keys a route-served contract declares as a
    // `Date`, so the wire no longer delivers this shape and the cast no longer
    // describes production. The case stays as a direct test of the comparator's
    // normalization, which remains as defense in depth — it must not regress to
    // calling a string method on whatever it is handed.
    const revived = cappedPage(2, 2);
    const page = {
      ...revived,
      items: revived.items.map((item, index) => ({
        ...item,
        invokedAt: new Date(
          Date.UTC(2026, 6, 22, 12) + index * 60_000
        ) as unknown as string,
        normalizedName: `revived-invocation-${index}`,
      })),
    };

    renderWithNavigation(<InvocationEvidenceList page={page} />);

    // Rendering at all is the assertion: before the fix this threw during the
    // sort. The newest row sorts first, so the order is still honoured.
    const names = screen
      .getAllByText(RE_REVIVED_INVOCATION)
      .map((node) => node.textContent);
    expect(names).toEqual(["revived-invocation-1", "revived-invocation-0"]);
  });

  it("falls back to a floor when the count arrives below the rows beside it", () => {
    // Each producer reads its rows and its count in two queries that are not in
    // one transaction, so a concurrent write can return a count BELOW the
    // delivered rows. Printing it would read "Showing 10 of 4 invocations";
    // trusting it as exact would let `total <= rendered` swallow the notice on a
    // page that did cut rows. The floor keeps the one true statement.
    renderWithNavigation(<InvocationEvidenceList page={cappedPage(10, 4)} />);

    expect(
      screen.getByText("Showing 10 of 10+ invocations")
    ).toBeInTheDocument();
    expect(screen.queryByText(RE_TOTAL_BELOW_RENDERED)).toBeNull();
    // ISS-5520 (wongk + codex review, #4716): the fixture that proves the
    // fallback used to render "4 recorded" directly above "Showing 10 of 10+
    // invocations" — the panel contradicting itself in the exact race this test
    // was added for, demonstrated rather than caught. The strip is now driven by
    // the same credibility decision, so the stale count cannot survive it.
    expect(screen.queryByText("4 recorded")).toBeNull();
    const claims = renderedPopulationClaims();
    expect(claims.strip).toBe("10+");
    expect(claims.caption).toBe(claims.strip);
  });
});
