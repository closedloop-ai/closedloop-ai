import type { Meta, StoryObj } from "@storybook/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { FoundationsPage, TokenSection } from "./token-table";

/**
 * The named animations `globals.css` publishes through `@theme inline`. Each
 * value is the full CSS `animation` shorthand, which is why the previews below
 * can apply `var(--<token>)` directly rather than restating a duration and an
 * easing that would immediately start drifting.
 */
const ANIMATION_TOKENS = [
  {
    note: "Collapsible content opening. Animates height, from 0 to the content's own height. Press Expand to run this one.",
    preview: "collapse",
    startOpen: false,
    token: "animate-accordion-down",
  },
  {
    note: "The same content closing, the other half of the pair. Press Collapse to run this one.",
    preview: "collapse",
    startOpen: true,
    token: "animate-accordion-up",
  },
  {
    note: "Progress with no known total. A sheen that crosses the track and loops until the work finishes.",
    preview: "track",
    startOpen: false,
    token: "animate-progress-indeterminate",
  },
  {
    note: "A status pill's dot, marking the row that is currently live.",
    preview: "dot",
    startOpen: false,
    token: "animate-status-pulse",
  },
  {
    note: "The ring around that pill, so the mark is findable in a long column.",
    preview: "dot",
    startOpen: false,
    token: "animate-status-pulse-ring",
  },
] as const;

/**
 * The durations this system actually reaches for, shortest to longest.
 *
 * These are Tailwind's scale rather than custom tokens: the system publishes no
 * `--duration-*` of its own, so a component writes `duration-200` directly. The
 * list is the subset in real use, not the whole scale, so the page shows the
 * vocabulary someone should pick from instead of every value that would parse.
 */
const DURATIONS = [
  {
    utility: "duration-100",
    when: "A control acknowledging a press. Fast enough to feel instant.",
  },
  {
    utility: "duration-150",
    when: "Hover and focus on a small target.",
  },
  {
    utility: "duration-200",
    when: "The default. Most colour and transform changes land here.",
  },
  {
    utility: "duration-300",
    when: "Something entering or leaving, where the eye needs to follow it.",
  },
  {
    utility: "duration-500",
    when: "A large surface moving. Rare, and slow enough to notice.",
  },
] as const;

/**
 * The four easings, and what each one communicates. An easing is not decoration:
 * it says whether a thing is arriving, leaving, or being dragged.
 */
const EASINGS = [
  {
    utility: "ease-linear",
    when: "No acceleration. Correct for a spinner or a progress bar, wrong for almost everything else, because real objects do not start at full speed.",
  },
  {
    utility: "ease-in",
    when: "Starts slow, ends fast. For something leaving: it accelerates away.",
  },
  {
    utility: "ease-out",
    when: "Starts fast, settles gently. For something arriving, and the safest default for an entrance.",
  },
  {
    utility: "ease-in-out",
    when: "Eases at both ends. For a change that starts and finishes on screen, such as a panel resizing.",
  },
] as const;

/** Hoisted per useTopLevelRegex: this runs once per easing row per render. */
const CUBIC_BEZIER =
  /cubic-bezier\(([\d.-]+),\s*([\d.-]+),\s*([\d.-]+),\s*([\d.-]+)\)/;

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

/**
 * Reads one computed property back off a real element, so a row prints the
 * value the browser resolved rather than a number typed into this file.
 *
 * Same contract as `useResolvedTokens` next door and for the same reason: a
 * utility that gets renamed or dropped shows up here as "not set" instead of as
 * a stale readout that quietly lies. Under jsdom, where the stylesheet is not
 * loaded, every read comes back empty and the rows print "not set" rather than
 * throwing, which is what keeps this page mountable in the story sweep.
 */
function useComputedValue(
  ref: React.RefObject<HTMLElement | null>,
  property: string
): string {
  const [value, setValue] = useState("");

  useEffect(() => {
    const read = () => {
      const node = ref.current;
      if (!node) {
        return;
      }
      setValue(getComputedStyle(node).getPropertyValue(property).trim());
    };

    read();

    // The theme decorator swaps a class on <html> without remounting, so watch
    // for it the same way the token table does.
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, {
      attributeFilter: ["class"],
      attributes: true,
    });
    return () => observer.disconnect();
  }, [ref, property]);

  return value;
}

