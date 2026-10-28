// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  type DesktopAvailabilityNotifyCopy,
  DesktopAvailabilityNotifyForm,
  DesktopAvailabilityNotifyStatus,
} from "../desktop-availability-notify-form";

/**
 * ISS-12364: the five states the ticket names — initial, invalid email,
 * submitting, success, submission error with a retry — and the accessibility
 * contract each one owes: a labelled field, a message the field is described by
 * and that is announced, and a submit control that is busy and disabled while
 * the host's request is in flight.
 *
 * The copy is marker strings, not product words: the component takes every
 * word as a prop, and these cases are about which slot renders when.
 */
const COPY = {
  emailLabel: "slot:emailLabel",
  explanation: "slot:explanation",
  failure: "slot:failure",
  invalidEmail: "slot:invalidEmail",
  retryLabel: "slot:retryLabel",
  submitLabel: "slot:submitLabel",
  submittingLabel: "slot:submittingLabel",
  successDetail: "slot:successDetail",
  successTitle: "slot:successTitle",
} as const satisfies DesktopAvailabilityNotifyCopy;

function deferred() {
  let resolve: () => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

function renderForm(
  onSubmit: (email: string) => Promise<void>,
  defaultEmail?: string
) {
  render(
    <DesktopAvailabilityNotifyForm
      copy={COPY}
      defaultEmail={defaultEmail}
      onSubmit={onSubmit}
    />
  );
  return {
    field: screen.getByLabelText(COPY.emailLabel),
    form: () =>
      document.querySelector("[data-slot='desktop-availability-notify']"),
  };
}

/** Clicks and lets the host's promise settle inside `act`. */
async function press(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

function submitButton(name: string) {
  return screen.getByRole("button", { name });
}

describe("DesktopAvailabilityNotifyForm (ISS-12364)", () => {
  it("starts in the initial state: labelled field, explanation, call to action", () => {
    const { field, form } = renderForm(vi.fn());

    expect(form()?.getAttribute("data-status")).toBe(
      DesktopAvailabilityNotifyStatus.Editing
    );
    expect(field.getAttribute("type")).toBe("email");
    expect(field.getAttribute("autocomplete")).toBe("email");
    expect(field.getAttribute("aria-invalid")).toBeNull();
    // The explanation is what the field is described by, so the purpose is
    // read out before the reader submits.
    const describedBy = field.getAttribute("aria-describedby") ?? "";
    const explanation = screen.getByText(COPY.explanation);
    expect(describedBy.split(" ")).toContain(explanation.id);
    expect(submitButton(COPY.submitLabel).hasAttribute("disabled")).toBe(false);
  });

  it("pre-fills the host's address and leaves it editable", () => {
    const { field } = renderForm(vi.fn(), "reader@example.com");

    expect((field as HTMLInputElement).value).toBe("reader@example.com");
    expect(field.hasAttribute("readonly")).toBe(false);
  });

  it("rejects an invalid address without calling the host, and announces why", () => {
    const onSubmit = vi.fn();
    const { field, form } = renderForm(onSubmit);

    fireEvent.change(field, { target: { value: "not-an-email" } });
    fireEvent.click(submitButton(COPY.submitLabel));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(form()?.getAttribute("data-status")).toBe(
      DesktopAvailabilityNotifyStatus.Invalid
    );
    expect(field.getAttribute("aria-invalid")).toBe("true");
    const message = screen.getByText(COPY.invalidEmail);
    expect(message.getAttribute("aria-live")).toBe("polite");
    expect((field.getAttribute("aria-describedby") ?? "").split(" ")).toContain(
      message.id
    );
    expect(document.activeElement).toBe(field);
  });

  it("treats an empty field as invalid rather than submitting nothing", () => {
    const onSubmit = vi.fn();
    renderForm(onSubmit);

    fireEvent.click(submitButton(COPY.submitLabel));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(COPY.invalidEmail)).toBeTruthy();
  });

  it("clears the invalid message once the address is edited", () => {
    const { field } = renderForm(vi.fn());

    fireEvent.click(submitButton(COPY.submitLabel));
    fireEvent.change(field, { target: { value: "reader@" } });

    expect(screen.queryByText(COPY.invalidEmail)).toBeNull();
    expect(field.getAttribute("aria-invalid")).toBeNull();
  });

  it("is busy and disabled while the host's request is in flight", async () => {
    const request = deferred();
    const onSubmit = vi.fn(() => request.promise);
    const { field, form } = renderForm(onSubmit, "  reader@example.com ");

    await press(submitButton(COPY.submitLabel));

    expect(onSubmit).toHaveBeenCalledWith("reader@example.com");
    expect(form()?.getAttribute("aria-busy")).toBe("true");
    const button = submitButton(COPY.submittingLabel);
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(field.hasAttribute("readonly")).toBe(true);

    // A second submit while in flight does not send a second request.
    fireEvent.submit(form() as HTMLFormElement);
    expect(onSubmit).toHaveBeenCalledTimes(1);

    await act(async () => {
      request.resolve();
      await request.promise;
    });
  });

  it("confirms a received request in a status region", async () => {
    renderForm(() => Promise.resolve(), "reader@example.com");

    await press(submitButton(COPY.submitLabel));

    const status = screen.getByRole("status");
    expect(status.textContent).toContain(COPY.successTitle);
    expect(status.textContent).toContain(COPY.successDetail);
    expect(screen.queryByLabelText(COPY.emailLabel)).toBeNull();
  });

  it("keeps the address and offers a retry when the request fails", async () => {
    const onSubmit = vi
      .fn<(email: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(undefined);
    const { field } = renderForm(onSubmit, "reader@example.com");

    await press(submitButton(COPY.submitLabel));

    const message = screen.getByText(COPY.failure);
    expect(message.getAttribute("aria-live")).toBe("polite");
    expect((field as HTMLInputElement).value).toBe("reader@example.com");
    expect(field.getAttribute("aria-invalid")).toBeNull();

    await press(submitButton(COPY.retryLabel));

    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status").textContent).toContain(COPY.successTitle);
  });

  /**
   * marisolashgrove, review of #8983: success used to live only in the form's own
   * state, so a reader who signed up, went Back and returned to the step got
   * an empty form and could sign up again. The host now passes the recorded
   * address back in.
   */
  describe("when the host has already recorded an address", () => {
    it("opens on the confirmation, with no field and no call to action", () => {
      const onSubmit = vi.fn<(email: string) => Promise<void>>();
      render(
        <DesktopAvailabilityNotifyForm
          copy={COPY}
          onSubmit={onSubmit}
          submittedEmail="reader@example.com"
        />
      );

      const status = screen.getByRole("status");
      expect(status.getAttribute("data-status")).toBe(
        DesktopAvailabilityNotifyStatus.Succeeded
      );
      expect(status.textContent).toContain(COPY.successTitle);
      expect(screen.queryByLabelText(COPY.emailLabel)).toBeNull();
      expect(
        screen.queryByRole("button", { name: COPY.submitLabel })
      ).toBeNull();
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it("shows the confirmation again after Back then forward", async () => {
      // The download step unmounts the form when the reader goes Back.
      function Host() {
        const [onStep, setOnStep] = useState(true);
        const [submittedEmail, setSubmittedEmail] = useState<string>();
        return (
          <>
            <button onClick={() => setOnStep((shown) => !shown)} type="button">
              toggle-step
            </button>
            {onStep ? (
              <DesktopAvailabilityNotifyForm
                copy={COPY}
                defaultEmail="reader@example.com"
                onSubmit={(email) => {
                  setSubmittedEmail(email);
                  return Promise.resolve();
                }}
                submittedEmail={submittedEmail}
              />
            ) : null}
          </>
        );
      }
      render(<Host />);

      await press(submitButton(COPY.submitLabel));
      await press(screen.getByRole("button", { name: "toggle-step" }));
      expect(screen.queryByRole("status")).toBeNull();
      await press(screen.getByRole("button", { name: "toggle-step" }));

      expect(screen.getByRole("status").textContent).toContain(
        COPY.successTitle
      );
      expect(screen.queryByLabelText(COPY.emailLabel)).toBeNull();
    });
  });
});
