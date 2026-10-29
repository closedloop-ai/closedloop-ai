import { describe, expect, it } from "vitest";
import { boundedMeshPage } from "./bounded-page";

describe("Session Mesh wire page budget", () => {
  it("cuts on bytes before a valid large population exceeds the native reader", () => {
    const rows = Array.from({ length: 200 }, (_, id) => ({
      id,
      context: "x".repeat(32_000),
    }));
    const first = boundedMeshPage(rows, 200);
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(200);
    expect(Buffer.byteLength(JSON.stringify({ messages: first }))).toBeLessThan(
      256 * 1024
    );
    const second = boundedMeshPage(rows.slice(first.length), 200);
    expect(second[0]?.id).toBe(first.length);
  });
  it("uses encoded UTF-8 bytes and rejects an impossible stored record", () => {
    expect(
      boundedMeshPage(
        [{ value: "💡".repeat(32_000) }, { value: "💡".repeat(32_000) }],
        200
      )
    ).toHaveLength(1);
    expect(() =>
      boundedMeshPage([{ value: "x".repeat(250 * 1024) }], 200)
    ).toThrow("wire budget");
  });
  it("keeps the item cap and does not fabricate an empty item", () => {
    expect(boundedMeshPage([1, 2, 3], 2)).toEqual([1, 2]);
    expect(boundedMeshPage([], 200)).toEqual([]);
  });
});