/**
 * Replaying is the whole point of this page. A still frame of a transition
 * tells you nothing, and a loop gives you no start to watch, so every demo
 * below moves only when someone asks it to and they all move together: the
 * comparison between two durations is only legible if they start on the
 * same tick.
 *
 * Replay RESETS and then runs. An earlier version sent the squares home on a
 * timer, which meant every click played the motion twice, forwards and then
 * backwards, and the return leg was the one still moving when you looked. The
 * reset now happens on the click and is instant: `resetting` switches the
 * transition off for one frame, so the squares jump to the start rather than
 * gliding there, and they stay at the finish afterwards until you ask again.
 */
function useReplay(): readonly [boolean, boolean, () => void] {
  const [on, setOn] = useState(false);
  const [resetting, setResetting] = useState(false);

  const replay = useCallback(() => {
    setResetting(true);
    setOn(false);
    // Two frames: one for the browser to paint the start position with the
    // transition suppressed, the next to turn it back on and move. Doing both
    // in a single tick is coalesced and nothing animates at all.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setResetting(false);
        setOn(true);
      });
    });
  }, []);

  return [on, resetting, replay] as const;
}

/**
 * Plays a demo when it scrolls into view, and again whenever it comes back.
 *
 * These sections sit below the fold, so without this you had to find a button
 * before the page would show you anything. Scrolling to a demo is already the
 * gesture that says "show me this one".
 *
 * Does nothing when the viewer asked for reduced motion. This is the page that
 * documents that preference, so it is the last place that should ignore it: the
 * Replay button still works there, because pressing it is an explicit request
 * rather than something the page decided to do at them.
 *
 * `IntersectionObserver` is guarded because the story sweep mounts this page in
 * jsdom, which has no implementation of it.
 */
function useReplayOnView(replay: () => void, enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!(node && enabled) || typeof IntersectionObserver === "undefined") {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            replay();
          }
        }
      },
      // Enough of the panel on screen that the rows are actually being looked
      // at, rather than firing off the first pixel and finishing above the fold.
      { threshold: 0.3 }
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [replay, enabled]);

  return ref;
}

function ReplayButton({ onClick }: Readonly<{ onClick: () => void }>) {
  return (
    <button
      className="rounded-md border bg-card px-3 py-1.5 font-medium text-xs transition-colors duration-150 hover:bg-muted"
      onClick={onClick}
      type="button"
    >
      Replay
    </button>
  );
}

/** One bar that travels its track, carrying the utility under test. */
function TravelRow({
  className,
  label,
  on,
  readout,
  resetting,
  when,
}: Readonly<{
  className: string;
  label: string;
  on: boolean;
  readout: string;
  resetting: boolean;
  when: string;
}>) {
  const ref = useRef<HTMLDivElement>(null);
  const duration = useComputedValue(ref, "transition-duration");
  const timing = useComputedValue(ref, "transition-timing-function");
  const resolved = readout === "duration" ? duration : timing;

  return (
    <div className="grid gap-3 p-4 sm:grid-cols-[12rem_1fr] sm:items-center sm:gap-6">
      <div className="min-w-0 space-y-0.5">
        <p className="font-mono text-xs">{label}</p>
        <p className="font-mono text-muted-foreground text-xs">
          {resolved || "not set"}
        </p>
      </div>
      <div className="space-y-2">
        <div className="h-8 w-72 max-w-full overflow-hidden rounded-md bg-muted p-1">
          <div
            className={`size-6 rounded-sm bg-primary transition-transform ${resetting ? "!duration-0" : ""} ${className}`}
            ref={ref}
            // 16rem is the track's inner width (18rem, less the 0.5rem of
            // padding) minus the square's own 1.5rem, so "on" is the far edge
            // rather than a number picked to look about right.
            style={{
              transform: on ? "translateX(16rem)" : "translateX(0)",
            }}
          />
        </div>
        <p className="text-muted-foreground text-xs">{when}</p>
      </div>
    </div>
  );
}

