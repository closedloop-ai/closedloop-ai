import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { projectDefaultGroupBy } from "../../lib/project-default-group-by";
import { useSyncProjectDefaultGroupBy } from "../use-project-default-group-by";

describe("projectDefaultGroupBy (ISS-13007)", () => {
  it("is the hierarchy tree with manual ordering and Status groups without", () => {
    expect(projectDefaultGroupBy(true)).toBe("none");
    expect(projectDefaultGroupBy(false)).toBe("status");
  });
});

describe("useSyncProjectDefaultGroupBy (ISS-13007)", () => {
  const render = (initial: {
    defaultGroupBy: string;
    groupBy: string;
    query: string;
  }) => {
    const setGroupBy = vi.fn();
    const view = renderHook(
      (props: typeof initial) =>
        useSyncProjectDefaultGroupBy(
          { groupBy: props.groupBy, setGroupBy },
          props.defaultGroupBy,
          props.query
        ),
      { initialProps: initial }
    );
    return { ...view, setGroupBy };
  };

  it("moves a group still on the old default to the new default", () => {
    const { rerender, setGroupBy } = render({
      defaultGroupBy: "status",
      groupBy: "status",
      query: "",
    });
    rerender({ defaultGroupBy: "none", groupBy: "status", query: "" });
    expect(setGroupBy).toHaveBeenCalledWith("none");
  });

  it("leaves a group the reader moved off the default alone", () => {
    const { rerender, setGroupBy } = render({
      defaultGroupBy: "status",
      groupBy: "owner",
      query: "",
    });
    rerender({ defaultGroupBy: "none", groupBy: "owner", query: "" });
    expect(setGroupBy).not.toHaveBeenCalled();
  });

  it("leaves an explicit group in the URL alone even when it equals the old default", () => {
    const { rerender, setGroupBy } = render({
      defaultGroupBy: "status",
      groupBy: "status",
      query: "group=status",
    });
    rerender({
      defaultGroupBy: "none",
      groupBy: "status",
      query: "group=status",
    });
    expect(setGroupBy).not.toHaveBeenCalled();
  });

  it("keeps a link's explicit group=status after the URL drops the param", () => {
    const { rerender, setGroupBy } = render({
      defaultGroupBy: "status",
      groupBy: "status",
      query: "group=status",
    });
    // The route state omits a group equal to the default once it is applied.
    rerender({ defaultGroupBy: "none", groupBy: "status", query: "" });
    expect(setGroupBy).not.toHaveBeenCalled();
  });

  it("does nothing while the default has not changed", () => {
    const { rerender, setGroupBy } = render({
      defaultGroupBy: "none",
      groupBy: "none",
      query: "",
    });
    rerender({ defaultGroupBy: "none", groupBy: "none", query: "" });
    expect(setGroupBy).not.toHaveBeenCalled();
  });
});
