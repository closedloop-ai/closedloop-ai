import {
  GITHUB_RESYNC_NUDGE_METHOD,
  GITHUB_RESYNC_NUDGE_OPERATION_ID,
  GITHUB_RESYNC_NUDGE_PATH,
} from "@repo/api/src/types/github-dirty-scope";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  admitInboundCloudCommand,
  type CloudCommandAdmissionDeps,
} from "../src/main/cloud/cloud-command-admission.js";
import type { DesktopCommandEvent } from "../src/main/cloud/cloud-protocol.js";
import { PROTOCOL_VERSION } from "../src/main/cloud/cloud-protocol.js";
import { COMMAND_ACK_REJECTION_REASONS } from "../src/shared/ack-reasons.js";

/**
 * ISS-7486 (#5723) noted that the reject reasons this path emits were the ones
 * its parity test could not reach: they were inline literals inside the
 * `onCommand` callback in `DesktopApplication`'s constructor, with no callable
 * entry point. Now that admission is its own module, each rejection and each
 * reserved route is exercised directly.
 */

/** A dispatchable command: a real operation path that `resolveOperationId` accepts. */
const DISPATCHABLE_PATH = "/api/gateway/git/local-changes";

function makeCommand(
  overrides: Partial<DesktopCommandEvent> = {}
): DesktopCommandEvent {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: "message-1",
    timestamp: "2026-08-23T00:00:00.000Z",
    commandId: "command-1",
    operationId: "git_local_changes",
    method: "POST",
    path: DISPATCHABLE_PATH,
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<CloudCommandAdmissionDeps> = {}
): CloudCommandAdmissionDeps {
  return {
    sendCommandAck: vi.fn(),
    handleGitHubResyncNudgeCommand: vi.fn(),
    isDesktopSetupComplete: vi.fn(() => true),
    areCloudCommandsPaused: vi.fn(() => false),
    enqueue: vi.fn(),
    ...overrides,
  };
}

