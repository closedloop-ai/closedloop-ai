import { ReadSource, readSourceValues } from "@repo/api/src/types/read-source";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { describeReadSource, ReadSourceBadge } from "../read-source-badge";

describe("ReadSourceBadge", () => {
  it("renders the correct label + data-source for each source", () => {
    const expectations: Record<ReadSource, string> = {
      [ReadSource.Local]: "Local",
      [ReadSource.Cloud]: "Cloud",
      [ReadSource.Fallback]: "Fallback",
    };

    // Exhaustiveness: every ReadSource is exercised — a new source that lacks a
    // label falls out of this loop and the map above stops compiling.
    for (const source of readSourceValues) {
      const { unmount } = render(<ReadSourceBadge readSource={source} />);
      const badge = screen.getByTestId("read-source-badge");
      expect(badge).toHaveTextContent(expectations[source]);
      expect(badge).toHaveAttribute("data-read-source", source);
      unmount();
    }
  });

  it("renders nothing for an unknown (undefined) source instead of guessing", () => {
    render(<ReadSourceBadge readSource={undefined} />);
    expect(screen.queryByTestId("read-source-badge")).toBeNull();
  });

  it("marks a known-incomplete cloud read as visibly distinct, not a calm blue Cloud", () => {
    const { unmount } = render(
      <ReadSourceBadge readSource={ReadSource.Cloud} />
    );
    const drained = screen.getByTestId("read-source-badge");
    const drainedTone = drained.className;
    expect(drained.textContent).toBe("Cloud");
    expect(drained.getAttribute("data-read-source-incomplete")).toBeNull();
    unmount();

    render(<ReadSourceBadge incomplete readSource={ReadSource.Cloud} />);
    const short = screen.getByTestId("read-source-badge");
    // Still a cloud read (provenance is unchanged) but it must not look
    // identical to the drained one with the whole difference inside a tooltip.
    expect(short.getAttribute("data-read-source")).toBe(ReadSource.Cloud);
    expect(short.getAttribute("data-read-source-incomplete")).toBe("true");
    expect(short.textContent).toContain("partial");
    expect(short.className).not.toBe(drainedTone);
  });

  it("never mislabels a source — cloud rows never render a local badge", () => {
    render(<ReadSourceBadge readSource={ReadSource.Cloud} />);
    const badge = screen.getByTestId("read-source-badge");
    expect(badge).toHaveTextContent("Cloud");
    expect(badge).not.toHaveTextContent("Local");
    expect(badge).not.toHaveTextContent("Fallback");
  });

  /**
   * ISS-5714: the tooltip shipped our defect-routing vocabulary to customers —
   * "a wrong value here is a backend/projection bug, not a local data bug". It
   * hands a reader triage categories that only mean something to us, and it
   * pre-emptively tells them the number might be wrong in the very panel that
   * exists to explain the number.
   *
   * The ticket asked for a prohibition, not just a rewrite. A repo-wide gate
   * over every user-facing string needs its own scoping design (see the ticket);
   * this is the same ratchet applied where the defect actually shipped, so the
   * sentence cannot come back to THIS surface unobserved.
   */
  const ENGINEERING_INTERNAL_TERMS = [
    "bug",
    "backend",
    "projection",
    "collector",
    "sync gap",
    "local data",
  ];

  it("never narrates our internal fault taxonomy to a user", () => {
    for (const source of readSourceValues) {
      const copy = describeReadSource(source).toLowerCase();
      for (const term of ENGINEERING_INTERNAL_TERMS) {
        expect(copy).not.toContain(term);
      }
      // Not vacuous: the copy still has to say something about the store.
      expect(copy.length).toBeGreaterThan(20);
    }
  });

  it("scopes the sentence to the surface noun the toolbar passes", () => {
    expect(describeReadSource(ReadSource.Local, "sessions")).toBe(
      `Sessions: ${describeReadSource(ReadSource.Local)}`
    );
  });

  /**
   * Wiring only. This dispatches a synthetic focus event to open the Radix
   * tooltip; it is NOT evidence that a keyboard user can reach it. `Badge`
   * renders a plain `<span>` with no `tabIndex`, so this badge's tooltip is
   * hover-only today — a pre-existing gap (`KpiDeltaPlaceholder` solved the same
   * problem with a real `<button>`), tracked on ISS-5714 rather than fixed here.
   * Do not read this test as a11y coverage.
   */
  it("renders that same sentence in the tooltip it is written for", async () => {
    render(<ReadSourceBadge readSource={ReadSource.Cloud} />);
    fireEvent.focus(screen.getByTestId("read-source-badge"));
    const tooltip = await screen.findAllByText(
      describeReadSource(ReadSource.Cloud)
    );
    expect(tooltip.length).toBeGreaterThan(0);
  });
});
