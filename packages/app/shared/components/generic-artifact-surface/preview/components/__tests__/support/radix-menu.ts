import { fireEvent } from "@testing-library/react";

// Radix menu triggers open on a primary-button pointerdown, not on click.
export function openRadixMenu(trigger: HTMLElement): void {
  fireEvent.pointerDown(trigger, {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
}