/**
 * The preview each named animation needs, because they do not animate the same
 * property and a single dot cannot show all of them honestly.
 *
 *   dot       an opacity dip or a ring; the element itself is the whole story
 *   track     `progress-indeterminate` translates from -100% to 300%, so it
 *             needs a track to cross and to be clipped by. Uncontained it
 *             travelled three times its own width straight out of the card.
 *   collapse  the accordion pair animates HEIGHT, to and from
 *             `--radix-accordion-content-height`. That variable is set by Radix
 *             at runtime, so on a bare element it resolves to nothing and the
 *             animation has no distance to cover. The preview supplies it.
 */
/**
 * A hidden element carrying the utility, purely so the row can print the value
 * the browser resolved for it.
 *
 * Separate from the preview because the two want different things. The
 * accordion preview swaps between the opening and closing utility as you drive
 * it, so it is the wrong place to ask "what does THIS row's token resolve to".
 * The probe holds one class and never changes.
 */
function TokenProbe({
  probeRef,
  token,
}: Readonly<{
  probeRef: React.RefObject<HTMLSpanElement | null>;
  token: string;
}>) {
  return (
    <span aria-hidden="true" className={`sr-only ${token}`} ref={probeRef} />
  );
}

/**
 * The accordion pair, driven the way the product drives it.
 *
 * `accordion-down` and `accordion-up` are two halves of one component: Radix
 * runs the first on `data-state=open` and the second on `data-state=closed`.
 * Showing them as two separate one-shots to replay meant the closing row was a
 * collapsed panel with nothing in it, and a button that said "Replay" without
 * saying what it would do. A trigger labelled for the state it moves to shows
 * both halves and needs no explaining.
 *
 * Before the first press the height is set inline rather than animated, so the
 * panel opens on the press instead of animating itself on mount.
 */
function AccordionPreview({
  open,
  touched,
}: Readonly<{ open: boolean; touched: boolean }>) {
  const running = open ? "animate-accordion-down" : "animate-accordion-up";

  return (
    <div
      className="w-44 shrink-0 overflow-hidden rounded-md border bg-muted"
      // The height Radix measures onto the content at runtime. Without it
      // `var(--radix-accordion-content-height)` is invalid and the keyframe
      // has nowhere to travel to.
      style={
        { "--radix-accordion-content-height": "3.5rem" } as React.CSSProperties
      }
    >
      {/* `forwards` so the end state stays on screen. The tokens carry no fill
          mode because the product unmounts the element instead, which a preview
          cannot do and still show you the result. */}
      <div
        className={`overflow-hidden [animation-fill-mode:forwards] ${touched ? running : ""}`}
        data-state={open ? "open" : "closed"}
        style={touched ? undefined : { height: open ? "3.5rem" : 0 }}
      >
        <div className="h-14 p-2 text-muted-foreground text-xs">
          Panel content
        </div>
      </div>
    </div>
  );
}

function AnimationPreview({
  kind,
  token,
}: Readonly<{ kind: "dot" | "track"; token: string }>) {
  if (kind === "track") {
    return (
      <div className="h-2 w-44 shrink-0 overflow-hidden rounded-full bg-muted">
        {/* A third of the track, the same proportion `Progress` uses, so the
            sheen reads as a sheen rather than as a filled bar. */}
        <div className={`h-full w-1/3 rounded-full bg-primary ${token}`} />
      </div>
    );
  }

  return <div className={`size-8 shrink-0 rounded-full bg-primary ${token}`} />;
}

/**
 * One named animation: the value the browser resolved, and a preview running
 * the real utility.
 *
 * The readout comes off an element carrying the utility rather than off
 * `:root`. These tokens are published through `@theme inline`, which inlines
 * each value into its utility instead of emitting a custom property, so asking
 * the root for `--animate-accordion-down` returns nothing even though the
 * declaration is sitting in globals.css. Reading the element answers the
 * question someone actually has: what does a component get when it writes this
 * class.
 */
