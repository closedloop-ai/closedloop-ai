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
      "decorative",
    ] as const;

    for (const status of knownStatuses) {
      const { container } = render(<StatusIcon size={16} status={status} />);
      expect(container.querySelector("svg")).not.toBeNull();
    }
  });

  it("renders without crashing when status is an unknown string", () => {
    // A caller can pass an unrecognized status string at runtime; the default
    // case in getStatusConfig must handle this gracefully rather than render an
    // empty/broken icon.
    const { container } = render(
      <StatusIcon
        size={16}
        status={"SOME_UNKNOWN_STATUS" as unknown as "backlog"}
      />
    );
    expect(container.querySelector("svg")).not.toBeNull();
  });
});
