import type { ReactNode } from "react";

/**
 * The production Properties-pane scope, for isolated stories of a single
 * Properties ROW.
 *
 * `agent-session-detail-view.tsx` renders each row inside a
 * `.prd-props-section.sd3-props` section wrapping a `.prd-props` grid, and the
 * label/value column tracks come from that ancestor — so a row mounted bare
 * renders unstyled and the story gives no coverage of the alignment it shares
 * with its neighbours. That alignment is exactly what these stories exist to
 * pin: a dash has to sit in the value track where a number would, not drift.
 *
 * Extracted (ISS-5565, code review) because this scaffold had been copied
 * verbatim into five per-row story files. All five now import it, so a change to
 * the production pane's wrapper markup updates every one of them at once
 * instead of leaving some stories silently framing their row in stale chrome.
 *
 * Two neighbours deliberately keep their own frames and are NOT consumers:
 * `session-pull-request-pill.stories.tsx` wraps its subject in an extra labelled
 * `.prd-prop` row, and `session-pull-requests-row.stories.tsx` pins a max-width
 * and appends a sibling "Lines changed" row. Those differences are the point of
 * those stories, so folding them in here would cost the coverage they exist for.
 */
export function SessionPropertiesFrame({
  children,
}: Readonly<{ children: ReactNode }>) {
  // The `.sd3` root is load-bearing, not decoration: `styles.css` scopes the
  // monospace face as `.sd3 .mono, .st .mono`, and `sd3-props` is a separate
  // class token that does NOT match it. Without this wrapper the Tokens row
  // renders in the body face in Storybook and in monospace in production —
  // the exact divergence this frame exists to prevent. Production nests the
  // same way (`agent-session-detail-view.tsx`: `.sd3` → `.prd-props-section
  // .sd3-props`), so the frame mirrors that ancestry rather than inventing it.
  return (
    <div className="sd3">
      {/* ISS-7229: `.sd3-main` and `.sd3-doc` are NOT decoration either, and
          leaving them out was this frame committing the exact fault it exists to
          prevent — one level up from the one it was written for.

          `.sd3` is `display: flex` with no `flex-direction`, so it lays its
          children out in a ROW, which is right in production where they are the
          document column and the 360px comments rail. Dropped in as the only
          flex child with no `flex: 1`, this `<section>` shrink-wrapped to its
          content: measured at 246px inside a 1408px `.sd3`, which collapsed the
          value track to 92px and ELLIPSISED `$1,438.84` to `$1,43…` in a story
          whose whole job is to show what the row looks like. Production nests
          `.sd3 > .sd3-main > .sd3-scroll > .sd3-doc > section`; `.sd3-main`
          carries the `flex: 1` and `.sd3-doc` the 1000px cap and 32px gutters,
          so the pane gets its real ~936px.

          `.sd3-scroll` is in the chain for a reason that is NOT its overflow. An
          earlier revision of this frame dropped it as "only overflow and
          scroll-padding" and the pane still came out at 310px, because
          `.sd3-main` is a COLUMN flex container and `.sd3-doc` carries
          `margin: 0 auto` — an auto cross-axis margin suppresses `stretch`, so
          the doc shrink-wrapped instead of filling. `.sd3-scroll` is a plain
          block, and that block formatting context is what lets `margin: 0 auto`
          mean "fill to the cap, then centre" the way it does in production. */}
      <div className="sd3-main">
        <div className="sd3-scroll">
          <div className="sd3-doc">
            <section className="prd-props-section sd3-props" data-open="true">
              <div className="prd-props">{children}</div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
