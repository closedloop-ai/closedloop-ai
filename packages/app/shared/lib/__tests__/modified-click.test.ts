import type { MouseEvent } from "react";
import { describe, expect, it } from "vitest";
import { isModifiedClick } from "../modified-click";

function clickEvent(
  overrides: Partial<
    Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">
  >
): MouseEvent {
  return {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  } as MouseEvent;
}

describe("isModifiedClick", () => {
  it("is false for a plain primary-button click with no modifiers", () => {
    expect(isModifiedClick(clickEvent({}))).toBe(false);
  });

  it("is true when the meta key is held", () => {
    expect(isModifiedClick(clickEvent({ metaKey: true }))).toBe(true);
  });

  it("is true when the ctrl key is held", () => {
    expect(isModifiedClick(clickEvent({ ctrlKey: true }))).toBe(true);
  });

  it("is true when the shift key is held", () => {
    expect(isModifiedClick(clickEvent({ shiftKey: true }))).toBe(true);
  });

  it("is true when the alt key is held", () => {
    expect(isModifiedClick(clickEvent({ altKey: true }))).toBe(true);
  });

  it("is true for a non-primary button even with no modifiers", () => {
    expect(isModifiedClick(clickEvent({ button: 1 }))).toBe(true);
    expect(isModifiedClick(clickEvent({ button: 2 }))).toBe(true);
  });
});
