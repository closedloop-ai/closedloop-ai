import { TooltipProvider } from "@repo/design-system/components/ui/tooltip";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Collaborators } from "../collaborators";

describe("Collaborators avatar stack", () => {
  it("keeps each initial clear of the next avatar's ring", () => {
    render(
      <TooltipProvider>
        <Collaborators
          people={[
            { key: "dana", name: "Dana Reyes" },
            { key: "priya", name: "Priya Shah" },
          ]}
        />
      </TooltipProvider>
    );

    const stack = screen.getByRole("img", { name: "Dana Reyes, Priya Shah" });
    expect(stack).toHaveClass("-space-x-0.5");
    // One initial on every avatar (Nerys, 2026-10-22).
    expect(screen.getByText("D")).toBeInTheDocument();
    expect(screen.getByText("P")).toBeInTheDocument();
    expect(stack.querySelectorAll(".ring-2")).toHaveLength(2);
  });
});
