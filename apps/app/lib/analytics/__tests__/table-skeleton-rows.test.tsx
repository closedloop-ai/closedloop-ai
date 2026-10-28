import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderTableSkeletonRows } from "../table-skeleton-rows";

describe("renderTableSkeletonRows", () => {
  it("renders rowCount rows, each with columnCount cells", () => {
    render(
      <table>
        <tbody>{renderTableSkeletonRows(3, 4)}</tbody>
      </table>
    );

    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.getAllByRole("cell")).toHaveLength(12);
  });

  it("renders no rows when rowCount is 0", () => {
    render(
      <table>
        <tbody>{renderTableSkeletonRows(0, 4)}</tbody>
      </table>
    );

    expect(screen.queryAllByRole("row")).toHaveLength(0);
  });
});
