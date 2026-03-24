import { LoopStatus } from "@repo/api/src/types/loop";
import { describe, expect, it } from "vitest";
import {
  CANCELLABLE_LOOP_STATUSES,
  RESTARTABLE_LOOP_STATUSES,
} from "@/lib/loop-constants";

describe("RESTARTABLE_LOOP_STATUSES", () => {
  it("contains Failed", () => {
    expect(RESTARTABLE_LOOP_STATUSES.has(LoopStatus.Failed)).toBe(true);
  });

  it("contains TimedOut", () => {
    expect(RESTARTABLE_LOOP_STATUSES.has(LoopStatus.TimedOut)).toBe(true);
  });

  it("does not contain Completed", () => {
    expect(RESTARTABLE_LOOP_STATUSES.has(LoopStatus.Completed)).toBe(false);
  });

  it("does not contain Pending", () => {
    expect(RESTARTABLE_LOOP_STATUSES.has(LoopStatus.Pending)).toBe(false);
  });

  it("does not contain Running", () => {
    expect(RESTARTABLE_LOOP_STATUSES.has(LoopStatus.Running)).toBe(false);
  });

  it("contains Cancelled", () => {
    expect(RESTARTABLE_LOOP_STATUSES.has(LoopStatus.Cancelled)).toBe(true);
  });

  it("does not contain Claimed", () => {
    expect(RESTARTABLE_LOOP_STATUSES.has(LoopStatus.Claimed)).toBe(false);
  });

  it("has exactly three members", () => {
    expect(RESTARTABLE_LOOP_STATUSES.size).toBe(3);
  });
});

describe("CANCELLABLE_LOOP_STATUSES", () => {
  it("contains Pending", () => {
    expect(CANCELLABLE_LOOP_STATUSES.has(LoopStatus.Pending)).toBe(true);
  });

  it("contains Claimed", () => {
    expect(CANCELLABLE_LOOP_STATUSES.has(LoopStatus.Claimed)).toBe(true);
  });

  it("contains Running", () => {
    expect(CANCELLABLE_LOOP_STATUSES.has(LoopStatus.Running)).toBe(true);
  });

  it("does not contain Completed", () => {
    expect(CANCELLABLE_LOOP_STATUSES.has(LoopStatus.Completed)).toBe(false);
  });

  it("does not contain Failed", () => {
    expect(CANCELLABLE_LOOP_STATUSES.has(LoopStatus.Failed)).toBe(false);
  });

  it("does not contain Cancelled", () => {
    expect(CANCELLABLE_LOOP_STATUSES.has(LoopStatus.Cancelled)).toBe(false);
  });

  it("does not contain TimedOut", () => {
    expect(CANCELLABLE_LOOP_STATUSES.has(LoopStatus.TimedOut)).toBe(false);
  });

  it("has exactly three members", () => {
    expect(CANCELLABLE_LOOP_STATUSES.size).toBe(3);
  });
});
