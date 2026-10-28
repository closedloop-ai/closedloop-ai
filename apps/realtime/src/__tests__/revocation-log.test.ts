import { log } from "@repo/observability/log";
import { REVOCATION_RETENTION_MS } from "@repo/realtime-contract/revocations";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendRevocation,
  REVOCATION_DROPPED_EVENT,
  REVOCATION_LOG_KEY,
  readRevocations,
} from "../bus/revocation-log";
import { ORG_A, USER_A } from "./edge-harness";
import { FakeBusHub } from "./fake-bus";

const NOW = 5_000_000;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the revocation log", () => {
  it("reads back the revokes inside the retention window and trims older ones on append", async () => {
    const client = new FakeBusHub().publisher();
    const expired = {
      target: { userId: USER_A },
      at: NOW - REVOCATION_RETENTION_MS - 1,
    };
    const live = { target: { orgId: ORG_A }, at: NOW };

    await appendRevocation(client, expired);
    await appendRevocation(client, live);

    expect(await readRevocations(client, NOW)).toEqual([live]);
    expect(await client.zrangebyscore(REVOCATION_LOG_KEY, 0, "+inf")).toEqual([
      JSON.stringify(live),
    ]);
  });

  it("drops a malformed entry with a warning that carries its size, never its content", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const client = new FakeBusHub().publisher();
    const secret = "do-not-log-this";
    const live = { target: { userId: USER_A }, at: NOW };
    await client.zadd(REVOCATION_LOG_KEY, NOW, JSON.stringify({ at: secret }));
    await client.zadd(REVOCATION_LOG_KEY, NOW, "{not json");
    await appendRevocation(client, live);

    expect(await readRevocations(client, NOW)).toEqual([live]);
    expect(warn.mock.calls.map(([, fields]) => fields)).toEqual([
      { event: REVOCATION_DROPPED_EVENT, bytes: expect.any(Number) },
      { event: REVOCATION_DROPPED_EVENT, bytes: expect.any(Number) },
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
  });
});
