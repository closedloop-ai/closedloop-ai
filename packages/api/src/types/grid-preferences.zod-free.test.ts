import { expect, it, vi } from "vitest";

const zodProbe = vi.hoisted(() => ({ evaluated: false }));

vi.mock("zod", async (importOriginal) => {
  zodProbe.evaluated = true;
  return await importOriginal();
});

it("keeps the grid preference vocabulary importable without zod", async () => {
  await import("./grid-preferences.ts");

  expect(zodProbe.evaluated).toBe(false);

  await import("./grid-preferences-schema.ts");

  expect(zodProbe.evaluated).toBe(true);
});
