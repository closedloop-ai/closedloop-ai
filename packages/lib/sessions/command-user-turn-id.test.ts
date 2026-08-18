/**
 * ISS-4795 / ISS-4796 — the slash-command component-key contract.
 *
 * These two findings are one defect seen twice: nothing owned what a command
 * `component_key` IS. ISS-4795 is the shape half (two producers disagreed on the
 * leading slash, so `/clear` and `//clear` became two components splitting one
 * command's usage); ISS-4796 is the admission half (nothing checked the key
 * named a command at all, so a truncated palette string `/...` minted a real
 * inventory row). Both are settled here, at the one normalizer every producer
 * routes through.
 */
import { describe, expect, it } from "vitest";
import {
  commandUserTurnId,
  isAdmissibleCommandComponentKey,
  normalizeCommandComponentKey,
} from "./command-user-turn-id";

describe("normalizeCommandComponentKey — one key per command (ISS-4795)", () => {
  it.each([
    ["clear", "/clear"],
    ["/clear", "/clear"],
    ["//clear", "/clear"],
    ["///clear", "/clear"],
    ["  //clear  ", "/clear"],
  ])("normalizes %j to %j", (input, expected) => {
    expect(normalizeCommandComponentKey(input)).toBe(expected);
  });

  /**
   * The regression proper. Before the fix the definition-file collector
   * hand-prepended `/` to a frontmatter `name` that already carried one, while
   * the invocation path prepended only when missing — so the SAME command minted
   * two keys and org-dedup rendered it as two components with two usage
   * populations (`/clear` 133 invocations + `//clear` 111).
   */
  it("collapses the two producers' spellings of one command onto one key", () => {
    const fromDefinitionFrontmatter = normalizeCommandComponentKey("/clear");
    const fromInvocationEvent = normalizeCommandComponentKey("clear");
    const alreadyDoubled = normalizeCommandComponentKey("//clear");

    expect(fromDefinitionFrontmatter).toBe(fromInvocationEvent);
    expect(alreadyDoubled).toBe(fromInvocationEvent);
    expect(new Set([fromDefinitionFrontmatter, alreadyDoubled]).size).toBe(1);
  });

  it("keeps a namespaced command's inner separators intact", () => {
    expect(normalizeCommandComponentKey("//code-review:deep")).toBe(
      "/code-review:deep"
    );
    expect(normalizeCommandComponentKey("/self-learning:goal-stats")).toBe(
      "/self-learning:goal-stats"
    );
  });

  it("derives one user-turn identity for both spellings of a command", () => {
    const timestamp = "2026-07-09T00:00:00.000Z";
    const doubled = commandUserTurnId({ name: "//exit", timestamp }, 0);
    const single = commandUserTurnId({ name: "/exit", timestamp }, 0);

    expect(doubled).toBe(single);
  });
});

describe("isAdmissibleCommandComponentKey — placeholders never mint a component (ISS-4796)", () => {
  it.each([
    ["/build"],
    ["/code-review:deep"],
    ["/2fa"],
    ["/日本語"],
  ])("admits %j as a real command", (key) => {
    expect(isAdmissibleCommandComponentKey(key)).toBe(true);
  });

  /**
   * `/...` and `/…` are the two spellings observed in production, but the gate
   * is a positive test for a letter or digit rather than a denylist, so any
   * other truncation spelling is rejected too.
   */
  it.each([
    ["/..."],
    ["/…"],
    ["/"],
    ["/.."],
    ["/---"],
    ["/  "],
  ])("rejects the placeholder %j", (key) => {
    expect(isAdmissibleCommandComponentKey(key)).toBe(false);
  });

  it("rejects a placeholder even after normalization repairs its shape", () => {
    expect(
      isAdmissibleCommandComponentKey(normalizeCommandComponentKey("..."))
    ).toBe(false);
    expect(
      isAdmissibleCommandComponentKey(normalizeCommandComponentKey("//…"))
    ).toBe(false);
  });
});
