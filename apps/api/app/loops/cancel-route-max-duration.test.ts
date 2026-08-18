/**
 * ISS-6046: both cancel entry points await a desktop kill that replays a
 * not-delivered answer, so each must declare the ceiling that dispatch needs
 * rather than inherit the platform default. A route terminated mid-replay never
 * reaches `loopsService.cancel`, so the loop stays RUNNING with no `cancelled`
 * event and the caller gets a 504 instead of the route's own answer.
 *
 * Route-segment config must be a static literal, so the routes write the number
 * and this pins it to the constant that carries the reasoning.
 */

import { describe, expect, it } from "vitest";
import { maxDuration as cancelLoopMaxDuration } from "./[id]/cancel/route";
import { maxDuration as deleteLoopMaxDuration } from "./[id]/route";
import { CANCEL_REQUEST_BUDGET_SECONDS } from "./desktop-cancel";

describe("cancel routes declare the kill dispatch ceiling", () => {
  it("POST /loops/[id]/cancel runs under the cancel request budget", () => {
    expect(cancelLoopMaxDuration).toBe(CANCEL_REQUEST_BUDGET_SECONDS);
  });

  it("DELETE /loops/[id] runs under the same budget", () => {
    expect(deleteLoopMaxDuration).toBe(CANCEL_REQUEST_BUDGET_SECONDS);
  });
});
