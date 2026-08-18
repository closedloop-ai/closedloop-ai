import {
  cloneElement,
  type HTMLAttributes,
  isValidElement,
  type ReactNode,
} from "react";

/**
 * Shared `vi.mock` factory for `@repo/design-system/components/ui/tooltip`.
 *
 * The styled sd3 tooltip renders its content through a Radix portal that never
 * mounts in jsdom, so unit tests can't read the tooltip text or keep the
 * trigger's classes. This module replaces the tooltip with a transparent
 * pass-through: `TooltipTrigger` forwards its props onto its child (tagging it
 * `data-slot="tooltip-trigger"`) and `TooltipContent` renders inline under
 * `data-testid="tooltip-content"`, so both are inspectable in the DOM.
 *
 * There are two entry points, both backed by the same builder so the mocking
 * strategy lives in one place:
 *
 *   • {@link tooltipMockModule} — the ready-made module object, for the common
 *     case (every trigger wraps a real element, e.g. a `Chip`):
 *
 *     ```ts
 *     vi.mock(
 *       "@repo/design-system/components/ui/tooltip",
 *       () => tooltipMockModule
 *     );
 *     ```
 *
 *   • {@link mockTooltipModule} — the parameterised factory, when a trigger can
 *     wrap plain text rather than an element (the agents-table name lead's
 *     no-href path renders a native `<button>` trigger, and its test asserts the
 *     trigger is a focusable `BUTTON`, not a `<span>`):
 *
 *     ```ts
 *     vi.mock(
 *       "@repo/design-system/components/ui/tooltip",
 *       () => mockTooltipModule()
 *     );
 *     ```
 */

type MockTooltipOptions = {
  /**
   * How a `TooltipTrigger` whose child is NOT an element (plain text) renders.
   * The real Radix trigger renders a keyboard-focusable native `<button>` in
   * that case, so the default `"button"` keeps focusability-dependent
   * assertions meaningful. `"span"` is the legacy pass-through shape retained
   * for tests that only inspect classes/text.
   */
  textTrigger?: "button" | "span";
};

function buildTooltipModule({
  textTrigger = "button",
}: MockTooltipOptions = {}) {
  return {
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipTrigger: ({
      children,
      asChild: _asChild,
      ...props
    }: {
      children: ReactNode;
      asChild?: boolean;
    } & HTMLAttributes<HTMLElement>) => {
      const triggerProps = { ...props, "data-slot": "tooltip-trigger" };
      if (isValidElement(children)) {
        // `asChild` case: clone the caller's own element (anchor/chip),
        // preserving its type and truncation classes.
        return cloneElement(children, triggerProps);
      }
      if (textTrigger === "button") {
        // Non-`asChild` case: the real Radix trigger renders a native <button>,
        // keyboard-focusable by default. Render a real <button> (not a <span>)
        // so focusability-dependent assertions stay meaningful.
        return (
          <button {...(triggerProps as Record<string, unknown>)} type="button">
            {children}
          </button>
        );
      }
      return <span {...triggerProps}>{children}</span>;
    },
    TooltipContent: ({ children }: { children: ReactNode }) => (
      <div data-testid="tooltip-content">{children}</div>
    ),
  };
}

/**
 * Ready-made mock module object. Use directly in a hoisted `vi.mock` call when
 * every tooltip trigger wraps a real element (the common table-chip case).
 */
export const tooltipMockModule = buildTooltipModule();

/**
 * Parameterised mock-module factory. Call from the hoisted `vi.mock` factory
 * when a trigger can wrap plain text and the test needs the native focusable
 * `<button>` shape (default) — or pass `{ textTrigger: "span" }` for the legacy
 * pass-through.
 */
export function mockTooltipModule(options: MockTooltipOptions = {}) {
  return buildTooltipModule(options);
}
