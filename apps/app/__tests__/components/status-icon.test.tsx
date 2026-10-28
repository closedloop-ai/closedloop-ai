import { StatusIcon } from "@repo/design-system/components/ui/status-icon";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("StatusIcon", () => {
  it("renders without crashing for every known status", () => {
    const knownStatuses = [
      "backlog",
      "todo",
      "started",
      "in-progress",
      "in-review",
      "executed",
      "complete",
      "wont-do",
      "failed",
      "decorative",
    ] as const;

    for (const status of knownStatuses) {
      const { container } = render(<StatusIcon size={16} status={status} />);
      expect(container.querySelector("svg")).not.toBeNull();
    }
  });

  it("renders without crashing when status is an unknown string", () => {
    // A caller can pass an unrecognized status string at runtime; the
    // appearance fallback must handle it rather than render an empty/broken
    // icon. What it NAMES the mark is pinned in the design-system lane.
    const { container } = render(
      <StatusIcon
        size={16}
        status={"SOME_UNKNOWN_STATUS" as unknown as "backlog"}
      />
    );
    expect(container.querySelector("svg")).not.toBeNull();
  });
});
