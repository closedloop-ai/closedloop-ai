import { describe, expect, it } from "vitest";
import {
  ActorTurnSide,
  actorColorForTurn,
  actorColorPairForSlot,
  UNKNOWN_ACTOR_COLOR_PAIR,
} from "../actor-color-domain";

// Written out rather than read back from the authority: a fixture that derives
// its expectation from the module it guards stays green when that module's
// tokens are retired or reseated, which is the whole failure this file exists to
// catch. The duplication IS the test.
const PRIMARY_ACTOR_BASE = "var(--chart-2)";
const NEUTRAL_ACTOR_BASE =
  "color-mix(in oklch, var(--muted-foreground) 70%, var(--card))";
const PRIMARY_ACTOR_HUMAN =
  "color-mix(in oklch, var(--chart-2) 62%, var(--background))";
const PRIMARY_ACTOR_AGENT =
  "color-mix(in oklch, var(--chart-2) 84%, var(--foreground))";
const NEUTRAL_ACTOR_HUMAN =
  "color-mix(in oklch, var(--muted-foreground) 70%, var(--card))";

describe("actorColorPairForSlot", () => {
  it("seats the primary actor on the first categorical pair", () => {
    expect(actorColorPairForSlot(0).base).toBe(PRIMARY_ACTOR_BASE);
  });

  it("keeps the primary seat fixed while an offset rotates the rest", () => {
    expect(actorColorPairForSlot(0, 5).base).toBe(PRIMARY_ACTOR_BASE);
    expect(actorColorPairForSlot(1, 5).base).not.toBe(
      actorColorPairForSlot(1).base
    );
  });

  it("never seats an attributed actor on the unknown-actor neutral", () => {
    for (let slot = 0; slot < 64; slot++) {
      expect(actorColorPairForSlot(slot).base).not.toBe(NEUTRAL_ACTOR_BASE);
      expect(actorColorPairForSlot(slot, 5).base).not.toBe(NEUTRAL_ACTOR_BASE);
    }
  });
});

describe("unknown actors", () => {
  it("degrades to the explicit neutral token without inventing a hue", () => {
    expect(UNKNOWN_ACTOR_COLOR_PAIR.base).toBe(NEUTRAL_ACTOR_BASE);
  });

  it("resolves an absent or nonsensical seat to that same neutral", () => {
    for (const slot of [null, undefined, -1, Number.NaN]) {
      expect(actorColorPairForSlot(slot).base).toBe(NEUTRAL_ACTOR_BASE);
    }
  });
});

describe("actorColorForTurn", () => {
  it("distinguishes the human and agent sides of one actor", () => {
    const pair = actorColorPairForSlot(0);
    expect(actorColorForTurn(pair, ActorTurnSide.Human)).toBe(
      PRIMARY_ACTOR_HUMAN
    );
    expect(actorColorForTurn(pair, ActorTurnSide.Agent)).toBe(
      PRIMARY_ACTOR_AGENT
    );
  });

  it("carries the neutral through both sides for an unknown actor", () => {
    expect(
      actorColorForTurn(UNKNOWN_ACTOR_COLOR_PAIR, ActorTurnSide.Human)
    ).toBe(NEUTRAL_ACTOR_HUMAN);
  });
});
