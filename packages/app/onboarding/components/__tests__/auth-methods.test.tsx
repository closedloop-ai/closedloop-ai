import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AuthMethods } from "../auth-methods";

const GITHUB_BUTTON = /continue with github/i;
const GOOGLE_BUTTON = /continue with google/i;
const EMAIL_INPUT = /email address/i;
const EMAIL_SUBMIT = /create account with email/i;
const EMAIL_DEFAULT_SUBMIT = /continue with email/i;

describe("AuthMethods", () => {
  // ISS-5954: the method set is a fixed contract — GitHub, Google, AND email,
  // asserted together so a panel that failed to mount cannot pass. The per-host
  // `showEmail` opt-out is deliberately retired; there is no fork left to test.
  it("always offers all three methods together — GitHub primary, Google, email", () => {
    render(<AuthMethods onSelect={vi.fn()} />);
    const github = screen.getByRole("button", { name: GITHUB_BUTTON });
    const google = screen.getByRole("button", { name: GOOGLE_BUTTON });
    expect(github).toBeInTheDocument();
    expect(google).toBeInTheDocument();
    expect(screen.getByLabelText(EMAIL_INPUT)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: EMAIL_DEFAULT_SUBMIT })
    ).toBeInTheDocument();
    // GitHub renders before Google in document order (GitHub-first hierarchy).
    const buttons = screen.getAllByRole("button");
    expect(buttons.indexOf(github)).toBeLessThan(buttons.indexOf(google));
  });

  it("calls onSelect('github') when GitHub is chosen", () => {
    const onSelect = vi.fn();
    render(<AuthMethods onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: GITHUB_BUTTON }));
    expect(onSelect).toHaveBeenCalledWith("github");
  });

  it("calls onSelect('email', value) when the email form is submitted", () => {
    const onSelect = vi.fn();
    render(
      <AuthMethods
        emailCtaLabel="Create account with email"
        onSelect={onSelect}
      />
    );
    fireEvent.change(screen.getByLabelText(EMAIL_INPUT), {
      target: { value: "dev@company.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: EMAIL_SUBMIT }));
    expect(onSelect).toHaveBeenCalledWith("email", "dev@company.com");
  });

  // The full set stays on screen while a pick is in flight — the actions
  // disable, they never disappear. Guards the ISS-5954 invariant on the state
  // the retired `showEmail` fork tests exercised: no render path trims the set.
  it("keeps all three methods present, disabled, while a method is pending", () => {
    render(
      <AuthMethods
        emailCtaLabel="Create account with email"
        onSelect={vi.fn()}
        pendingMethod="github"
      />
    );
    expect(screen.getByRole("button", { name: GITHUB_BUTTON })).toBeDisabled();
    expect(screen.getByRole("button", { name: GOOGLE_BUTTON })).toBeDisabled();
    expect(screen.getByLabelText(EMAIL_INPUT)).toBeDisabled();
    expect(screen.getByRole("button", { name: EMAIL_SUBMIT })).toBeDisabled();
  });

  it("calls onSelect('google') when Google is chosen", () => {
    const onSelect = vi.fn();
    render(<AuthMethods onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: GOOGLE_BUTTON }));
    expect(onSelect).toHaveBeenCalledWith("google");
  });

  it("keeps the email submit disabled until a non-blank address is entered", () => {
    render(
      <AuthMethods
        emailCtaLabel="Create account with email"
        onSelect={vi.fn()}
      />
    );
    const submit = screen.getByRole("button", { name: EMAIL_SUBMIT });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText(EMAIL_INPUT), {
      target: { value: "   " },
    });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText(EMAIL_INPUT), {
      target: { value: "dev@company.com" },
    });
    expect(submit).toBeEnabled();
  });

  it("trims the email and submits on form submit (Enter)", () => {
    const onSelect = vi.fn();
    const { container } = render(<AuthMethods onSelect={onSelect} />);
    fireEvent.change(screen.getByLabelText(EMAIL_INPUT), {
      target: { value: "  dev@company.com  " },
    });
    const form = container.querySelector("form");
    if (!form) {
      throw new Error("expected the email form to render");
    }
    fireEvent.submit(form);
    expect(onSelect).toHaveBeenCalledWith("email", "dev@company.com");
  });

  // ISS-5954 M4 retired the `nativeAction` / `nativeMethod` /
  // `nativeEmailInputName` props — residue of a web host that no longer exists
  // (no production caller ever passed them). The email form is a plain
  // controlled form: no native target, ever.
  it("renders the email form with no native form attributes", () => {
    const { container } = render(<AuthMethods onSelect={vi.fn()} />);
    const form = container.querySelector("form");
    expect(form).not.toHaveAttribute("action");
    expect(form).not.toHaveAttribute("method");
    expect(screen.getByLabelText(EMAIL_INPUT)).not.toHaveAttribute("name");
  });
});
