import { act } from "@testing-library/react";
import type { Mock } from "vitest";

type ToastSuccessOptions = {
  action: { label: string; onClick: () => void };
};

export type ToastSuccessHandler = (
  message: string,
  options: ToastSuccessOptions
) => void;

export type ToastSuccess = Mock<ToastSuccessHandler>;

/** Fires the Undo action of the most recent success toast, as a user click would. */
export function runLastToastUndo(toastSuccess: ToastSuccess) {
  const options = toastSuccess.mock.lastCall?.[1];
  if (!options) {
    throw new Error("No success toast was raised");
  }
  act(() => options.action.onClick());
}
