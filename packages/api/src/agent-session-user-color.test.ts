import { describe, expect, it } from "vitest";
import {
  buildUserColor,
  DEFAULT_HUMAN_ACTOR_COLOR_TOKEN,
} from "./agent-session-user-color.ts";
import type { BasicUser } from "./types/user.ts";

const HSL_COLOR_PATTERN = /^hsl\(\d{1,3} 65% 45%\)$/;
const HSL_COLOR_HUE_PATTERN = /^hsl\((\d{1,3}) 65% 45%\)$/;

function user(overrides: Partial<BasicUser> = {}): BasicUser {
  return {
    id: "user-1",
    email: "a@example.com",
    firstName: null,
    lastName: null,
    avatarUrl: null,
    ...overrides,
  };
}

describe("buildUserColor", () => {
  it("returns null for an unresolved owner", () => {
    expect(buildUserColor(null)).toBeNull();
  });

  it("is deterministic and hsl-shaped for the same owner id", () => {
    const color = buildUserColor(user({ id: "abc" }));
    expect(color).toMatch(HSL_COLOR_PATTERN);
    expect(buildUserColor(user({ id: "abc" }))).toBe(color);
  });

  it("different ids can produce different hues", () => {
    expect(buildUserColor(user({ id: "aaa" }))).not.toBe(
      buildUserColor(user({ id: "zzz" }))
    );
  });

  it("falls back to email when id is empty", () => {
    expect(
      buildUserColor(user({ id: "", email: "person@example.com" }))
    ).toMatch(HSL_COLOR_PATTERN);
  });

  it("keeps the hue within the valid 0-359 range", () => {
    for (const id of [
      "",
      "a",
      "the-quick-brown-fox",
      "🙂-emoji",
      "1234567890",
    ]) {
      const match = HSL_COLOR_HUE_PATTERN.exec(
        buildUserColor(user({ id, email: `${id}@example.com` })) ?? ""
      );
      expect(match).not.toBeNull();
      const hue = Number(match?.[1]);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThanOrEqual(359);
    }
  });

  it("exposes the fallback color token", () => {
    expect(DEFAULT_HUMAN_ACTOR_COLOR_TOKEN).toBe("var(--muted-foreground)");
  });
});
