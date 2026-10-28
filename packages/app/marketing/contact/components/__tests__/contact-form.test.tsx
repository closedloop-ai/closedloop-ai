import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  ContactFormField,
  type ContactFormSubmission,
} from "../../lib/contact-form-schema";
import { ContactForm, type ContactFormCopy } from "../contact-form";

const COPY: ContactFormCopy = {
  submitLabel: "PROTOTYPE submit",
  submittingLabel: "PROTOTYPE submitting",
  sentTitle: "PROTOTYPE sent title",
  sentBody: "PROTOTYPE sent body",
  errorTitle: "PROTOTYPE error title",
  errorBody: "PROTOTYPE error body",
  invalidTitle: "PROTOTYPE invalid title",
  invalidBody: "PROTOTYPE invalid body",
};

const FILLED = {
  [ContactFormField.FirstName]: "Ada",
  [ContactFormField.LastName]: "Lovelace",
  [ContactFormField.Email]: "ada@example.com",
  [ContactFormField.Company]: "Analytical Engines",
  [ContactFormField.EngineerCount]: "12",
  [ContactFormField.Message]: "We would like a demo.",
} as const;

const fillEveryField = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.type(screen.getByLabelText("First name"), FILLED.firstName);
  await user.type(screen.getByLabelText("Last name"), FILLED.lastName);
  await user.type(screen.getByLabelText("Email"), FILLED.email);
  await user.type(screen.getByLabelText("Company"), FILLED.company);
  await user.type(
    screen.getByLabelText("Number of engineers"),
    FILLED.engineerCount
  );
  await user.type(screen.getByLabelText("Message"), FILLED.message);
};

describe("ContactForm", () => {
  it("carries every collected field through to the submission payload", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(submission: ContactFormSubmission) => void>();
    render(<ContactForm copy={COPY} onSubmit={onSubmit} />);

    await fillEveryField(user);
    await user.click(screen.getByRole("button", { name: COPY.submitLabel }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    // Every field the form offers reaches the payload — apps/prototypes
    // AGENTS.md: "carry every collected field through to the payload or do not
    // offer the field". engineerCount is a NUMBER here, coerced at the parse
    // boundary, while the input stays a string.
    expect(onSubmit).toHaveBeenCalledWith({
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
      company: "Analytical Engines",
      engineerCount: 12,
      message: "We would like a demo.",
    });
  });

  it("does not submit, and flags the field, when the email is malformed", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ContactForm copy={COPY} onSubmit={onSubmit} />);

    await fillEveryField(user);
    await user.clear(screen.getByLabelText("Email"));
    await user.type(screen.getByLabelText("Email"), "not-an-email");
    await user.click(screen.getByRole("button", { name: COPY.submitLabel }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(await screen.findByText(COPY.invalidTitle)).toBeVisible();
    expect(screen.getByLabelText("Email")).toHaveAttribute(
      "aria-invalid",
      "true"
    );
  });

  it("rejects a non-whole engineer count rather than coercing it", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ContactForm copy={COPY} onSubmit={onSubmit} />);

    await fillEveryField(user);
    await user.clear(screen.getByLabelText("Number of engineers"));
    await user.type(screen.getByLabelText("Number of engineers"), "3.5");
    await user.click(screen.getByRole("button", { name: COPY.submitLabel }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Number of engineers")).toHaveAttribute(
      "aria-invalid",
      "true"
    );
  });

  it("reports a failed send instead of claiming success", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockRejectedValue(new Error("resend down"));
    render(<ContactForm copy={COPY} onSubmit={onSubmit} />);

    await fillEveryField(user);
    await user.click(screen.getByRole("button", { name: COPY.submitLabel }));

    expect(await screen.findByText(COPY.errorTitle)).toBeVisible();
    // Counterfactual anchor: the success panel must NOT be what a rejected
    // send renders. Located through the copy prop, never a literal.
    expect(screen.queryByText(COPY.sentTitle)).toBeNull();
  });

  it("confirms only after the send resolves", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<ContactForm copy={COPY} onSubmit={onSubmit} />);

    await fillEveryField(user);
    await user.click(screen.getByRole("button", { name: COPY.submitLabel }));

    expect(await screen.findByText(COPY.sentTitle)).toBeVisible();
    expect(screen.queryByText(COPY.errorTitle)).toBeNull();
  });
});
