import type { ReactNode } from "react";
import { NavId } from "../navigation/route-table";
import { LabsPageHold, LabsPageUnavailable } from "./labs-gate-surfaces";
import { PageShell } from "./layout/page-shell";

// ISS-5037 (wongk story review on PR #4341): the two Labs container-gate
// surfaces, on a canvas.
// `nav-config-labs-gate` and the app-shell suite prove which OUTCOME gets
// chosen — they cannot prove what it LOOKS like when it renders, and the whole
// claim in these components' docstrings is visual: the hold keeps the first
// frame the shape of the page being opened, and the closed state names the
// destination instead of borrowing its empty state. Both land on the one screen
// a user hits after a stale bookmark, so a layout or copy regression here would
// otherwise ship silently.
// Same setup `route-fallbacks.stories.tsx` uses for the detail fallbacks, which
// is the closest sibling — and the baseline this hold state deliberately is
// not (a bare centered "Loading...").
/**
 * What a page shows when it sits behind an experimental Labs feature that is
 * not turned on for you, or is still checking. One surface is an empty state
 * that names the page, says it is turned off, and gives you a button that
 * goes to the actual control that turns it back on, whether that is in
 * Settings or the application menu. The other is a loading skeleton shown
 * inside the same page layout while the app is still checking, so the page
 * never flashes from blank to content. Reach for these instead of a generic
 * loading or not found screen: they always point at the real way back in, so
 * a stale bookmark never leaves you stuck looking at the wrong switch.
 */
const meta = {
  title: "Composites/App Shell/Labs Gate Surfaces",
  component: LabsPageUnavailable,
  tags: ["autodocs"],
  // Each story mounts its own surface with the props it is about, so a control
  // here would edit an arg no render function reads.
  argTypes: {
    pageId: { control: false },
    labsNavOn: { control: false },
  },
  parameters: {
    layout: "fullscreen",
  },
};

export default meta;

/**
 * The gate resolved CLOSED on the page the user asked for, with a SHORT nav
 * title ("Packs"). The title interpolates into the heading, so both lengths are
 * worth seeing: the heading, the description, and the single way out must stay
 * balanced rather than the heading collapsing to two words.
 */
export const UnavailableShortTitle = {
  render: () =>
    frame(<LabsPageUnavailable labsNavOn={false} pageId={NavId.Packs} />),
};

/**
 * The same closed state with the LONGEST Labs title ("Audit Bot"), which is
 * where an interpolated `${title} is turned off` heading would wrap first.
 */
export const UnavailableLongTitle = {
  render: () =>
    frame(<LabsPageUnavailable labsNavOn={false} pageId={NavId.Audit} />),
};

/**
 * ISS-5310: the OTHER closed state. Labs itself is on, and the page's own
 * per-item toggle is what is off, so the description has to send the user to
 * Settings → Labs rather than to an application-menu checkbox that is already
 * ticked. Same component, longest description of the two — worth seeing beside
 * the container-off variant above so the two never drift into different shapes.
 */
export const UnavailablePerItemGate = {
  render: () =>
    frame(<LabsPageUnavailable labsNavOn={true} pageId={NavId.Agents} />),
};

/**
 * The hold, stacked directly above the real page shell it hands off to.
 *
 * This is the pairing that makes the contract checkable: the hold renders the
 * destination's own `PageShell` and title, so when the flag snapshot lands the
 * title and gutters must not move — only the skeleton slab is replaced by the
 * page body. If the two stages do not line up, the "resolving open is a no-op
 * on screen" claim is broken, and you can see it rather than infer it.
 */
export const HoldHandoff = {
  render: () =>
    handoff(
      <LabsPageHold pageId={NavId.Insights} />,
      <PageShell title="Insights">
        <div className="flex h-96 w-full items-center justify-center rounded-xl border border-border bg-card text-muted-foreground text-sm">
          Resolved Insights body
        </div>
      </PageShell>
    ),
};

/** A fixed-height stage so a `h-full`/`flex-1` surface has something to fill. */
function frame(children: ReactNode) {
  return <div className="flex h-[540px] flex-col">{children}</div>;
}

/**
 * The hold stacked above the resolved page it hands off to, each in its own
 * stage, so the two shapes can be compared directly.
 */
function handoff(hold: ReactNode, resolved: ReactNode) {
  return (
    <div className="flex flex-col gap-6 p-6">
      <section aria-label="Labs gate hold (flag snapshot in flight)">
        <h2 className="pb-2 font-medium text-muted-foreground text-sm">
          Labs gate hold (flag snapshot in flight)
        </h2>
        {frame(hold)}
      </section>
      <section aria-label="Resolved destination">
        <h2 className="pb-2 font-medium text-muted-foreground text-sm">
          Resolved destination
        </h2>
        {frame(resolved)}
      </section>
    </div>
  );
}
