import { describe, expect, it } from "vitest";
import { tombstoneAwareStorage } from "../storage/document-storage";
import { createTombstones } from "../storage/tombstones";
import { memoryStorage } from "./support/memory-storage";

const STATE = new Uint8Array([1, 2, 3]);

describe("tombstoneAwareStorage", () => {
  it("reads nothing and stores nothing for a tombstoned name, and passes others through", async () => {
    const { storage, rows } = memoryStorage([
      ["deleted", STATE],
      ["live", STATE],
    ]);
    const tombstones = createTombstones();
    tombstones.add("deleted");
    const guarded = tombstoneAwareStorage(storage, tombstones);

    await expect(guarded.fetch("deleted")).resolves.toBeNull();
    await expect(guarded.fetch("live")).resolves.toBe(STATE);
    await guarded.store("deleted", new Uint8Array([9]));
    await guarded.store("live", new Uint8Array([9]));

    expect(storage.store).toHaveBeenCalledOnce();
    expect(storage.store).toHaveBeenCalledWith("live", new Uint8Array([9]));
    expect(rows.get("deleted")).toBe(STATE);
  });

  it("still deletes a tombstoned name's row", async () => {
    const { storage, rows } = memoryStorage([["deleted", STATE]]);
    const tombstones = createTombstones();
    tombstones.add("deleted");

    await expect(
      tombstoneAwareStorage(storage, tombstones).delete("deleted")
    ).resolves.toBe(true);
    expect(rows.has("deleted")).toBe(false);
  });
});
