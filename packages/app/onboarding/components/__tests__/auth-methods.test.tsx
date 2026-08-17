import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AuthMethods } from "../auth-methods";

const GITHUB_BUTTON = /continue with github/i;
const GOOGLE_BUTTON = /continue with google/i;
const EMAIL_INPUT = /email address/i;
const EMAIL_SUBMIT = /create account with email/i;

describe("AuthMethods", () => {
  it("presents GitHub as the single primary, with Google and email below", () => {
    render(<AuthMethods onSelect={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: GITHUB_BUTTON })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: GOOGLE_BUTTON })
    ).toBeInTheDocument();
    expect(screen.getByLabelText(EMAIL_INPUT)).toBeInTheDocument();
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

  // ISS-5112 added this fork and nothing pinned either side of it at the
  // component that owns it: the hosts that pass `false` assert it, but the
  // DEFAULT — what `desktop-account-tab` and the first-launch overlay ship —
  // was only ever covered incidentally by tests aimed at something else.
  it("offers the email form by default, so a host must opt out deliberately", () => {
    render(<AuthMethods onSelect={vi.fn()} />);
    expect(screen.getByLabelText(EMAIL_INPUT)).toBeInTheDocument();
  });

  it("drops the whole email form, input included, when showEmail is false", () => {
    render(<AuthMethods onSelect={vi.fn()} showEmail={false} />);

    expect(screen.queryByLabelText(EMAIL_INPUT)).not.toBeInTheDocument();
    // Non-vacuous: the panel rendered, it just offers two methods now.
    expect(
      screen.getByRole("button", { name: GITHUB_BUTTON })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: GOOGLE_BUTTON })
    ).toBeInTheDocument();
  });

  it("disables the actions while a method is pending", () => {
    render(<AuthMethods onSelect={vi.fn()} pendingMethod="github" />);
    expect(screen.getByRole("button", { name: GITHUB_BUTTON })).toBeDisabled();
    expect(screen.getByRole("button", { name: GOOGLE_BUTTON })).toBeDisabled();
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

  it("threads adapter-owned native form attributes onto the form and email input", () => {
    const { container } = render(
      <AuthMethods
        nativeAction="/sign-in/email"
        nativeEmailInputName="email_address"
        nativeMethod="post"
        onSelect={vi.fn()}
      />
    );
    const form = container.querySelector("form");
    expect(form).toHaveAttribute("action", "/sign-in/email");
    expect(form).toHaveAttribute("method", "post");
    expect(screen.getByLabelText(EMAIL_INPUT)).toHaveAttribute(
      "name",
      "email_address"
    );
  });

  it("omits native form attributes when the adapter supplies none (desktop)", () => {
    const { container } = render(<AuthMethods onSelect={vi.fn()} />);
    const form = container.querySelector("form");
    expect(form).not.toHaveAttribute("action");
    expect(form).not.toHaveAttribute("method");
    expect(screen.getByLabelText(EMAIL_INPUT)).not.toHaveAttribute("name");
  });
});
