import { DesktopCommandStatus } from "@repo/api/src/types/compute-target";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { desktopCommandStore } from "@/lib/desktop-command-store";

/**
 * DB-backed coverage for the Desktop command store. Real Postgres via `withDb`
 * (self-skips when DATABASE_URL is unset), each case in an auto-rollback
 * transaction — the corpus pattern for service code, and the only way to reach
 * this module's idempotency and lifecycle branches, which are decided by unique
 * constraints and stored rows rather than by pure logic.
 *
 * The three clusters here are the ones that were uncovered: the relay-payload
 * mapping (every field is a `typeof` guard with a fallback), the event→status
 * resolution (which decides when a command becomes Running/Done/Failed/
 * Cancelled and when it must NOT move), and the idempotency paths.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

async function seedComputeTarget(): Promise<string> {
  const organizationId = await createTestOrganization();
  const user = await createTestUser(organizationId);
  const target = await withDb((db) =>
    db.computeTarget.create({
      data: {
        organizationId,
        userId: user.id,
        machineName: "test-desktop",
        platform: "darwin",
      },
    })
  );
  return target.id;
}

const relayOperation = (params: unknown, streaming?: boolean) =>
  ({
    operationId: "health_check",
    params,
    ...(streaming === undefined ? {} : { streaming }),
  }) as Parameters<typeof desktopCommandStore.createFromRelayOperation>[1];

describeIfDb("desktopCommandStore — relay payload mapping", () => {
  it("falls back to safe defaults when params and request are not records", async () => {
    await autoRollbackTransaction(async () => {
      const targetId = await seedComputeTarget();

      const { command } = await desktopCommandStore.createFromRelayOperation(
        targetId,
        relayOperation("not-an-object")
      );

      // A malformed relay payload must still produce a well-formed command
      // rather than throwing at the boundary.
      expect(command.requestPayload.method).toBe("POST");
      expect(command.requestPayload.path).toBe("/api/gateway");
      expect(command.requestPayload.headers).toEqual({});
      expect(command.requestPayload.body).toBeNull();
    });
  });

  it("keeps a supported method and rewrites an unsupported one to POST", async () => {
    await autoRollbackTransaction(async () => {
      const targetId = await seedComputeTarget();

      const kept = await desktopCommandStore.createFromRelayOperation(
        targetId,
        relayOperation({
          request: { method: "DELETE", path: "/api/gateway/x" },
        })
      );
      const rewritten = await desktopCommandStore.createFromRelayOperation(
        targetId,
        relayOperation({ request: { method: "TRACE", path: "/api/gateway/y" } })
      );

      expect(kept.command.requestPayload.method).toBe("DELETE");
      expect(rewritten.command.requestPayload.method).toBe("POST");
    });
  });

  it("drops header entries whose value is not a string", async () => {
    await autoRollbackTransaction(async () => {
      const targetId = await seedComputeTarget();

      const { command } = await desktopCommandStore.createFromRelayOperation(
        targetId,
        relayOperation({
          request: {
            path: "/api/gateway/x",
            headers: { keep: "yes", drop: 42, alsoDrop: null },
          },
        })
      );

      expect(command.requestPayload.headers).toEqual({ keep: "yes" });
    });
  });

  it("drops optional params whose type is wrong and keeps well-typed ones", async () => {
    await autoRollbackTransaction(async () => {
      const targetId = await seedComputeTarget();

      const bad = await desktopCommandStore.createFromRelayOperation(
        targetId,
        relayOperation({
          request: { path: "/api/gateway/a" },
          timeoutMs: "soon",
          lockKey: 7,
          requiresApproval: "yes",
          approvalReason: 42,
        })
      );
      const good = await desktopCommandStore.createFromRelayOperation(
        targetId,
        relayOperation({
          request: { path: "/api/gateway/b" },
          timeoutMs: 5000,
          lockKey: "repo:acme/web",
          requiresApproval: true,
          approvalReason: "destructive",
        })
      );

      expect(bad.command.requestPayload.timeoutMs).toBeUndefined();
      expect(bad.command.requestPayload.lockKey).toBeUndefined();
      expect(bad.command.requestPayload.requiresApproval).toBeUndefined();
      expect(bad.command.requestPayload.approvalReason).toBeUndefined();
      expect(good.command.requestPayload).toMatchObject({
        timeoutMs: 5000,
        lockKey: "repo:acme/web",
        requiresApproval: true,
        approvalReason: "destructive",
      });
    });
  });

  it("carries the operation's streaming flag through", async () => {
    await autoRollbackTransaction(async () => {
      const targetId = await seedComputeTarget();

      const { command } = await desktopCommandStore.createFromRelayOperation(
        targetId,
        relayOperation({ request: { path: "/api/gateway/s" } }, true)
      );

      expect(command.requestPayload.streaming).toBe(true);
    });
  });
});

describeIfDb("desktopCommandStore — idempotency", () => {
  const input = (over: Record<string, unknown> = {}) =>
    ({
      operationId: "health_check",
      method: "POST",
      path: "/api/gateway/health-check",
      headers: {},
      body: null,
      ...over,
    }) as Parameters<typeof desktopCommandStore.createCommand>[1];

  it("returns the SAME command for a repeated key with an identical payload", async () => {
    await autoRollbackTransaction(async () => {
      const targetId = await seedComputeTarget();

      const first = await desktopCommandStore.createCommand(
        targetId,
        input({ idempotencyKey: "k1" })
      );
      const second = await desktopCommandStore.createCommand(
        targetId,
        input({ idempotencyKey: "k1" })
      );

      expect(second.command.commandId).toBe(first.command.commandId);
    });
  });

  it("treats a whitespace-padded key as the same key", async () => {
    await autoRollbackTransaction(async () => {
      const targetId = await seedComputeTarget();

      const first = await desktopCommandStore.createCommand(
        targetId,
        input({ idempotencyKey: "k2" })
      );
      const padded = await desktopCommandStore.createCommand(
        targetId,
        input({ idempotencyKey: "  k2  " })
      );

      // The fingerprint is taken over the TRIMMED key, so a retry that pads the
      // key must dedupe rather than raise a false conflict.
      expect(padded.command.commandId).toBe(first.command.commandId);
    });
  });

  it("rejects a repeated key carrying a DIFFERENT payload", async () => {
    await autoRollbackTransaction(async () => {
      const targetId = await seedComputeTarget();

      await desktopCommandStore.createCommand(
        targetId,
        input({ idempotencyKey: "k3" })
      );

      await expect(
        desktopCommandStore.createCommand(
          targetId,
          input({ idempotencyKey: "k3", path: "/api/gateway/different" })
        )
      ).rejects.toThrow();
    });
  });

  it("scopes idempotency per compute target", async () => {
    await autoRollbackTransaction(async () => {
      const targetA = await seedComputeTarget();
      const targetB = await seedComputeTarget();

      const a = await desktopCommandStore.createCommand(
        targetA,
        input({ idempotencyKey: "shared" })
      );
      const b = await desktopCommandStore.createCommand(
        targetB,
        input({ idempotencyKey: "shared" })
      );

      // Same key on a different target is a different command entirely.
      expect(b.command.commandId).not.toBe(a.command.commandId);
    });
  });

  it("creates independent commands when no key is supplied", async () => {
    await autoRollbackTransaction(async () => {
      const targetId = await seedComputeTarget();

      const first = await desktopCommandStore.createCommand(targetId, input());
      const second = await desktopCommandStore.createCommand(targetId, input());

      expect(second.command.commandId).not.toBe(first.command.commandId);
    });
  });

  it("rejects a caller-supplied commandId that already exists", async () => {
    await autoRollbackTransaction(async () => {
      const targetId = await seedComputeTarget();
      const commandId = "11111111-2222-4333-8444-555555555555";

      await desktopCommandStore.createCommand(targetId, input({ commandId }));

      await expect(
        desktopCommandStore.createCommand(targetId, input({ commandId }))
      ).rejects.toThrow();
    });
  });
});

describeIfDb("desktopCommandStore — event-driven status resolution", () => {
  const queuedCommand = async () => {
    const targetId = await seedComputeTarget();
    const { command } = await desktopCommandStore.createCommand(targetId, {
      operationId: "health_check",
      method: "POST",
      path: "/api/gateway/health-check",
      headers: {},
      body: null,
    } as Parameters<typeof desktopCommandStore.createCommand>[1]);
    return { targetId, commandId: command.commandId };
  };

  const ingest = (
    commandId: string,
    sequence: number,
    eventType: string,
    data: unknown
  ) =>
    desktopCommandStore.ingestCommandEvent({
      commandId,
      sequence,
      eventType,
      data,
    } as Parameters<typeof desktopCommandStore.ingestCommandEvent>[0]);

  it("moves a queued command to Running on a non-terminal event", async () => {
    await autoRollbackTransaction(async () => {
      const { commandId } = await queuedCommand();

      await ingest(commandId, 1, "chunk", { text: "working" });

      const stored = await desktopCommandStore.getCommandById(commandId);
      expect(stored?.status).toBe(DesktopCommandStatus.Running);
      expect(stored?.startedAt).not.toBeNull();
    });
  });

  it("completes on a done event and records finishedAt", async () => {
    await autoRollbackTransaction(async () => {
      const { commandId } = await queuedCommand();

      await ingest(commandId, 1, "done", {});

      const stored = await desktopCommandStore.getCommandById(commandId);
      expect(stored?.status).toBe(DesktopCommandStatus.Done);
      expect(stored?.finishedAt).not.toBeNull();
    });
  });

  it("marks a done event carrying cancelled:true as Cancelled, not Done", async () => {
    await autoRollbackTransaction(async () => {
      const { commandId } = await queuedCommand();

      await ingest(commandId, 1, "done", { cancelled: true });

      expect(
        (await desktopCommandStore.getCommandById(commandId))?.status
      ).toBe(DesktopCommandStatus.Cancelled);
    });
  });

  it("fails only on a TERMINAL error event, and keeps the reported message", async () => {
    await autoRollbackTransaction(async () => {
      const { commandId } = await queuedCommand();

      // A non-terminal error is progress, not an outcome.
      await ingest(commandId, 1, "error", { error: "transient" });
      expect(
        (await desktopCommandStore.getCommandById(commandId))?.status
      ).toBe(DesktopCommandStatus.Running);

      await ingest(commandId, 2, "error", { terminal: true, error: "boom" });
      const stored = await desktopCommandStore.getCommandById(commandId);
      expect(stored?.status).toBe(DesktopCommandStatus.Failed);
      expect(stored?.error).toBe("boom");
    });
  });

  it("supplies a default message when a terminal error names no reason", async () => {
    await autoRollbackTransaction(async () => {
      const { commandId } = await queuedCommand();

      await ingest(commandId, 1, "error", { terminal: true });

      expect((await desktopCommandStore.getCommandById(commandId))?.error).toBe(
        "Command failed"
      );
    });
  });

  it("completes on a terminal result event, honoring cancelled", async () => {
    await autoRollbackTransaction(async () => {
      const done = await queuedCommand();
      await ingest(done.commandId, 1, "result", { terminal: true });
      expect(
        (await desktopCommandStore.getCommandById(done.commandId))?.status
      ).toBe(DesktopCommandStatus.Done);

      const cancelled = await queuedCommand();
      await ingest(cancelled.commandId, 1, "result", {
        terminal: true,
        cancelled: true,
      });
      expect(
        (await desktopCommandStore.getCommandById(cancelled.commandId))?.status
      ).toBe(DesktopCommandStatus.Cancelled);
    });
  });

  it("never moves a command that already reached a terminal status", async () => {
    await autoRollbackTransaction(async () => {
      const { commandId } = await queuedCommand();
      await ingest(commandId, 1, "done", {});

      // A late event from a slow producer must not resurrect a finished command.
      await ingest(commandId, 2, "chunk", { text: "late" });

      expect(
        (await desktopCommandStore.getCommandById(commandId))?.status
      ).toBe(DesktopCommandStatus.Done);
    });
  });
});

describeIfDb("desktopCommandStore — acknowledgement", () => {
  const queued = async () => {
    const targetId = await seedComputeTarget();
    const { command } = await desktopCommandStore.createCommand(targetId, {
      operationId: "health_check",
      method: "POST",
      path: "/api/gateway/health-check",
      headers: {},
      body: null,
    } as Parameters<typeof desktopCommandStore.createCommand>[1]);
    return { targetId, commandId: command.commandId };
  };

  it("accepts a queued command", async () => {
    await autoRollbackTransaction(async () => {
      const { commandId } = await queued();

      await desktopCommandStore.acknowledgeCommand(commandId, true);

      expect(
        (await desktopCommandStore.getCommandById(commandId))?.status
      ).toBe(DesktopCommandStatus.Accepted);
    });
  });

  it("records a rejection as Failed and keeps the reason", async () => {
    await autoRollbackTransaction(async () => {
      const { commandId } = await queued();

      await desktopCommandStore.acknowledgeCommand(
        commandId,
        false,
        "unsupported operation"
      );

      const stored = await desktopCommandStore.getCommandById(commandId);
      expect(stored?.status).toBe(DesktopCommandStatus.Failed);
      expect(stored?.error).toBe("unsupported operation");
    });
  });

  it("will not acknowledge a command belonging to a different compute target", async () => {
    await autoRollbackTransaction(async () => {
      const { commandId } = await queued();
      const otherTarget = await seedComputeTarget();

      const result = await desktopCommandStore.acknowledgeCommand(
        commandId,
        true,
        undefined,
        otherTarget
      );

      // Scoped-out is reported as a null result, not an exception — and the
      // command must be left untouched.
      expect(result).toBeNull();
      expect(
        (await desktopCommandStore.getCommandById(commandId))?.status
      ).toBe(DesktopCommandStatus.Queued);
    });
  });
});
