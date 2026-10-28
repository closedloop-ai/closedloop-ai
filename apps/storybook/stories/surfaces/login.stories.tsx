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
 * That layout imports `@/env` and the app's navigation `Link`, neither of
 * which resolve from Storybook, so the structure is reproduced here against
 * the same real assets (`/logo.svg`, `/logo-dark.svg`, `/sign-in-screenshot.png`,
 * `var(--brand-gradient)`) that the app serves — verified byte-for-byte
 * against the current layout's class names before this was written, not
 * assumed from an older reference.
 *
 * The METHOD PICKER inside the card is the real `AuthMethods` component
 * (`packages/app/onboarding/components/auth-methods.tsx`), the same one
 * `apps/desktop`'s onboarding flow mounts, not a hand-drawn lookalike. It owns the GitHub-first hierarchy
 * (`githubFirstAuthPageAppearance`, applied to the real Clerk embed too):
 * GitHub is the single filled call to action, Google is an outline
 * fallback, and email is a secondary Continue, along with its own busy and
 * disabled state. The real `/sign-in` route
 * (`apps/app/app/(unauthenticated)/sign-in/[[...sign-in]]/page.tsx`) mounts
 * Clerk's hosted `<SignIn>` instead, themed to that same hierarchy, but that
 * embed needs a live Clerk instance and cannot render in Storybook.
 * `AuthMethods` is the real, storybook-mountable stand-in for it.
 *
 * ISS-5954 retired this component's `showEmail` opt-out on purpose — a
 * capability prop that doesn't exist can't let a host drift into offering a
 * different set of methods, which is exactly how desktop's onboarding and
 * this web flow disagreed before. So the method set here is fixed: GitHub,
 * Google and email, always. There is no "GitHub and Google only" state to
 * show.
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
  showFooter,
}: Required<Omit<LoginScreenProps, "showShowcase">>) => (
  <div className="w-full">
    <h1 className="text-center font-semibold text-2xl">{heading}</h1>

    {/* The real AuthMethods component: GitHub is the single filled call to
        action, Google is an outline fallback below its own divider, and email
        is a secondary Continue, all owned by the component itself rather than
        re-implemented here. The method set is fixed (ISS-5954) — there is no
        prop to hide any one of them. */}
    <div className="mt-8">
      <AuthMethods
        emailCtaLabel={emailCtaLabel}
        onSelect={fn()}
        pendingMethod={pending ? "github" : null}
      />
    </div>

    {/* Clerk renders this footer link itself inside the hosted embed; there is
        no separate exported component for it, so it stays hand-built. */}
    <p className="mt-6 text-center text-muted-foreground text-sm">
      {LOGIN_COPY.signUpPrompt}{" "}
      <Button
        asChild
        className="h-auto p-0 align-baseline font-medium"
        variant="linkForeground"
      >
        {/* Real destination, not a dead link-styled button. `/sign-up` is the
            route the unauthenticated layout serves; a plain anchor because
            Storybook has no Next router and `@repo/navigation/link` is scoped
            to apps/app, packages/app and the desktop renderer. */}
        <a href="/sign-up">{LOGIN_COPY.signUpCta}</a>
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
        {/* Two files, one per theme, exactly as the layout serves them. The
            `/app-public` prefix is this Storybook's mount of `apps/app/public`
            (see `staticDirs` in .storybook/main.ts) — the app itself serves
            these from the root. */}
        <Image
          alt="Closedloop logo"
          className="dark:hidden"
          height={30}
          src="/app-public/logo.svg"
          width={200}
        />
        <Image
          alt="Closedloop logo"
          className="hidden dark:block"
          height={30}
          src="/app-public/logo-dark.svg"
          width={200}
        />
      </span>

      <div className="flex flex-1 items-center justify-center py-8">
        <div className="w-full max-w-sm">
          <SignInCard
            emailCtaLabel={emailCtaLabel}
            heading={heading}
            pending={pending}
            showFooter={showFooter}
          />
        </div>
      </div>
    </div>

    {/* Right: near full-bleed gradient panel, a slim gutter, art flush right. */}
    {showShowcase ? (
      <div className="hidden h-full p-3 lg:block">
        <div
          className="flex h-full w-full items-end justify-end overflow-hidden rounded-2xl pl-12"
          style={{ background: "var(--brand-gradient)" }}
        >
          <Image
            alt="Closedloop product screenshot"
            className="max-h-full w-auto object-contain"
            height={920}
            priority
            src="/app-public/sign-in-screenshot.png"
            width={993}
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
  title: "Surfaces v1.0/Login",
  component: LoginScreen,
  tags: ["deprecated", "autodocs"],
  argTypes: {
    heading: { control: "text", table: { category: "Content" } },
    emailCtaLabel: { control: "text", table: { category: "Content" } },
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
    showFooter: true,
    showShowcase: true,
    pending: false,
  },
  parameters: {
    layout: "fullscreen",
    // A fullscreen Surface, inlined into the Docs page's own prose-width
    // column, squeezes real components into far less width than they ever
    // get in the product. `inline: false`
    // renders the Docs preview in its own full-width iframe instead, the
    // documented Storybook fix for exactly this mismatch.
    docs: { story: { inline: false, iframeHeight: 900 } },
  },
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

/** Submission in flight. */
export const Pending: Story = {
  args: { pending: true },
};
