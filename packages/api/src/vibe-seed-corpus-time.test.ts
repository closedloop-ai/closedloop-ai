import { describe, expect, it } from "vitest";
import {
  shiftVibeCorpusInstants,
  type VibeCorpusTimeMap,
  vibeCorpusTimeMapSchema,
} from "./vibe-seed-corpus-time.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAP: VibeCorpusTimeMap = {
  shiftMs: 30 * DAY_MS,
  importStartedAt: "2026-10-01T00:00:00.000Z",
  idleGaps: [
    { beforeIso: "2026-08-01T00:00:00.000Z", closeMs: 5 * DAY_MS },
    { beforeIso: "2026-07-01T00:00:00.000Z", closeMs: 2 * DAY_MS },
  ],
};

function shifted(iso: string, offsetMs: number): string {
  return new Date(Date.parse(iso) + offsetMs).toISOString();
}

describe("shiftVibeCorpusInstants", () => {
  it("moves each instant by the shift plus every idle gap after it", () => {
    const line = (at: string) => `{"type":"user","timestamp":"${at}"}`;

    expect(shiftVibeCorpusInstants(line("2026-06-20T10:00:00.000Z"), MAP)).toBe(
      line(shifted("2026-06-20T10:00:00.000Z", 37 * DAY_MS))
    );
    expect(shiftVibeCorpusInstants(line("2026-07-15T10:00:00.000Z"), MAP)).toBe(
      line(shifted("2026-07-15T10:00:00.000Z", 35 * DAY_MS))
    );
    expect(shiftVibeCorpusInstants(line("2026-08-15T10:00:00.000Z"), MAP)).toBe(
      line(shifted("2026-08-15T10:00:00.000Z", 30 * DAY_MS))
    );
  });

  it("moves every instant on a line, in any offset form, and leaves import-stamped ones", () => {
    const text =
      '{"a":"2026-08-15T10:00:00Z","b":"2026-08-15T12:00:00.123456+02:00","c":"2026-10-02T00:00:00.000Z"}';

    expect(shiftVibeCorpusInstants(text, MAP)).toBe(
      `{"a":"${shifted("2026-08-15T10:00:00.000Z", 30 * DAY_MS)}","b":"${shifted("2026-08-15T10:00:00.123Z", 30 * DAY_MS)}","c":"2026-10-02T00:00:00.000Z"}`
    );
  });
});

describe("vibeCorpusTimeMapSchema", () => {
  it("reads the map a store build records and refuses one missing a field", () => {
    expect(
      vibeCorpusTimeMapSchema.parse(JSON.parse(JSON.stringify(MAP)))
    ).toEqual(MAP);
    expect(
      vibeCorpusTimeMapSchema.safeParse({ shiftMs: 1, idleGaps: [] }).success
    ).toBe(false);
  });
});
