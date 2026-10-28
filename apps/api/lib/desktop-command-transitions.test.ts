import type { JsonValue } from "@repo/api/src/types/common";
import {
  DesktopCommandStatus,
  isTerminalStatus,
} from "@repo/api/src/types/compute-target";
import { describe, expect, it } from "vitest";
import { resolveCommandUpdate } from "./desktop-command-transitions";

/**
 * The desktop command state machine (ISS-8133). Command events reach it from the direct
 * Socket.IO server, the relay socket-event route and the command ack handler, and a
 * `done`, `error` or terminal `result` event moves a command to Done / Cancelled /
 * Failed, stamps `finishedAt` and writes the `error` column. These cases pin that state
 * machine directly rather than through a mocked store, so every arm is covered by
 * something that can actually fail.
 */
describe("resolveCommandUpdate", () => {
  it.each([
    { status: DesktopCommandStatus.Queued },
    { status: DesktopCommandStatus.Accepted },
  ])("moves a $status command to Running on a chunk", ({ status }) => {
    const transition = resolveCommandUpdate({ status }, "chunk", {});

    expect(transition.status).toBe(DesktopCommandStatus.Running);
    expect(transition.startedAt).toBeInstanceOf(Date);
    expect(transition.finishedAt).toBeUndefined();
  });

  it("preserves an existing startedAt rather than restamping it", () => {
    const startedAt = new Date("2026-01-01T00:00:00.000Z");

    const transition = resolveCommandUpdate(
      { status: DesktopCommandStatus.Queued, startedAt },
      "chunk",
      {}
    );

    expect(transition.startedAt).toBe(startedAt);
  });

  it("finishes a running command on a done event", () => {
    const transition = resolveCommandUpdate(
      { status: DesktopCommandStatus.Running },
      "done",
      {}
    );

    expect(transition.status).toBe(DesktopCommandStatus.Done);
    expect(transition.finishedAt).toBeInstanceOf(Date);
  });

  it("cancels rather than completes when a done event carries cancelled", () => {
    const transition = resolveCommandUpdate(
      { status: DesktopCommandStatus.Running },
      "done",
      { cancelled: true }
    );

    expect(transition.status).toBe(DesktopCommandStatus.Cancelled);
  });

  it("fails a running command and writes the error on a terminal error event", () => {
    // The command ack handler writes a rejection as `{ error, terminal: true }`
    // (`desktop-command-ack-handler.ts`), the shape this case feeds in.
    const transition = resolveCommandUpdate(
      { status: DesktopCommandStatus.Running },
      "error",
      { error: "boom", terminal: true }
    );

    expect(transition.status).toBe(DesktopCommandStatus.Failed);
    expect(transition.error).toBe("boom");
    expect(transition.finishedAt).toBeInstanceOf(Date);
  });

  it("falls back to a generic message when a terminal error carries no string error", () => {
    const transition = resolveCommandUpdate(
      { status: DesktopCommandStatus.Running },
      "error",
      { error: 500, terminal: true }
    );

    expect(transition.error).toBe("Command failed");
  });

  it("does not finish the command on a non-terminal error event", () => {
    const transition = resolveCommandUpdate(
      { status: DesktopCommandStatus.Running },
      "error",
      { error: "recoverable" }
    );

    expect(transition.status).toBeUndefined();
    expect(transition.finishedAt).toBeUndefined();
  });

  it.each<{ name: string; data: JsonValue; expected: DesktopCommandStatus }>([
    {
      name: "completes",
      data: { terminal: true },
      expected: DesktopCommandStatus.Done,
    },
    {
      name: "cancels",
      data: { terminal: true, cancelled: true },
      expected: DesktopCommandStatus.Cancelled,
    },
  ])(
    "$name a running command on a terminal result event",
    ({ data, expected }) => {
      const transition = resolveCommandUpdate(
        { status: DesktopCommandStatus.Running },
        "result",
        data
      );

      expect(transition.status).toBe(expected);
    }
  );

  it.each(
    Object.values(DesktopCommandStatus)
      .filter((status) => isTerminalStatus(status))
      .map((status) => ({ status }))
  )("freezes a $status command against a later done event", ({ status }) => {
    // Derived from `isTerminalStatus` rather than a hand-written list, so a new terminal
    // status cannot be added without this case covering it.
    expect(resolveCommandUpdate({ status }, "done", {})).toEqual({});
  });
});