describe("admitInboundCloudCommand", () => {
  let deps: CloudCommandAdmissionDeps;

  beforeEach(() => {
    deps = makeDeps();
  });

  it("enqueues an ordinary command and acks nothing", () => {
    admitInboundCloudCommand(makeCommand(), deps);

    expect(deps.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ commandId: "command-1" })
    );
    expect(deps.sendCommandAck).not.toHaveBeenCalled();
  });

  describe("reserved commands are routed, not enqueued", () => {
    const reserved = [
      {
        label: "github resync nudge",
        command: {
          operationId: GITHUB_RESYNC_NUDGE_OPERATION_ID,
          path: GITHUB_RESYNC_NUDGE_PATH,
          method: GITHUB_RESYNC_NUDGE_METHOD,
        },
        handler: "handleGitHubResyncNudgeCommand",
      },
    ] as const;

    it.each(reserved)(
      "$label reaches its handler",
      ({ command, handler }: (typeof reserved)[number]) => {
        admitInboundCloudCommand(
          makeCommand(command as Partial<DesktopCommandEvent>),
          deps
        );

        expect(deps[handler]).toHaveBeenCalledTimes(1);
        expect(deps.enqueue).not.toHaveBeenCalled();
        expect(deps.sendCommandAck).not.toHaveBeenCalled();
      }
    );

    it.each(reserved)(
      "$label with the wrong method is rejected as unroutable",
      ({ command, handler }: (typeof reserved)[number]) => {
        // Same operationId/path, wrong verb — the classifier's "mismatch" arm.
        admitInboundCloudCommand(
          makeCommand({
            ...(command as Partial<DesktopCommandEvent>),
            method: "GET",
          }),
          deps
        );

        expect(deps[handler]).not.toHaveBeenCalled();
        expect(deps.enqueue).not.toHaveBeenCalled();
        expect(deps.sendCommandAck).toHaveBeenCalledWith({
          commandId: "command-1",
          accepted: false,
          state: "failed",
          reason: COMMAND_ACK_REJECTION_REASONS.unroutableOperation,
        });
      }
    );
  });

  it("rejects with onboardingIncomplete when setup is not finished", () => {
    const acked = makeDeps({ isDesktopSetupComplete: vi.fn(() => false) });

    admitInboundCloudCommand(makeCommand(), acked);

    expect(acked.sendCommandAck).toHaveBeenCalledWith({
      commandId: "command-1",
      accepted: false,
      state: "failed",
      reason: COMMAND_ACK_REJECTION_REASONS.onboardingIncomplete,
    });
    expect(acked.enqueue).not.toHaveBeenCalled();
  });

  it("rejects an unknown path as unroutable", () => {
    admitInboundCloudCommand(
      makeCommand({ operationId: "not_an_operation", path: "/nope" }),
      deps
    );

    expect(deps.sendCommandAck).toHaveBeenCalledWith({
      commandId: "command-1",
      accepted: false,
      state: "failed",
      reason: COMMAND_ACK_REJECTION_REASONS.unroutableOperation,
    });
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it("rejects a retired update_and_restart command from an older server as unroutable", () => {
    // ISS-12784 (R3): current and older servers can still dispatch it; the
    // server already folds this reason, so the ack must not change shape.
    admitInboundCloudCommand(
      makeCommand({
        operationId: "update_and_restart",
        method: "POST",
        path: "/api/gateway/update-and-restart",
      }),
      deps
    );

    expect(deps.sendCommandAck).toHaveBeenCalledWith({
      commandId: "command-1",
      accepted: false,
      state: "failed",
      reason: COMMAND_ACK_REJECTION_REASONS.unroutableOperation,
    });
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  /**
   * ISS-12784: browser command signing was removed. Current and older servers
   * can still dispatch these two reserved commands; the wire shapes are the
   * server's, written as literals because this Desktop no longer owns them.
   */
  const retiredBrowserKeyCommands = [
    {
      operationId: "browser_key_revoke",
      method: "POST",
      path: "/api/gateway/internal/browser-key/revoke",
    },
    {
      operationId: "browser_key_approval_request",
      method: "POST",
      path: "/api/gateway/internal/browser-key/approval-request",
    },
  ] as const;

  it.each(retiredBrowserKeyCommands)(
    "rejects a retired $operationId command from an older server as unroutable",
    (command) => {
      admitInboundCloudCommand(
        makeCommand({
          ...command,
          body: {
            fingerprint: "SHA256:abc",
            computeTargetId: "00000000-0000-4000-8000-000000000001",
          },
        }),
        deps
      );

      expect(deps.sendCommandAck).toHaveBeenCalledWith({
        commandId: "command-1",
        accepted: false,
        state: "failed",
        reason: COMMAND_ACK_REJECTION_REASONS.unroutableOperation,
      });
      expect(deps.enqueue).not.toHaveBeenCalled();
    }
  );

  it("rejects with commandsPaused when the pause gate is closed", () => {
    const paused = makeDeps({ areCloudCommandsPaused: vi.fn(() => true) });

    admitInboundCloudCommand(makeCommand(), paused);

    expect(paused.sendCommandAck).toHaveBeenCalledWith({
      commandId: "command-1",
      accepted: false,
      state: "failed",
      reason: COMMAND_ACK_REJECTION_REASONS.commandsPaused,
    });
    expect(paused.enqueue).not.toHaveBeenCalled();
  });

  it("checks setup completeness before the pause gate", () => {
    // Both gates closed: the earlier one must own the reason, otherwise a
    // reordering would silently relabel every rejection during onboarding.
    const bothClosed = makeDeps({
      isDesktopSetupComplete: vi.fn(() => false),
      areCloudCommandsPaused: vi.fn(() => true),
    });

    admitInboundCloudCommand(makeCommand(), bothClosed);

    expect(bothClosed.sendCommandAck).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: COMMAND_ACK_REJECTION_REASONS.onboardingIncomplete,
      })
    );
  });
});
