import {
  GitHubMark,
  GoogleGlyph,
} from "@repo/design-system/components/ui/brand-icons";
import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { Separator } from "@repo/design-system/components/ui/separator";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * The unauthenticated sign-in screen.
 *
 * Production renders Clerk's hosted `<SignIn>` embed
 * (`@repo/auth/components/sign-in`), which cannot mount here without a live
 * Clerk instance. This mirrors the canonical layout that embed is themed to
 * reproduce: the GitHub-first hierarchy in
 * `packages/auth/components/appearance.ts` (FEA-4059, PRD-532 M7), whose own
 * source of truth is the prototype at `apps/prototypes/app/p/sign-in`.
 *
 * The hierarchy is the point, so it is worth stating: GitHub is the single
 * filled call to action and sits ALONE above the divider. Everything below the
 * divider is the de-emphasized alternatives bucket, Google as an outline button
 * and the email path with a secondary submit, so neither reads as a peer of
 * GitHub. Getting the emphasis wrong here is the difference between a screen
 * that recommends a path and one that offers three equal ones.
 *
 * Two things Clerk renders that this does not: the "Last used" badge on
 * whichever provider you signed in with before, and the physical ordering of
 * the social buttons, which is a Clerk Dashboard setting and out of code scope.
 */

// Copy mirrors `apps/prototypes/app/p/sign-in/mock.ts`, which is what the live
// screen shows.
const LOGIN_COPY = {
  heading: "Welcome to Closedloop",
  emailLabel: "Email address",
  emailPlaceholder: "Enter your email address",
  continueLabel: "Continue",
  signUpPrompt: "Don't have an account?",
  signUpCta: "Sign up",
} as const;

type LoginScreenProps = {
  /** Card heading. */
  heading?: string;
  /** Label above the email field. */
  emailLabel?: string;
  /** Placeholder inside the email field. */
  emailPlaceholder?: string;
  /** Label on the secondary email submit. */
  continueLabel?: string;
  /** Show the Google fallback below the divider. */
  showGoogle?: boolean;
  /** Show the email path below the divider. */
  showEmail?: boolean;
  /**
   * Show the Privacy and Terms chrome. Deliberately non-interactive in the
   * prototype: there is no privacy or terms route yet, and a link that looks
   * clickable and goes nowhere is the thing that sandbox exists to catch.
   */
  showFooter?: boolean;
  /** Disable every control, the state while a submission is in flight. */
  pending?: boolean;
};

const OrDivider = () => (
  <div className="flex items-center gap-3">
    <Separator className="flex-1" />
    <span className="text-muted-foreground text-xs">or</span>
    <Separator className="flex-1" />
  </div>
);

const LoginScreen = ({
  continueLabel = LOGIN_COPY.continueLabel,
  emailLabel = LOGIN_COPY.emailLabel,
  emailPlaceholder = LOGIN_COPY.emailPlaceholder,
  heading = LOGIN_COPY.heading,
  pending = false,
  showEmail = true,
  showFooter = true,
  showGoogle = true,
}: LoginScreenProps) => {
  const hasAlternatives = showGoogle || showEmail;

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-6">
      <div className="w-full max-w-sm">
        <h1 className="text-center font-semibold text-2xl">{heading}</h1>

        {/* GitHub is the single filled call to action, alone above the divider
            so it reads as the one recommended way in. */}
        <div className="mt-8">
          <Button className="w-full" disabled={pending} size="lg">
            <GitHubMark className="size-4" />
            Continue with GitHub
          </Button>
        </div>

        {hasAlternatives ? (
          <div className="my-6">
            <OrDivider />
          </div>
        ) : null}

        {/* Everything below the divider is the de-emphasized bucket. */}
        <div className="flex flex-col gap-4">
          {showGoogle ? (
            <Button
              className="w-full"
              disabled={pending}
              size="lg"
              variant="outline"
            >
              <GoogleGlyph className="size-4" />
              Continue with Google
            </Button>
          ) : null}

          {showEmail ? (
            <>
              <div className="flex flex-col gap-2">
                <Label htmlFor="login-email">{emailLabel}</Label>
                <Input
                  autoComplete="email"
                  disabled={pending}
                  id="login-email"
                  placeholder={emailPlaceholder}
                  type="email"
                />
              </div>

              {/* Secondary, so the email path never competes with GitHub. */}
              <Button
                className="w-full"
                disabled={pending}
                size="lg"
                variant="secondary"
              >
                {continueLabel}
              </Button>
            </>
          ) : null}
        </div>

        <p className="mt-6 text-center text-muted-foreground text-sm">
          {LOGIN_COPY.signUpPrompt}{" "}
          {/* The prototype this mirrors overrides `variant="link"` to
              `text-foreground`, because the design wants a foreground-toned
              inline link and Button's only link variant is `text-primary`.
              Recoloring a variant at the call site is the thing
              screens-respect-design-system.test.ts forbids, so this uses the
              variant as it ships. The divergence is real and the fix belongs on
              Button, as a link variant that carries the foreground tone. */}
          <Button
            className="h-auto p-0 align-baseline font-medium"
            variant="link"
          >
            {LOGIN_COPY.signUpCta}
          </Button>
        </p>

        {showFooter ? (
          <div className="mt-8 flex items-center justify-center gap-4 text-muted-foreground text-xs">
            <span>Privacy</span>
            <span>Terms</span>
          </div>
        ) : null}
      </div>
    </div>
  );
};

const meta = {
  title: "Screens/Login",
  component: LoginScreen,
  tags: ["autodocs"],
  argTypes: {
    heading: { control: "text", table: { category: "Content" } },
    emailLabel: { control: "text", table: { category: "Content" } },
    emailPlaceholder: { control: "text", table: { category: "Content" } },
    continueLabel: { control: "text", table: { category: "Content" } },
    showGoogle: {
      control: "boolean",
      description: "The Google fallback below the divider.",
      table: { category: "Composition" },
    },
    showEmail: {
      control: "boolean",
      description:
        "The email path below the divider. Off leaves GitHub as the only way in.",
      table: { category: "Composition" },
    },
    showFooter: {
      control: "boolean",
      description: "Privacy and Terms chrome. Not interactive by design.",
      table: { category: "Composition" },
    },
    pending: {
      control: "boolean",
      description: "Everything disabled, as while a submission is in flight.",
      table: { category: "State" },
    },
  },
  args: {
    heading: LOGIN_COPY.heading,
    emailLabel: LOGIN_COPY.emailLabel,
    emailPlaceholder: LOGIN_COPY.emailPlaceholder,
    continueLabel: LOGIN_COPY.continueLabel,
    showGoogle: true,
    showEmail: true,
    showFooter: true,
    pending: false,
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof LoginScreen>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** GitHub only, the state when no other provider is enabled for the org. */
export const GitHubOnly: Story = {
  args: { showEmail: false, showGoogle: false },
};

/** Submission in flight. */
export const Pending: Story = {
  args: { pending: true },
};
