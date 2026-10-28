import { describe, expect, it, vi } from "vitest";
import type { SqlClient } from "../scripts/db-utils";
import {
  PREVIEW_SEED_LOCK_NAMESPACE,
  SeedAdmissionRefusal,
  withPreviewSeedAdmission,
} from "../scripts/preview-seed-lock";

/*
 * ISS-6804. The admission gate bounds CONCURRENT seeds against one preview
 * schema — the fan-out a duplicate dispatch or a replayed token would otherwise
 * multiply. Driven with an injected client so the acquire, the refusal
 * classification and the release are all exercised without a database.
 */

const SCHEMA = "preview_feat_iss_6804";
const DATABASE_URL = "postgresql://u:placeholder@db.example.test:5432/app";
const LOCK_TIMEOUT_SETTING = /^\d+ms$/;

type QueryCall = { text: string; values?: unknown[] };

function stubClient(
  onQuery: (call: QueryCall) => Promise<unknown> = () => Promise.resolve({})
): { client: SqlClient; calls: QueryCall[]; ended: () => number } {
  const calls: QueryCall[] = [];
  let endCount = 0;
  return {
    calls,
    ended: () => endCount,
    client: {
      connect: () => Promise.resolve(),
      query: (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        return onQuery({ text, values });
      },
      end: () => {
        endCount++;
        return Promise.resolve();
      },
    },
  };
}

function sqlstateError(code: string): Error {
  return Object.assign(new Error(`canceled: ${code}`), { code });
}

describe("preview seed admission gate", () => {
  it("runs the seed under a bounded, schema-scoped advisory lock and releases it", async () => {
    const { client, calls, ended } = stubClient();
    const fn = vi.fn().mockResolvedValue("seeded");

    const admission = await withPreviewSeedAdmission(
      { databaseUrl: DATABASE_URL, schema: SCHEMA, createClient: () => client },
      fn
    );

    expect(admission).toEqual({ admitted: true, result: "seeded" });
    expect(fn).toHaveBeenCalledOnce();

    // The wait is BOUNDED — without lock_timeout the acquire blocks forever on
    // a stalled holder, which is the hang this gate must not introduce.
    const lockTimeout = calls.find((call) =>
      call.text.includes("lock_timeout")
    );
    expect(lockTimeout?.values?.[0]).toMatch(LOCK_TIMEOUT_SETTING);

    // Schema-scoped: namespace + hashtext(schema), so other schemas run free.
    const acquire = calls.find((call) =>
      call.text.includes("pg_advisory_lock(")
    );
    expect(acquire?.text).toContain("hashtext($2)");
    expect(acquire?.values).toEqual([PREVIEW_SEED_LOCK_NAMESPACE, SCHEMA]);

    expect(calls.some((call) => call.text.includes("pg_advisory_unlock"))).toBe(
      true
    );
    expect(ended()).toBe(1);
  });

  it("refuses a concurrent seed for the same schema instead of running it", async () => {
    // 55P03 is what `lock_timeout` raises when a peer already holds the lock.
    const { client, ended } = stubClient((call) =>
      call.text.includes("pg_advisory_lock(")
        ? Promise.reject(sqlstateError("55P03"))
        : Promise.resolve({})
    );
    const fn = vi.fn();

    const admission = await withPreviewSeedAdmission(
      { databaseUrl: DATABASE_URL, schema: SCHEMA, createClient: () => client },
      fn
    );

    expect(admission).toMatchObject({
      admitted: false,
      refusal: SeedAdmissionRefusal.Contended,
    });
    // Fails CLOSED: the whole point is that the second seed does NOT run.
    expect(fn).not.toHaveBeenCalled();
    expect(ended()).toBe(1);
  });

  it("classifies a broken gate as unavailable, not as a contended peer", async () => {
    const { client } = stubClient((call) =>
      call.text.includes("pg_advisory_lock(")
        ? Promise.reject(sqlstateError("08006"))
        : Promise.resolve({})
    );
    const fn = vi.fn();

    const admission = await withPreviewSeedAdmission(
      { databaseUrl: DATABASE_URL, schema: SCHEMA, createClient: () => client },
      fn
    );

    expect(admission).toMatchObject({
      admitted: false,
      refusal: SeedAdmissionRefusal.Unavailable,
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it("releases the lock when the seed itself throws", async () => {
    const { client, calls, ended } = stubClient();
    const boom = new Error("seed exploded");

    await expect(
      withPreviewSeedAdmission(
        {
          databaseUrl: DATABASE_URL,
          schema: SCHEMA,
          createClient: () => client,
        },
        () => Promise.reject(boom)
      )
    ).rejects.toThrow(boom);

    expect(calls.some((call) => call.text.includes("pg_advisory_unlock"))).toBe(
      true
    );
    expect(ended()).toBe(1);
  });

  it("uses a namespace that cannot collide with the plain-index lock", () => {
    // Both live in the two-int advisory keyspace, so an equal namespace would
    // make a seed serialize against an unrelated index build. The plain-index
    // namespace is module-private in scripts/preview-plain-index.ts; if that
    // ever changes, import it here instead of restating the value.
    const plainIndexLockNamespace = 72_707_370;
    expect(PREVIEW_SEED_LOCK_NAMESPACE).not.toBe(plainIndexLockNamespace);
  });
});
