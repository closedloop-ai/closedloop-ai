// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { NewsletterForm } from "@/app/[locale]/(site)/components/home/newsletter-form";

const SUBMITTED_EMAIL = "visitor@example.com";

afterEach(() => {
  cleanup();
});

/**
 * ISS-12558: marketing session replay masks form INPUTS only
 * (`maskAllInputs`); rendered page text is recorded. This pins only
 * `NewsletterForm`: it must never echo what a visitor typed into the page
 * text, or the replay would carry it unmasked.
 */
describe("the newsletter form under session replay", () => {
  test("does not render the submitted email as page text", () => {
    const { container } = render(<NewsletterForm />);

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: SUBMITTED_EMAIL },
    });
    fireEvent.click(screen.getByRole("button"));

    expect(container.querySelector("form")).toBeNull();
    expect(container.textContent).not.toContain(SUBMITTED_EMAIL);
  });
});
