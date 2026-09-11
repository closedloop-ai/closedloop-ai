import {
  GitHubMark,
  GoogleGlyph,
} from "@repo/design-system/components/ui/brand-icons";
import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { Separator } from "@repo/design-system/components/ui/separator";
import type { Meta, StoryObj } from "@storybook/react";
import Image from "next/image";

/**
 * The unauthenticated sign-in screen, as a whole page.
 *
 * Two things this composes, because neither can mount here directly:
 *
 * The PAGE CHROME is `apps/app/app/(unauthenticated)/layout.tsx` — a two column
 * grid with the wordmark over a centered card on the left, and the product
 * screenshot on the brand gradient on the right, hidden below `lg`. That layout
 * imports `@/env` and the app's navigation Link, neither of which resolve from
 * Storybook, so the structure is reproduced here against the same real assets
 * (`/logo.svg`, `/logo-dark.svg`, `/CL-SS3.png`, `var(--brand-gradient)`) that
 * the app serves.
 *
 * The CARD is Clerk's hosted `<SignIn>` embed, themed by
 * `githubFirstAuthPageAppearance` (FEA-4059, PRD-532 M7), which needs a live
 * Clerk instance. The hierarchy that appearance encodes is the point and is
 * reproduced faithfully: GitHub is the single filled call to action, Google is
 * an outline fallback, and the email submit is `secondary` so the email path
 * never competes with GitHub.
 *
 * Two things the real page shows that this cannot: Clerk's "Last used" badge on
 * whichever provider you signed in with before, and the physical top-to-bottom
 * ordering of the social buttons, which is a Clerk Dashboard setting and
 * explicitly out of code scope. So a screenshot of production may show Google
 * above GitHub while this shows GitHub first; the emphasis is what is designed,
 * the order is not.
 */

// Copy mirrors `apps/prototypes/app/p/sign-in/mock.ts`, the design source the
// Clerk appearance is themed to reproduce.
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
   * Show the Privacy and Terms chrome. Deliberately non-interactive: there is
   * no privacy or terms route yet, and a link that looks clickable and goes
   * nowhere is the thing the prototype sandbox exists to catch.
   */
  showFooter?: boolean;
  /** Disable every control, the state while a submission is in flight. */
  pending?: boolean;
  /**
   * Render the right-hand gradient panel. The real layout hides it below the
   * `lg` breakpoint, so turning it off is the mobile and tablet arrangement.
   */
  showShowcase?: boolean;
};

const OrDivider = () => (
  <div className="flex items-center gap-3">
    <Separator className="flex-1" />
    <span className="text-muted-foreground text-xs">or</span>
    <Separator className="flex-1" />
  </div>
);

const SignInCard = ({
  continueLabel,
  emailLabel,
  emailPlaceholder,
  heading,
  pending,
  showEmail,
  showFooter,
  showGoogle,
}: Required<Omit<LoginScreenProps, "showShowcase">>) => {
  const hasAlternatives = showGoogle || showEmail;

  return (
    <div className="w-full">
      <h1 className="text-center font-semibold text-2xl">{heading}</h1>

      {/* GitHub is the single filled call to action, alone above the divider so
          it reads as the one recommended way in. */}
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
        <Button
          className="h-auto p-0 align-baseline font-medium"
          variant="linkForeground"
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
  );
};

const LoginScreen = ({
  continueLabel = LOGIN_COPY.continueLabel,
  emailLabel = LOGIN_COPY.emailLabel,
  emailPlaceholder = LOGIN_COPY.emailPlaceholder,
  heading = LOGIN_COPY.heading,
  pending = false,
  showEmail = true,
  showFooter = true,
  showGoogle = true,
  showShowcase = true,
}: LoginScreenProps) => (
  <main className="relative grid min-h-dvh lg:grid-cols-2">
    {/* Left: wordmark pinned top-left, card centered in the remaining height. */}
    <div className="flex min-h-dvh flex-col overflow-y-auto px-6 py-10 lg:px-10">
      <span className="inline-flex self-start">
        {/* Two files, one per theme, exactly as the layout serves them. */}
        <Image
          alt="Closedloop logo"
          className="dark:hidden"
          height={30}
          src="/logo.svg"
          width={200}
        />
        <Image
          alt="Closedloop logo"
          className="hidden dark:block"
          height={30}
          src="/logo-dark.svg"
          width={200}
        />
      </span>

      <div className="flex flex-1 items-center justify-center py-8">
        <div className="w-full max-w-sm">
          <SignInCard
            continueLabel={continueLabel}
            emailLabel={emailLabel}
            emailPlaceholder={emailPlaceholder}
            heading={heading}
            pending={pending}
            showEmail={showEmail}
            showFooter={showFooter}
            showGoogle={showGoogle}
          />
        </div>
      </div>
    </div>

    {/* Right: near full-bleed gradient panel, a slim gutter, art flush right. */}
    {showShowcase ? (
      <div className="hidden h-full p-3 lg:block">
        <div
          className="flex h-full w-full items-center justify-end overflow-hidden rounded-2xl pl-12"
          style={{ background: "var(--brand-gradient)" }}
        >
          <Image
            alt="Closedloop product screenshot"
            className="max-h-full w-auto object-contain"
            height={1191}
            priority
            src="/CL-SS3.png"
            width={1060}
          />
        </div>
      </div>
    ) : null}
  </main>
);

/**
 * The full sign-in screen showing GitHub as the one primary path in, with
 * Google and email deliberately secondary, rather than just the sign-in card
 * on its own.
 */
const meta = {
  title: "Surfaces/Login",
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
    showShowcase: {
      control: "boolean",
      description:
        "The gradient panel. The real layout hides it below lg, so off is the mobile arrangement.",
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
    showShowcase: true,
    pending: false,
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof LoginScreen>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** Below `lg`, where the layout drops the showcase panel. */
export const Narrow: Story = {
  name: "Narrow (no showcase)",
  args: { showShowcase: false },
  parameters: { viewport: { defaultViewport: "md" } },
};

/** GitHub only, the state when no other provider is enabled for the org. */
export const GitHubOnly: Story = {
  name: "GitHub only",
  args: { showEmail: false, showGoogle: false },
};

/** Submission in flight. */
export const Pending: Story = {
  args: { pending: true },
};