function AnimationRow({
  kind,
  note,
  startOpen,
  token,
}: Readonly<{
  kind: "collapse" | "dot" | "track";
  note: string;
  startOpen: boolean;
  token: string;
}>) {
  const probe = useRef<HTMLSpanElement>(null);
  const animation = useComputedValue(probe, "animation");

  // Each accordion row opens in the state that makes ITS OWN half the next
  // thing you trigger: the opening row starts collapsed, the closing row starts
  // expanded. Press again and you get the other half, which is how they ship.
  const [open, setOpen] = useState(startOpen);
  const [touched, setTouched] = useState(false);

  return (
    <div className="flex flex-wrap items-center justify-between gap-4 p-4">
      <div className="min-w-0 space-y-0.5">
        <p className="font-mono text-xs">--{token}</p>
        <p className="font-mono text-muted-foreground text-xs">
          {animation || "not set"}
        </p>
        <p className="text-muted-foreground text-xs">{note}</p>
      </div>
      <TokenProbe probeRef={probe} token={token} />
      <div className="flex shrink-0 items-center gap-3">
        {kind === "collapse" ? (
          <button
            aria-expanded={open}
            className="rounded-md border bg-card px-3 py-1.5 font-medium text-xs transition-colors duration-150 hover:bg-muted"
            onClick={() => {
              setTouched(true);
              setOpen((wasOpen) => !wasOpen);
            }}
            type="button"
          >
            {open ? "Collapse" : "Expand"}
          </button>
        ) : null}
        {/* Runs the real utility. If the declaration changes in globals.css,
            this preview changes with it and the value beside it changes too. */}
        {kind === "collapse" ? (
          <AccordionPreview open={open} touched={touched} />
        ) : (
          <AnimationPreview kind={kind} token={token} />
        )}
      </div>
    </div>
  );
}

const AnimationTable = () => (
  <div className="divide-y rounded-lg border bg-card">
    {ANIMATION_TOKENS.map(({ note, preview, startOpen, token }) => (
      <AnimationRow
        key={token}
        kind={preview}
        note={note}
        startOpen={startOpen}
        token={token}
      />
    ))}
  </div>
);

const DurationPanel = () => {
  const [on, resetting, replay] = useReplay();
  const reduced = usePrefersReducedMotion();
  const viewRef = useReplayOnView(replay, !reduced);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <p className="text-muted-foreground text-sm">
          All five start on the same tick, so the gap between them is the thing
          you are comparing. Runs when you scroll to it.
        </p>
        <ReplayButton onClick={replay} />
      </div>
      <div className="divide-y rounded-lg border bg-card" ref={viewRef}>
        {DURATIONS.map(({ utility, when }) => (
          <TravelRow
            className={`ease-out ${utility}`}
            key={utility}
            label={utility}
            on={on}
            readout="duration"
            resetting={resetting}
            when={when}
          />
        ))}
      </div>
    </div>
  );
};

/**
 * Draws the easing curve from the value the browser resolved, rather than from
 * a hand-copied control point, so the picture cannot disagree with the motion
 * next to it. A keyword the browser reports as-is (`linear`) has no control
 * points to parse and falls back to the straight line it describes.
 */
function EasingCurve({ timing }: Readonly<{ timing: string }>) {
  const match = timing.match(CUBIC_BEZIER);
  const [x1, y1, x2, y2] = match
    ? [+match[1], +match[2], +match[3], +match[4]]
    : [0, 0, 1, 1];

  const S = 48;
  const px = (x: number) => x * S;
  const py = (y: number) => S - y * S;

  return (
    <svg
      aria-hidden="true"
      className="shrink-0 rounded border bg-muted"
      height={S}
      viewBox={`0 0 ${S} ${S}`}
      width={S}
    >
      <title>Easing curve</title>
      <path
        d={`M ${px(0)} ${py(0)} C ${px(x1)} ${py(y1)}, ${px(x2)} ${py(y2)}, ${px(1)} ${py(1)}`}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
    </svg>
  );
}

