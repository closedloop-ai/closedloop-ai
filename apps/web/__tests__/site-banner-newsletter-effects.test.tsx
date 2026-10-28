// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { NewsletterForm } from "@/app/[locale]/(site)/components/home/newsletter-form";
import { SiteBanner } from "@/app/[locale]/components/site-banner";

// Both components branch on state an effect or an event sets, which a
// `react-dom/server` render never runs — hence jsdom for this file only.

const BANNER_STORAGE_KEY = "site-banner:healthy:dismissed";
const DISMISS_LABEL = "Dismiss banner";
const EMAIL_LABEL = "Email address";
const THANKS_TEXT = /we.ll be in touch/;
// Only the exact string "true" dismisses; every other stored value shows it.
const NON_DISMISSED_VALUES = ["false", "", "TRUE", "True", "1", " true", "yes"];

afterEach(() => {
  cleanup();
  globalThis.localStorage.clear();
});

describe("SiteBanner", () => {
  test("renders when the dismissal key is absent", () => {
    render(<SiteBanner />);

    expect(screen.getByRole("button", { name: DISMISS_LABEL })).toBeTruthy();
  });

  test("stays hidden when the dismissal key is stored as 'true'", () => {
    globalThis.localStorage.setItem(BANNER_STORAGE_KEY, "true");

    const { container } = render(<SiteBanner />);

    expect(screen.queryByRole("button", { name: DISMISS_LABEL })).toBeNull();
    expect(container.innerHTML).toBe("");
  });

  test.each(NON_DISMISSED_VALUES)(
    "renders when the stored value is %j",
    (stored) => {
      globalThis.localStorage.setItem(BANNER_STORAGE_KEY, stored);

      render(<SiteBanner />);

      expect(screen.getByRole("button", { name: DISMISS_LABEL })).toBeTruthy();
    }
  );

  test("dismissing hides the banner and persists the key", () => {
    render(<SiteBanner />);

    fireEvent.click(screen.getByRole("button", { name: DISMISS_LABEL }));

    expect(screen.queryByRole("button", { name: DISMISS_LABEL })).toBeNull();
    expect(globalThis.localStorage.getItem(BANNER_STORAGE_KEY)).toBe("true");
  });
});

describe("NewsletterForm", () => {
  test("submitting with an empty email keeps the form and shows no confirmation", () => {
    render(<NewsletterForm />);

    fireEvent.submit(screen.getByRole("textbox", { name: EMAIL_LABEL }));

    expect(screen.getByRole("textbox", { name: EMAIL_LABEL })).toBeTruthy();
    expect(screen.queryByText(THANKS_TEXT)).toBeNull();
  });

  test("submitting with an email replaces the form with the confirmation", () => {
    render(<NewsletterForm />);
    const input = screen.getByRole("textbox", { name: EMAIL_LABEL });

    fireEvent.change(input, { target: { value: "reader@example.com" } });
    fireEvent.submit(input);

    expect(screen.getByText(THANKS_TEXT)).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: EMAIL_LABEL })).toBeNull();
  });
});
