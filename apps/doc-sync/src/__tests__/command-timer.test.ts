import { log } from "@repo/observability/log";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CommandName,
  commandTimer,
  DOC_SYNC_COMMAND_COMPLETED_EVENT,
} from "../commands/command-timer";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("commandTimer", () => {
  it("lets describe refine the outcome but never the event, command, name or duration", async () => {
    const infos = vi.spyOn(log, "info").mockImplementation(() => undefined);
    const ticks = [100, 130];
    const timed = commandTimer(() => ticks.shift() ?? 0);

    await timed(
      CommandName.Clear,
      "doc-a",
      () => Promise.resolve({ kind: "done" }),
      () => ({
        event: "clobbered",
        command: "clobbered",
        documentName: "clobbered",
        durationMs: -1,
        outcome: "refined",
        extra: 7,
      })
    );

    expect(infos).toHaveBeenCalledWith(expect.any(String), {
      event: DOC_SYNC_COMMAND_COMPLETED_EVENT,
      command: CommandName.Clear,
      documentName: "doc-a",
      durationMs: 30,
      outcome: "refined",
      extra: 7,
    });
  });
});
