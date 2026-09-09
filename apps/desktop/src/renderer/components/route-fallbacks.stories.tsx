import { SessionDetailLoading } from "@repo/app/agents/components/detail/agent-session-detail-states";
import { AgentDetailLoading } from "@repo/app/agents/components/workspace/agent-detail-states";
import type { ReactNode } from "react";
import {
  AgentDetailRouteFallback,
  DETAIL_FALLBACK_LABELS,
  DetailRouteFallback,
  PageFallback,
} from "./route-fallbacks";

/**
 * ISS-4838 (wongk story review on PR #4266): the detail-route Suspense
 * fallbacks, on a canvas.
 *
 * These components exist for one reason — geometry. The claim is that the lazy
 * chunk resolving is a no-op on screen ("skeleton → skeleton, never blank →
 * skeleton"), which is a VISUAL contract that a render test can only assert
 * class-by-class. So each detail story puts the fallback directly above the real
 * in-page loading state it hands off to: if the two boxes do not line up, the
 * contract is broken and you can see it rather than infer it.
 *
 * `PageFallback` is included as the baseline these replace — the bare centered
 * "Loading..." on an otherwise blank body that a cold detail open used to show.
 */
const meta = {
  title: "Desktop App/App Shell/Route Fallbacks",
  component: DetailRouteFallback,
  tags: ["autodocs"],
  argTypes: {
    label: {
      control: { type: "radio" },
      options: Object.values(DETAIL_FALLBACK_LABELS),
      description:
        "Accessible name on the polite live region. Deliberately not rendered as visible text.",
    },
  },
  args: {
    label: DETAIL_FALLBACK_LABELS.session,
  },
  parameters: {
    layout: "fullscreen",
  },
};

export default meta;

/**
 * The session detail route. Top: the Suspense fallback shown while the lazy
 * chunk loads. Bottom: `SessionDetailLoading`, the view's own loading state that
 * replaces it. Same full-width `p-4 sm:p-6` gutters, same 520px slab — the swap
 * should move nothing.
 */
export const SessionHandoff = {
  render: () =>
    handoff(
      <DetailRouteFallback label={DETAIL_FALLBACK_LABELS.session} />,
      <SessionDetailLoading />
    ),
};

/**
 * The branch detail route, which shares the session shape — the same fallback
 * with the branch's accessible name.
 */
export const BranchFallback = {
  render: () =>
    frame(<DetailRouteFallback label={DETAIL_FALLBACK_LABELS.branch} />),
};

/**
 * The agent/component detail route, whose loading state is a DIFFERENT shape: a
 * centered `max-w-5xl` column with `px-6 pt-10` insets and a `70vh` slab. Using
 * the session fallback here made the page snap inward and change height the
 * moment the chunk resolved (codex review on PR #4266) — this pairing is what
 * that regression would look like if it came back.
 */
export const AgentHandoff = {
  render: () =>
    handoff(
      <AgentDetailRouteFallback label={DETAIL_FALLBACK_LABELS.agent} />,
      <AgentDetailLoading />
    ),
};

/**
 * The baseline: the generic shell fallback a cold detail open showed before
 * ISS-4838 — a blank body with centered text, which then jumped to a skeleton
 * the instant the chunk landed. No detail route renders this any more; it
 * survives only for the NON-detail routes whose own loading treatment the shell
 * cannot cheaply mirror, and it is on the canvas as the thing the three detail
 * fallbacks above exist not to be.
 */
export const GenericPageFallback = {
  render: () => frame(<PageFallback />),
};

/** A fixed-height stage so a `h-full`/`flex-1` fallback has something to fill. */
function frame(children: ReactNode) {
  return <div className="flex h-[540px] flex-col">{children}</div>;
}

/**
 * The fallback stacked above the real loading state it hands off to, each in its
 * own stage, so the two shapes can be compared directly.
 */
function handoff(fallback: ReactNode, real: ReactNode) {
  return (
    <div className="flex flex-col gap-6 p-6">
      <section aria-label="Suspense fallback">
        <h2 className="pb-2 font-medium text-muted-foreground text-sm">
          Suspense fallback (chunk loading)
        </h2>
        {frame(fallback)}
      </section>
      <section aria-label="Resolved in-page loading state">
        <h2 className="pb-2 font-medium text-muted-foreground text-sm">
          Resolved view's own loading state
        </h2>
        {frame(real)}
      </section>
    </div>
  );
}
