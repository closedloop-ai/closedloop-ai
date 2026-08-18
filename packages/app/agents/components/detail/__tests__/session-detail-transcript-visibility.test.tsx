import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import { populatedAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";

// FEA-4025: the Session Detail transcript was rendering behind the pinned
// metadata header. The header pinned the WHOLE metadata dashboard (title,
// Properties, Session Timeline, Activity Segments and Activity Breakdown), so on
// a short viewport it grew taller than the scroll pane, stayed pinned across the
// whole pane, and painted its opaque z-20 backdrop (FEA-2106) over the Session
// Trace — leaving the transcript unreachable behind it.
//
// The fix pins only the small orientation block and lets Properties, Activity
// Segments and Activity Breakdown scroll away as normal document content, so the
// pinned block is small by construction and can never occlude the trace.
//
// ISS-5818 (graduated by ISS-5999) shrank that block further: the identity row
// left the pinned box too, so the Session Timeline strip rides alone. That serves
// FEA-4025's rule harder, not less — the pinned block is strictly shorter than
// the one this suite was written against — so the assertions below are on the
// panels that must NOT ride pinned, plus the one thing that must.
//
// This suite pins the structural guarantees that keep the pinned block small
// (behavioral render — the DOM these render to). jsdom does not apply
// styles.css, so the pixel-level "the header does not cover the trace on a short
// window" guarantee is a Playwright case in e2e/session-detail.spec.ts, which
// runs a real browser at 1000x600 and asserts the rendered header/trace
// geometry.

describe("session detail transcript visibility (FEA-4025)", () => {
  it("pins only the identity row + timeline; Properties and the activity panels scroll below it", () => {
    const { container } = render(
      <AppCoreStoryProviders>
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={populatedAgentSessionDetailFixture}
        />
      </AppCoreStoryProviders>
    );

    const scroll = container.querySelector<HTMLElement>(".sd3-scroll");
    const stickyHead = container.querySelector<HTMLElement>(
      ".sd3-stickyhead.is-sticky"
    );
    const trace = container.querySelector<HTMLElement>(".sd3-trace");

    expect(scroll, "scroll container present").not.toBeNull();
    expect(stickyHead, "pinned metadata header present").not.toBeNull();
    expect(trace, "Session Trace region present").not.toBeNull();

    // The pinned header carries the Session Timeline strip...
    expect(stickyHead?.querySelector(".sd3-actbar")).not.toBeNull();
    // ...and NOT the title, which scrolls away above it (ISS-5818).
    expect(
      stickyHead?.querySelector("h1"),
      "the session title must not ride pinned"
    ).toBeNull();

    // ...but NOT the bulky metadata panels. Properties, the Activity Segments
    // strip and the Activity Breakdown are no longer descendants of the pinned
    // header — they scroll away as normal document content, so the pinned block
    // stays small and cannot blanket the transcript.
    expect(
      stickyHead?.querySelector(".sd3-props"),
      "Properties must not ride pinned"
    ).toBeNull();
    expect(
      stickyHead?.querySelector(".sd3-segs"),
      "Activity Segments must not ride pinned"
    ).toBeNull();
    expect(
      stickyHead?.querySelector('[aria-label="Activity breakdown"]'),
      "Activity Breakdown must not ride pinned"
    ).toBeNull();

    // Those panels still render on the page (they just scroll), inside the same
    // scroll container as the header and the trace.
    const properties = container.querySelector<HTMLElement>(".sd3-props");
    expect(properties, "Properties still rendered").not.toBeNull();
    expect(scroll?.contains(properties as Node)).toBe(true);
    expect(scroll?.contains(stickyHead as Node)).toBe(true);
    expect(scroll?.contains(trace as Node)).toBe(true);

    // The transcript is a later sibling in document order, so it is not nested
    // inside (and cannot be clipped away by) the pinned header.
    expect(stickyHead?.contains(trace as Node)).toBe(false);
    // Node.DOCUMENT_POSITION_FOLLOWING is 0x04; the trace must follow the sticky
    // header in document order. `contains` above already proves it is not a
    // descendant, so a following position means it renders after the header.
    const position = stickyHead?.compareDocumentPosition(trace as Node) ?? 0;
    expect(position).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});
