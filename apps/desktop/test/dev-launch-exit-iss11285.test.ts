/**
 * ISS-11285: the build-step exit path when a child reports neither a code nor
 * a signal.
 */
import { describe, expect, it, vi } from "vitest";
import { handleBuildStepExit } from "../scripts/dev-launch-exit.mjs";

describe("handleBuildStepExit with no code and no signal", () => {
  it("exits the launcher with status 1 and does not resolve the step", () => {
    const exit = vi.fn();
    const resolve = vi.fn();

    handleBuildStepExit(null, null, { exit, resolve });

    expect(exit).toHaveBeenCalledWith(1);
    expect(resolve).not.toHaveBeenCalled();
  });
});
