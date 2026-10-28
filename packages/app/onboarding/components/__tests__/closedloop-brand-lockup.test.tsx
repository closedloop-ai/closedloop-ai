import {
  ClosedloopBrandLockup,
  ClosedloopMark,
} from "@repo/app/onboarding/components/closedloop-brand-lockup";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

const WORDMARK = "Closedloop.ai";

describe("ClosedloopBrandLockup", () => {
  it("renders the mark and the wordmark together", () => {
    const { container } = render(<ClosedloopBrandLockup />);
    expect(screen.getByText(WORDMARK)).toBeTruthy();
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelectorAll("path")).toHaveLength(2);
    expect(container.innerHTML).toContain("#41A3FF");
  });
  it("puts the mark before the wordmark", () => {
    const { container } = render(<ClosedloopBrandLockup />);
    const kids = [...(container.firstElementChild?.children ?? [])];
    expect(kids[0]?.tagName.toLowerCase()).toBe("svg");
    expect(kids[1]?.textContent).toBe(WORDMARK);
  });
  it("still exports the bare mark for non-lockup callers", () => {
    const { container } = render(<ClosedloopMark />);
    expect(container.querySelector("svg")).toBeTruthy();
    expect(screen.queryByText(WORDMARK)).toBeNull();
  });
});
