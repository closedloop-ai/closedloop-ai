import { describe, expect, it } from "vitest";
import {
  LANDING_HERO_HEADLINE,
  LANDING_HERO_HEADLINE_ACCENT_WORD,
  splitHeadlineOnAccent,
} from "./landing-hero-copy";

describe("splitHeadlineOnAccent", () => {
  it("splits the shipped headline around the shipped accent word", () => {
    expect(
      splitHeadlineOnAccent(
        LANDING_HERO_HEADLINE,
        LANDING_HERO_HEADLINE_ACCENT_WORD
      )
    ).toEqual({
      before: "Stop ",
      accent: LANDING_HERO_HEADLINE_ACCENT_WORD,
      after: " tokens.",
    });
  });

  it("renders the headline whole when a copy edit drops the accent word", () => {
    // The failure this exists for: a plain `split` returns one segment, and a
    // surface rendering before + accent + after prints the headline followed by
    // a stray word that is no longer in it.
    const result = splitHeadlineOnAccent(
      "Stop wasting tokens.",
      LANDING_HERO_HEADLINE_ACCENT_WORD
    );

    expect(result.accent).toBeNull();
    expect(result.before).toBe("Stop wasting tokens.");
    expect(result.after).toBe("");
  });

  it("emphasises only the first occurrence and keeps the rest", () => {
    expect(splitHeadlineOnAccent("a b a b a", "b")).toEqual({
      before: "a ",
      accent: "b",
      after: " a b a",
    });
  });

  it("handles an accent word the headline starts with", () => {
    expect(splitHeadlineOnAccent("burning tokens", "burning")).toEqual({
      before: "",
      accent: "burning",
      after: " tokens",
    });
  });
});
