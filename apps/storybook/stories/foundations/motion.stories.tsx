import type { Meta, StoryObj } from "@storybook/react";
import { useEffect, useState } from "react";
import {
  FoundationsPage,
  TokenSection,
  useResolvedTokens,
} from "./token-table";

/**
 * The named animations `globals.css` publishes through `@theme inline`. Each
 * value is the full CSS `animation` shorthand, which is why the previews below
 * can apply `var(--<token>)` directly rather than restating a duration and an
 * easing that would immediately start drifting.
 */
const ANIMATION_TOKENS = [
  {
    note: "Accordion and collapsible content opening.",
    token: "animate-accordion-down",
  },
  {
    note: "The same content closing.",
    token: "animate-accordion-up",
  },
  {
    note: "Progress with no known total. Loops until the work finishes.",
    token: "animate-progress-indeterminate",
  },
  {
    note: "A status pill's dot, marking the row that is currently live.",
    token: "animate-status-pulse",
  },
  {
    note: "The ring around that pill, so the mark is findable in a long column.",
    token: "animate-status-pulse-ring",
  },
] as const;

/**
 * Reads the viewer's own motion preference, so this page can say which branch
 * they are actually seeing rather than describing both and leaving them to
 * guess. Matches how the components decide: Tailwind's `motion-safe:` and
 * `motion-reduce:` variants compile to this same media query.
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  return reduced;
}

const AnimationTable = () => {
  const values = useResolvedTokens(ANIMATION_TOKENS.map((row) => row.token));

  return (
    <div className="divide-y rounded-lg border bg-card">
      {ANIMATION_TOKENS.map(({ note, token }) => (
        <div
          className="flex flex-wrap items-center justify-between gap-4 p-4"
          key={token}
        >
          <div className="min-w-0 space-y-0.5">
            <p className="font-mono text-xs">--{token}</p>
            <p className="font-mono text-muted-foreground text-xs">
              {values[token] || "not set"}
            </p>
            <p className="text-muted-foreground text-xs">{note}</p>
          </div>
          {/* Runs the real token. If the declaration changes in globals.css,
              this preview changes with it and the value above changes too. */}
          <div
            className="size-8 shrink-0 rounded-full bg-primary"
            style={{ animation: `var(--${token})` }}
          />
        </div>
      ))}
    </div>
  );
};

const ReducedMotionPanel = () => {
  const reduced = usePrefersReducedMotion();

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-card p-4">
        <p className="text-sm">
          Your system is currently set to{" "}
          <span className="font-semibold">
            {reduced ? "reduce motion" : "allow motion"}
          </span>
          . The pills below follow that setting, the same way the product does.
        </p>
      </div>

      <div className="flex flex-wrap gap-6 rounded-lg border bg-card p-6">
        <div className="space-y-2">
          <span className="inline-flex h-6 items-center gap-1.5 rounded-full border border-success/25 bg-success/12 px-2.5 font-semibold text-[11px] text-success tracking-[0.01em]">
            <span className="size-1.5 rounded-full bg-success motion-safe:animate-status-pulse" />
            Running
          </span>
          <p className="text-muted-foreground text-xs">Dot pulse</p>
        </div>

        <div className="space-y-2">
          <span className="inline-flex h-6 items-center gap-1.5 rounded-full border border-success/25 bg-success/12 px-2.5 font-semibold text-[11px] text-success tracking-[0.01em] motion-safe:animate-status-pulse-ring motion-reduce:ring-2 motion-reduce:ring-current/55">
            <span className="size-1.5 rounded-full bg-success" />
            Running
          </span>
          <p className="text-muted-foreground text-xs">Ring pulse</p>
        </div>
      </div>
    </div>
  );
};

const MotionPage = () => (
  <FoundationsPage
    description="Motion in this system is named, not ad hoc. Every repeating or state-changing animation is published as a token in globals.css, so a component asks for a behaviour by name instead of picking its own duration. The values on this page are read out of the DOM at runtime, so they cannot drift from the stylesheet."
    title="Motion"
  >
    <TokenSection
      note="Published through @theme inline, so each is available as an animate-* utility as well as a custom property."
      title="Named animations"
    >
      <AnimationTable />
    </TokenSection>

    <TokenSection
      note="motion-safe: and motion-reduce: are exclusive. A component that animates under one must say what it becomes under the other, or a viewer who asked for less motion loses the signal entirely rather than seeing a calmer version of it."
      title="Reduced motion"
    >
      <ReducedMotionPanel />
    </TokenSection>

    <TokenSection
      note="Overlays (dialog, sheet, popover, dropdown, tooltip) use the animate-in and animate-out utilities with per-side slide and fade modifiers, rather than named tokens. They are entrance and exit choreography tied to a component's open state, not reusable behaviours, so they are configured at the component and documented in that component's own story."
      title="Enter and exit"
    >
      <div className="rounded-lg border bg-card p-4">
        <p className="text-muted-foreground text-sm">
          These live under Design System / Primitives: Dialog, Sheet, Popover,
          Dropdown Menu and Tooltip. Opening one in its own story is the
          accurate way to review the transition, because the direction depends
          on the side it opens from.
        </p>
      </div>
    </TokenSection>
  </FoundationsPage>
);

const meta = {
  title: "Foundations/Motion",
  component: MotionPage,
  parameters: {
    controls: { disable: true },
    layout: "fullscreen",
  },
} satisfies Meta<typeof MotionPage>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
