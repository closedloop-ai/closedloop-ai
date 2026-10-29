import { DesktopCommandStatus } from "@repo/api/src/types/compute-target";
import { describe, expect, it } from "vitest";
import {
  IN_FLIGHT_DESKTOP_COMMAND_STATUSES,
  TERMINAL_DESKTOP_COMMAND_STATUSES,
} from "@/lib/desktop-command-mappers";

/**
 * `IN_FLIGHT_DESKTOP_COMMAND_STATUSES` and `TERMINAL_DESKTOP_COMMAND_STATUSES`
 * are both derived from one exhaustive `Record<DesktopCommandStatus, boolean>`,
 * so `tsc` already forces a new status to be classified. This pins the other
 * half: that the classification is then USED, and the two derived sets plus
 * `queued` still partition the union. Add a status and drop it from the record's
 * consumers and this fails, where a hand-written `[accepted, running]` literal
 * would have compiled and silently excluded it from every in-flight read, count,
 * and requeue.
 */
describe("desktop command status partition", () => {
  it("partitions every status into in-flight, terminal, or queued", () => {
    const partitioned = [
      ...IN_FLIGHT_DESKTOP_COMMAND_STATUSES,
      ...TERMINAL_DESKTOP_COMMAND_STATUSES,
      DesktopCommandStatus.Queued,
    ].sort();

    expect(partitioned).toEqual(Object.values(DesktopCommandStatus).sort());
  });

  it("keeps queued out of the in-flight set", () => {
    expect(IN_FLIGHT_DESKTOP_COMMAND_STATUSES).not.toContain(
      DesktopCommandStatus.Queued
    );
  });
});
