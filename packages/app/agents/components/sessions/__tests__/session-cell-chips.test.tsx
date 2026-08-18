import { tooltipMockModule } from "@repo/app/test/mocks/tooltip";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  SESSION_AUTONOMY_CHIP_TEST_ID,
  SESSION_HARNESS_CHIP_TEST_ID,
  SESSION_MODEL_CHIP_TEST_ID,
  SessionAutonomyChip,
  SessionHarnessChip,
  SessionModelChip,
} from "../session-cell-chips";
import { createSessionTableRowFixture } from "../session-list-fixtures";
import { SessionsTable } from "../sessions-table";

vi.mock("@repo/design-system/components/ui/tooltip", () => tooltipMockModule);

/**
 * ISS-6005: the Harness / Model / Autonomy treatments, per the prototype
 * (`session-cells.tsx` is the SoT; the operator confirmed the pills directly).
 * CONTENT assertions — labels and tooltip sentences — so reverting the content
 * mapping produces named failures here, per-scope.
 */
describe("SessionHarnessChip", () => {
  it("renders the harness display name as the pill's whole content", () => {
    render(<SessionHarnessChip harness="claude" />);
    const chip = screen.getByTestId(SESSION_HARNESS_CHIP_TEST_ID);
    expect(chip).toHaveTextContent("Claude");
    // Name only — no dot, no icon (the prototype's neutral pill).
    expect(chip.querySelector("svg")).toBeNull();
    expect(chip.querySelector("span.rounded-full")).toBeNull();
  });

  it("degrades an unknown harness to its raw string rather than fabricating a label", () => {
    render(<SessionHarnessChip harness="some-new-harness" />);
    expect(screen.getByTestId(SESSION_HARNESS_CHIP_TEST_ID)).toHaveTextContent(
      "some-new-harness"
    );
  });

  it("truncates rather than hard-clipping a long unknown harness", () => {
    // `Chip` is overflow-hidden/whitespace-nowrap, so without an explicitly
    // truncating inner span a raw-string fallback is cut flush against the
    // rounded edge inside the 124px track, with no ellipsis to say it was cut.
    render(
      <SessionHarnessChip harness="a-very-long-unrecognized-harness-id" />
    );
    const label = screen
      .getByTestId(SESSION_HARNESS_CHIP_TEST_ID)
      .querySelector("span");
    expect(label?.className).toContain("truncate");
  });

  it("stays out of the tab order — it carries no tooltip to reach", () => {
    // The counterpart of the two focusable chips below. A pill with nothing to
    // explain must not add a tab stop per row; only Model and Autonomy earn one.
    render(<SessionHarnessChip harness="claude" />);
    expect(
      screen.getByTestId(SESSION_HARNESS_CHIP_TEST_ID).getAttribute("tabindex")
    ).toBeNull();
  });
});

describe("SessionModelChip", () => {
  it("labels with the model id and explains provider · model in the tooltip", () => {
    render(<SessionModelChip model="claude-opus-4-8" />);
    expect(screen.getByTestId(SESSION_MODEL_CHIP_TEST_ID)).toHaveTextContent(
      "claude-opus-4-8"
    );
    expect(screen.getByTestId("tooltip-content")).toHaveTextContent(
      "Anthropic · claude-opus-4-8"
    );
  });

  it.each([
    ["claude-sonnet-5", "Anthropic", "text-primary"],
    ["gpt-5.5", "OpenAI", "text-success"],
    ["gemini-3-pro", "Google", "text-info"],
    // The unattributable bucket reads `Model`, the prototype's word — NOT
    // `providerOf`'s `Other` enum member, which is grouping vocabulary that
    // tells a user nothing in a tooltip.
    ["unknown-model-2026", "Model", "text-muted-foreground"],
  ])("attributes %s to %s with the matching dot token", (model, provider, dotToken) => {
    render(<SessionModelChip model={model} />);
    expect(screen.getByTestId("tooltip-content")).toHaveTextContent(
      `${provider} · ${model}`
    );
    // The dot is a decorative, provider-toned enhancer: hidden from AT (the
    // id text carries the information — WCAG 1.4.1) and colored via a design
    // token, never a hardcoded hex.
    const dot = screen
      .getByTestId(SESSION_MODEL_CHIP_TEST_ID)
      .querySelector("span[aria-hidden]");
    expect(dot).not.toBeNull();
    expect(dot?.className).toContain(dotToken);
  });
});

/**
 * Keyboard reachability is the whole reason these chips keep production's Radix
 * scaffold instead of the prototype's `title=` — a native `title` is not
 * keyboard-reachable. The tooltip module is mocked here (so content is
 * assertable without Radix's open delay), which means the OPEN behaviour is
 * proven end-to-end by `e2e/sessions-listing-parity.spec.ts` focusing the real
 * chip against real Radix. What is proven here is the half the mock cannot
 * hide: that the two explaining chips are in the tab order at all.
 */
describe("tooltip triggers are keyboard-reachable", () => {
  it.each([
    [SESSION_MODEL_CHIP_TEST_ID, <SessionModelChip key="m" model="gpt-5.5" />],
    [
      SESSION_AUTONOMY_CHIP_TEST_ID,
      <SessionAutonomyChip autonomy={84} key="a" />,
    ],
  ])("%s is focusable", (testId, element) => {
    render(element);
    expect(screen.getByTestId(testId).getAttribute("tabindex")).toBe("0");
  });
});

describe("SessionAutonomyChip", () => {
  it.each([
    [84, "High"],
    [50, "Mixed"],
    [12, "Guided"],
  ])("renders score %i as the %s tier pill, score tooltip-only", (score, tier) => {
    render(<SessionAutonomyChip autonomy={score} />);
    const chip = screen.getByTestId(SESSION_AUTONOMY_CHIP_TEST_ID);
    // The tier WORD is the cell content; the numeric score renders nowhere in
    // the cell (the prototype's call — it lives in the tooltip only).
    expect(chip).toHaveTextContent(tier);
    expect(chip.textContent).not.toContain(String(score));
    expect(screen.getByTestId("tooltip-content")).toHaveTextContent(
      `Autonomy score ${score} of 100`
    );
  });
});

/**
 * Production wiring: the presentational table's harness/model/autonomy cells
 * actually invoke these components — deleting a call site in
 * `renderSessionCell` fails here, not just in the unit blocks above.
 */
describe("SessionsTable cell wiring (ISS-6005 treatments)", () => {
  it("renders the three pills from a full row, with the score absent from the grid", () => {
    const row = createSessionTableRowFixture({
      autonomy: 84,
      harness: "codex",
      model: "gpt-5.5",
    });
    render(
      <SessionsTable
        items={[row]}
        mode="expanded"
        renderName={(item, className) => (
          <span className={className}>{item.name}</span>
        )}
      />
    );

    expect(screen.getByTestId(SESSION_HARNESS_CHIP_TEST_ID)).toHaveTextContent(
      "Codex"
    );
    const modelChip = screen.getByTestId(SESSION_MODEL_CHIP_TEST_ID);
    expect(modelChip).toHaveTextContent("gpt-5.5");
    const autonomyChip = screen.getByTestId(SESSION_AUTONOMY_CHIP_TEST_ID);
    expect(autonomyChip).toHaveTextContent("High");
    expect(
      within(autonomyChip.parentElement as HTMLElement).queryByText("84")
    ).toBeNull();
  });
});
