import { InvocationSyncParentStatus } from "@repo/api/src/types/invocation-sync-diagnostics";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadInvocationSyncParents } from "../src/main/database/invocation-sync-parent-diagnostics.js";
import { createInvocationSyncSourceDelegates } from "../src/main/database/invocation-sync-source-delegates.js";
import type { CapturedStatement } from "../src/main/database/prisma-statement-observers.js";
import { OutboxStatus } from "../src/shared/sync-lane-contract.js";
import { type OpenTestPrisma, openTestPrisma } from "./prisma-test-utils.js";

let store: OpenTestPrisma;
let statements: CapturedStatement[];
beforeEach(async () => {
  statements = [];
  store = await openTestPrisma(undefined, {
    onStatement: (statement) => statements.push(statement),
  });
});
afterEach(async () => {
  await store?.close();
});

describe("invocation parent diagnostic snapshot", () => {
  it("distinguishes pending, withheld, dead-lettered, absent, and missing local parents", async () => {
    await store.prisma.write(async (tx) => {
      await tx.session.createMany({
        data: ["pending", "withheld", "dead-lettered", "unqueued"].map(
          (id) => ({ id })
        ),
      });
      await tx.agentSessionSyncOutbox.createMany({
        data: [
          {
            externalSessionId: "pending",
            status: OutboxStatus.Pending,
            attemptCount: 2,
            lastError: "transport_error",
          },
          { externalSessionId: "withheld", status: OutboxStatus.Withheld },
          {
            externalSessionId: "dead-lettered",
            status: OutboxStatus.DeadLettered,
            attemptCount: 5,
            lastError: "ack_omitted",
          },
        ].map((row) => ({
          sourceKey: "sessions:target-1",
          createdAt: "2026-10-05T19:40:00.000Z",
          updatedAt: "2026-10-05T19:40:00.000Z",
          ...row,
        })),
      });
    });
    const source = createInvocationSyncSourceDelegates(store.prisma, () => {});
    const parents = await source.loadInvocationSyncParents?.(
      "sessions:target-1",
      ["pending", "withheld", "dead-lettered", "unqueued", "missing"]
    );
    expect(parents).toEqual([
      {
        externalSessionId: "pending",
        sessionPresent: true,
        outboxStatus: InvocationSyncParentStatus.Pending,
        attemptCount: 2,
        lastError: "transport_error",
      },
      {
        externalSessionId: "withheld",
        sessionPresent: true,
        outboxStatus: InvocationSyncParentStatus.Withheld,
        attemptCount: 0,
      },
      {
        externalSessionId: "dead-lettered",
        sessionPresent: true,
        outboxStatus: InvocationSyncParentStatus.DeadLettered,
        attemptCount: 5,
        lastError: "ack_omitted",
      },
      // `Absent` says only "no outbox row under this source key". It cannot say
      // "never enqueued": the verified-ack clear DELETES the row, so a parent the
      // cloud acked and then lost reads identically, and nothing durable on the
      // desktop separates the two.
      {
        externalSessionId: "unqueued",
        sessionPresent: true,
        outboxStatus: InvocationSyncParentStatus.Absent,
      },
      {
        externalSessionId: "missing",
        sessionPresent: false,
        outboxStatus: InvocationSyncParentStatus.Absent,
      },
    ]);
  });

  it("flags an unreadable retry deadline without sinking the whole read", async () => {
    await store.prisma.write(async (tx) => {
      await tx.session.createMany({
        data: [{ id: "corrupt" }, { id: "intact" }],
      });
      await tx.agentSessionSyncOutbox.createMany({
        data: [
          { externalSessionId: "corrupt", nextAttemptAt: "not-a-timestamp" },
          {
            externalSessionId: "intact",
            nextAttemptAt: "2026-10-05T19:45:00.000Z",
          },
        ].map((row) => ({
          sourceKey: "sessions:target-1",
          status: OutboxStatus.Pending,
          attemptCount: 1,
          createdAt: "2026-10-05T19:40:00.000Z",
          updatedAt: "2026-10-05T19:40:00.000Z",
          ...row,
        })),
      });
    });

    // One corrupt column used to throw out of `invocationSyncParentSchema.parse`
    // and reject the bounded read, which sent every parent in the tick to
    // `parentReadFailed` — losing the evidence for the intact ones. Same
    // treatment as `createdAt` on the part side: the value is dropped, the fact
    // that it was unreadable is reported.
    expect(
      await loadInvocationSyncParents(store.prisma, "sessions:target-1", [
        "corrupt",
        "intact",
      ])
    ).toEqual([
      {
        externalSessionId: "corrupt",
        sessionPresent: true,
        outboxStatus: InvocationSyncParentStatus.Pending,
        attemptCount: 1,
        nextAttemptAtInvalid: true,
      },
      {
        externalSessionId: "intact",
        sessionPresent: true,
        outboxStatus: InvocationSyncParentStatus.Pending,
        attemptCount: 1,
        nextAttemptAt: "2026-10-05T19:45:00.000Z",
      },
    ]);
  });

  it("never borrows another target's parent queue state", async () => {
    await store.prisma.write((tx) =>
      tx.agentSessionSyncOutbox.create({
        data: {
          sourceKey: "sessions:other-target",
          externalSessionId: "same-session",
          status: OutboxStatus.Withheld,
          createdAt: "2026-10-05T19:40:00.000Z",
          updatedAt: "2026-10-05T19:40:00.000Z",
        },
      })
    );
    expect(
      await loadInvocationSyncParents(store.prisma, "sessions:target-1", [
        "same-session",
      ])
    ).toEqual([
      {
        externalSessionId: "same-session",
        sessionPresent: false,
        outboxStatus: InvocationSyncParentStatus.Absent,
      },
    ]);
  });

  it("bounds the read to ten distinct parents without hydrating sessions", async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `session-${i}`);
    const parents = await loadInvocationSyncParents(
      store.prisma,
      "sessions:target-1",
      [ids[0]!, ...ids]
    );
    const reads = statements.filter((statement) =>
      statement.sql.includes("SELECT")
    );
    expect(reads).toHaveLength(2);
    for (const read of reads) {
      expect(
        read.args.filter(
          (arg) => typeof arg === "string" && arg.startsWith("session-")
        )
      ).toEqual(ids.slice(0, 10));
    }
    const sessionRead = reads.find((read) => read.sql.includes("sessions"));
    expect(sessionRead).toBeDefined();
    const projection = sessionRead?.sql
      .split(sqlFromPattern)[0]
      ?.replaceAll('"', "")
      .replaceAll("`", "");
    expect(projection).toMatch(idProjectionPattern);
    expect(parents).toHaveLength(10);
    expect(parents.map((parent) => parent.externalSessionId)).toEqual(
      ids.slice(0, 10)
    );
  });
});

const sqlFromPattern = / FROM /i;
const idProjectionPattern = /^SELECT (?:\w+\.)*id$/i;
