import { AuthMethods } from "@repo/app/onboarding/components/auth-methods";
import { Button } from "@repo/design-system/components/ui/button";
import type { Meta, StoryObj } from "@storybook/react";
import Image from "next/image";
import { fn } from "storybook/test";

/**
 * The unauthenticated sign-in screen, as a whole page.
 *
 * Two things this composes, because neither can mount here directly:
 *
 * The PAGE CHROME is `apps/app/app/(unauthenticated)/layout.tsx`, a two
 * column grid with the wordmark over a centered card on the left, and the
 * product screenshot on the brand gradient on the right, hidden below `lg`.
 * That layout imports `@/env` and the app's navigation Link, neither of which
 * resolve from Storybook, so the structure is reproduced here against the
 * same real assets (`/logo.svg`, `/logo-dark.svg`, `/CL-SS3.png`,
 * `var(--brand-gradient)`) that the app serves.
 *
 * The METHOD PICKER inside the card is the real `AuthMethods` component
 * (`packages/app/onboarding/components/auth-methods.tsx`), the same one
 * `apps/desktop`'s onboarding flow and Settings to Account mount, not a
 * hand-drawn lookalike. It owns the GitHub-first hierarchy from PRD-532
 * section 5.2: GitHub is the single filled call to action, Google is an
 * outline fallback, and the email submit is secondary, along with its own
 * busy and disabled state. The real `/sign-in` route
 * (`apps/app/app/(unauthenticated)/sign-in/[[...sign-in]]/page.tsx`) mounts
 * Clerk's hosted `<SignIn>` instead, themed by `githubFirstAuthPageAppearance`
 * (FEA-4059, PRD-532 M7) to that same hierarchy, but that embed needs a live
 * Clerk instance and cannot render in Storybook. `AuthMethods` is the real,
 * storybook-mountable stand in for it: the same contract, shipped elsewhere in
 * the product, not invented for this story. Because it is the real component,
 * it does not support hiding Google on its own (only GitHub plus Google, or
 * GitHub, Google and email), so no "GitHub only" state is offered here.
 *
 * What stays hand-built, because no shared component covers it: the heading,
 * the "Don't have an account? Sign up" footer prompt (Clerk renders that
 * itself inside the embed, so no separate exported component exists for it),
 * and the Privacy and Terms chrome, which is deliberately non-interactive
 * since there is no privacy or terms route yet, and a link that looks
 * clickable and goes nowhere is the thing the prototype sandbox exists to
 * catch.
 *
 * Two things the real page shows that this cannot: Clerk's "Last used" badge
 * on whichever provider you signed in with before, and the physical
 * top-to-bottom ordering of the social buttons, which is a Clerk Dashboard
 * setting and explicitly out of code scope. So a screenshot of production may
 * show Google above GitHub while this shows GitHub first; the emphasis is
 * what is designed, the order is not.
 */

// Copy mirrors `apps/prototypes/app/p/sign-in/mock.ts`, the design source the
// Clerk appearance is themed to reproduce. `emailCtaLabel` is the real
// `AuthMethods` prop name, kept as is rather than renamed for this story.
const LOGIN_COPY = {
  heading: "Welcome to Closedloop",
  emailCtaLabel: "Continue with email",
  signUpPrompt: "Don't have an account?",
  signUpCta: "Sign up",
} as const;

type LoginScreenProps = {
  /** Card heading. */
  heading?: string;
  /** Label on the email path's secondary submit, AuthMethods' own copy prop. */
  emailCtaLabel?: string;
  /**
   * The email path below the divider, the real AuthMethods prop. Off leaves
   * GitHub and Google as the only ways in.
   */
  showEmail?: boolean;
  /**
   * Show the Privacy and Terms chrome. Deliberately non-interactive: there is
   * no privacy or terms route yet, and a link that looks clickable and goes
   * nowhere is the thing the prototype sandbox exists to catch.
   */
  showFooter?: boolean;
  /**
   * Disable every control, the state while a submission is in flight. Drives
   * AuthMethods' own `pendingMethod`, so GitHub shows the spinner and every
   * action disables the same way the real flow does.
   */
  pending?: boolean;
  /**
   * Render the right-hand gradient panel. The real layout hides it below the
   * `lg` breakpoint, so turning it off is the mobile and tablet arrangement.
   */
  showShowcase?: boolean;
};

const SignInCard = ({
  emailCtaLabel,
  heading,
  pending,
  showEmail,
  showFooter,
}: Required<Omit<LoginScreenProps, "showShowcase">>) => (
  <div className="w-full">
    <h1 className="text-center font-semibold text-2xl">{heading}</h1>

    {/* The real AuthMethods component: GitHub is the single filled call to
        action, Google is an outline fallback below its own divider, and email
        is a secondary Continue, all owned by the component itself rather than
        re-implemented here. */}
    <div className="mt-8">
      <AuthMethods
        emailCtaLabel={emailCtaLabel}
        onSelect={fn()}
        pendingMethod={pending ? "github" : null}
        showEmail={showEmail}
      />
    </div>

    {/* Clerk renders this footer link itself inside the hosted embed; there is
        no separate exported component for it, so it stays hand-built. */}
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

const LoginScreen = ({
  emailCtaLabel = LOGIN_COPY.emailCtaLabel,
  heading = LOGIN_COPY.heading,
  pending = false,
  showEmail = true,
  showFooter = true,
  showShowcase = true,
}: LoginScreenProps) => (
  <main className="relative grid min-h-dvh lg:grid-cols-2">
    {/* Left: wordmark pinned top-left, card centered in the remaining height.
        Hand-built: the real chrome lives in
        apps/app/app/(unauthenticated)/layout.tsx, which imports `@/env` and
        the app's navigation Link, neither of which resolve from Storybook. */}
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
            emailCtaLabel={emailCtaLabel}
            heading={heading}
            pending={pending}
            showEmail={showEmail}
            showFooter={showFooter}
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
    emailCtaLabel: { control: "text", table: { category: "Content" } },
    showEmail: {
      control: "boolean",
      description:
        "The email path below the divider, the real AuthMethods prop. Off leaves GitHub and Google as the only ways in.",
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
      description:
        "Everything disabled, AuthMethods' own pendingMethod state while a submission is in flight.",
      table: { category: "State" },
    },
  },
  args: {
    heading: LOGIN_COPY.heading,
    emailCtaLabel: LOGIN_COPY.emailCtaLabel,
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

/**
 * The trimmed panel AuthMethods offers its other hosts, ISS-5112's desktop
 * onboarding and Settings to Account: GitHub and Google only. The web
 * sign-in route always ships the email path, so this exact state does not
 * occur on `/sign-in` today, but it is a real state of the composed
 * component and worth seeing here rather than nowhere.
 */
export const NoEmailPath: Story = {
  name: "No email path",
  args: { showEmail: false },
};

/** Submission in flight. */
export const Pending: Story = {
  args: { pending: true },
};
