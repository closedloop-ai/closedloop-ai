import type { onStoreDocumentPayload } from "@hocuspocus/server";
import { describe, expect, it, vi } from "vitest";
import { storeOrRetryLater } from "../storage/retry-failed-store";

type Debounce = (
  id: string,
  fn: () => unknown,
  delayMs: number,
  maxDelayMs: number
) => Promise<unknown>;

/** A payload whose document is fresh per call, so no failure count carries over between tests. */
function payload({ debounced = false } = {}) {
  const document = { name: "doc:org_1:01a1" };
  const storeDocumentHooks = vi.fn(() => Promise.resolve());
  const debounce = vi.fn<Debounce>(() => Promise.resolve());
  const isDebounced = vi.fn(() => debounced);
  const value = {
    document,
    instance: { debouncer: { debounce, isDebounced }, storeDocumentHooks },
  } as unknown as onStoreDocumentPayload;
  return { value, debounce, isDebounced, storeDocumentHooks };
}

const failing = (error: Error) => () => Promise.reject(error);

describe("storeOrRetryLater", () => {
  it("resolves and schedules nothing when the store succeeds", async () => {
    const { value, debounce } = payload();

    await storeOrRetryLater(value, () => Promise.resolve());

    expect(debounce).not.toHaveBeenCalled();
  });

  it("rethrows a failure and schedules the document's store after 1s", async () => {
    const failure = new Error("store failed");
    const { value, debounce, isDebounced } = payload();

    await expect(storeOrRetryLater(value, failing(failure))).rejects.toBe(
      failure
    );

    const debounceId = "onStoreDocument-doc:org_1:01a1";
    expect(isDebounced).toHaveBeenCalledWith(debounceId);
    expect(debounce).toHaveBeenCalledTimes(1);
    expect(debounce.mock.calls[0]?.slice(2)).toEqual([1000, 1000]);
    expect(debounce.mock.calls[0]?.[0]).toBe(debounceId);
  });

  it("the scheduled retry runs the document's store hooks immediately", async () => {
    const { value, debounce, storeDocumentHooks } = payload();

    await storeOrRetryLater(value, failing(new Error("x"))).catch(
      () => undefined
    );
    await debounce.mock.calls[0]?.[1]();

    expect(storeDocumentHooks).toHaveBeenCalledWith(
      value.document,
      value,
      true
    );
  });

  it("backs off per consecutive failure and repeats the last delay", async () => {
    const { value, debounce } = payload();

    for (let attempt = 0; attempt < 8; attempt += 1) {
      await storeOrRetryLater(value, failing(new Error("x"))).catch(
        () => undefined
      );
    }

    expect(debounce.mock.calls.map((call) => call[2])).toEqual([
      1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000,
    ]);
  });

  it("a success resets the backoff", async () => {
    const { value, debounce } = payload();

    await storeOrRetryLater(value, failing(new Error("x"))).catch(
      () => undefined
    );
    await storeOrRetryLater(value, failing(new Error("x"))).catch(
      () => undefined
    );
    await storeOrRetryLater(value, () => Promise.resolve());
    await storeOrRetryLater(value, failing(new Error("x"))).catch(
      () => undefined
    );

    expect(debounce.mock.calls.map((call) => call[2])).toEqual([
      1000, 2000, 1000,
    ]);
  });

  it("schedules nothing when a store is already pending, but still rethrows", async () => {
    const failure = new Error("store failed");
    const { value, debounce } = payload({ debounced: true });

    await expect(storeOrRetryLater(value, failing(failure))).rejects.toBe(
      failure
    );
    expect(debounce).not.toHaveBeenCalled();
  });

  it("attaches a handler that swallows the scheduled retry's rejection", async () => {
    const { value, debounce } = payload();
    const handlers: Array<(reason: unknown) => unknown> = [];
    const scheduled = {
      catch: vi.fn((handler: (reason: unknown) => unknown) => {
        handlers.push(handler);
        return Promise.resolve();
      }),
    } as unknown as Promise<unknown>;
    debounce.mockReturnValueOnce(scheduled);

    await storeOrRetryLater(value, failing(new Error("x"))).catch(
      () => undefined
    );

    expect(handlers).toHaveLength(1);
    expect(handlers[0]?.(new Error("retry failed"))).toBeUndefined();
  });
});
