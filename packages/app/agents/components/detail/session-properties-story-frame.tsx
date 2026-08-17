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
  return (
    // The `.sd3` root is load-bearing, not decoration: `styles.css` scopes the
    // monospace face as `.sd3 .mono, .st .mono`, and `sd3-props` is a separate
    // class token that does NOT match it. Without this wrapper the Tokens row
    // renders in the body face in Storybook and in monospace in production —
    // the exact divergence this frame exists to prevent. Production nests the
    // same way (`agent-session-detail-view.tsx`: `.sd3` → `.prd-props-section
    // .sd3-props`), so the frame mirrors that ancestry rather than inventing it.
    <div className="sd3">
      <section className="prd-props-section sd3-props" data-open="true">
        <div className="prd-props">{children}</div>
      </section>
    </div>
  );
}
