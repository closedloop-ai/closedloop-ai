import { ReadSource, readSourceValues } from "@repo/api/src/types/read-source";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReadSourceBadge } from "../read-source-badge";

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

  it("never mislabels a source — cloud rows never render a local badge", () => {
    render(<ReadSourceBadge readSource={ReadSource.Cloud} />);
    const badge = screen.getByTestId("read-source-badge");
    expect(badge).toHaveTextContent("Cloud");
    expect(badge).not.toHaveTextContent("Local");
    expect(badge).not.toHaveTextContent("Fallback");
  });
});