function EasingRow({
  on,
  resetting,
  utility,
  when,
}: Readonly<{
  on: boolean;
  resetting: boolean;
  utility: string;
  when: string;
}>) {
  const ref = useRef<HTMLDivElement>(null);
  const timing = useComputedValue(ref, "transition-timing-function");

  return (
    <div className="grid gap-3 p-4 sm:grid-cols-[12rem_1fr] sm:gap-6">
      <div className="flex items-start gap-3">
        <EasingCurve timing={timing} />
        <div className="min-w-0 space-y-0.5">
          <p className="font-mono text-xs">{utility}</p>
          <p className="break-all font-mono text-[11px] text-muted-foreground">
            {timing || "not set"}
          </p>
        </div>
      </div>
      <div className="space-y-2">
        <div className="h-8 w-72 max-w-full overflow-hidden rounded-md bg-muted p-1">
          <div
            className={`size-6 rounded-sm bg-primary transition-transform ${resetting ? "!duration-0" : "duration-500"} ${utility}`}
            ref={ref}
            // 16rem is the track's inner width (18rem, less the 0.5rem of
            // padding) minus the square's own 1.5rem, so "on" is the far edge
            // rather than a number picked to look about right.
            style={{
              transform: on ? "translateX(16rem)" : "translateX(0)",
            }}
          />
        </div>
        <p className="text-muted-foreground text-xs">{when}</p>
      </div>
    </div>
  );
}

const EasingPanel = () => {
  const [on, resetting, replay] = useReplay();
  const reduced = usePrefersReducedMotion();
  const viewRef = useReplayOnView(replay, !reduced);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <p className="text-muted-foreground text-sm">
          Every row runs for the same 500ms, so the only difference you are
          watching is the shape of the curve beside it. Runs when you scroll to
          it.
        </p>
        <ReplayButton onClick={replay} />
      </div>
      <div className="divide-y rounded-lg border bg-card" ref={viewRef}>
        {EASINGS.map(({ utility, when }) => (
          <EasingRow
            key={utility}
            on={on}
            resetting={resetting}
            utility={utility}
            when={when}
          />
        ))}
      </div>
    </div>
  );
};

/**
 * What a transition is allowed to animate. The property matters as much as the
 * duration: `transition-all` is the one to avoid, because it also animates
 * layout properties and turns a cheap repaint into a reflow on every frame.
 */
const TransitionDemo = () => (
  <div className="grid gap-3 sm:grid-cols-3">
    <div className="space-y-2 rounded-lg border bg-card p-4">
      <button
        className="w-full rounded-md bg-primary px-3 py-2 font-medium text-primary-foreground text-sm transition-colors duration-200 hover:bg-primary/80"
        type="button"
      >
        Hover me
      </button>
      <p className="font-mono text-xs">transition-colors</p>
      <p className="text-muted-foreground text-xs">
        Fill, text and border. The common case, and the cheapest.
      </p>
    </div>

    <div className="space-y-2 rounded-lg border bg-card p-4">
      <button
        className="w-full rounded-md bg-secondary px-3 py-2 font-medium text-secondary-foreground text-sm transition-transform duration-200 hover:scale-105"
        type="button"
      >
        Hover me
      </button>
      <p className="font-mono text-xs">transition-transform</p>
      <p className="text-muted-foreground text-xs">
        Move, scale, rotate. Runs on the compositor, so it stays smooth.
      </p>
    </div>

    <div className="space-y-2 rounded-lg border bg-card p-4">
      <button
        className="w-full rounded-md border px-3 py-2 font-medium text-sm opacity-100 transition-opacity duration-200 hover:opacity-40"
        type="button"
      >
        Hover me
      </button>
      <p className="font-mono text-xs">transition-opacity</p>
      <p className="text-muted-foreground text-xs">
        Fading something in or out without moving it.
      </p>
    </div>
  </div>
);

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
      note="How long a change takes. The system publishes no duration tokens of its own, so a component writes the Tailwind utility directly. These five are the ones in real use. Reach for 200 unless you have a reason."
      title="Duration"
    >
      <DurationPanel />
    </TokenSection>

    <TokenSection
      note="The rate of change across that duration. An easing carries meaning: out for arriving, in for leaving, linear only for something with no beginning or end."
      title="Easing"
    >
      <EasingPanel />
    </TokenSection>

    <TokenSection
      note="Name the property you are animating. transition-all is the one to avoid: it animates layout properties too, which turns a cheap repaint into a reflow on every frame."
      title="What transitions"
    >
      <TransitionDemo />
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

/**
 * Every named animation and the reduced motion behaviour it maps to, so you
 * reach for a token instead of picking your own duration and easing.
 */
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
