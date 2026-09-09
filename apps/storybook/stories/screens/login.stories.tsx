import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { Separator } from "@repo/design-system/components/ui/separator";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * The unauthenticated sign-in screen. Production renders Clerk's hosted widget
 * (`@repo/auth/components/sign-in`), which cannot mount in Storybook without a
 * live Clerk instance — so this is the same layout and copy built from our own
 * primitives, for reviewing the surrounding page rather than Clerk's internals.
 */
type LoginScreenProps = {
  /** Page heading above the card. */
  heading?: string;
  /** Supporting line under the heading. */
  subheading?: string;
  /**
   * Show the GitHub and Google buttons and the "or" divider. Off is the
   * email-only arrangement, which is what an org with social sign-in disabled
   * sees.
   */
  showSocialProviders?: boolean;
  /** Label on the primary submit button. */
  submitLabel?: string;
};

const LoginScreen = ({
  heading = "Welcome back",
  subheading = "Enter your details to sign in.",
  showSocialProviders = true,
  submitLabel = "Sign in",
}: LoginScreenProps) => (
  <div className="flex min-h-screen items-center justify-center bg-muted/40 p-6">
    <div className="w-full max-w-sm space-y-6">
      <div className="space-y-2 text-center">
        <div className="mx-auto flex size-10 items-center justify-center rounded-lg bg-primary font-semibold text-lg text-primary-foreground">
          C
        </div>
        <h1 className="font-semibold text-2xl tracking-tight">{heading}</h1>
        <p className="text-muted-foreground text-sm">{subheading}</p>
      </div>

      <div className="space-y-4 rounded-xl border bg-card p-6 shadow-sm">
        {showSocialProviders ? (
          <>
            <Button className="w-full" variant="outline">
              Continue with GitHub
            </Button>
            <Button className="w-full" variant="outline">
              Continue with Google
            </Button>

            <div className="flex items-center gap-3">
              <Separator className="flex-1" />
              <span className="text-muted-foreground text-xs uppercase tracking-wide">
                or
              </span>
              <Separator className="flex-1" />
            </div>
          </>
        ) : null}

        <div className="space-y-2">
          <Label htmlFor="login-email">Email address</Label>
          <Input
            autoComplete="email"
            id="login-email"
            placeholder="you@company.com"
            type="email"
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="login-password">Password</Label>
            <a
              className="text-muted-foreground text-xs underline underline-offset-2"
              href="#forgot"
            >
              Forgot password?
            </a>
          </div>
          <Input
            autoComplete="current-password"
            id="login-password"
            type="password"
          />
        </div>

        <Button className="w-full">{submitLabel}</Button>
      </div>

      <p className="text-center text-muted-foreground text-sm">
        Don't have an account?{" "}
        <a className="underline underline-offset-2" href="#sign-up">
          Sign up
        </a>
      </p>
    </div>
  </div>
);

const meta = {
  title: "Screens/Login",
  component: LoginScreen,
  tags: ["autodocs"],
  argTypes: {
    heading: { control: "text", table: { category: "Content" } },
    subheading: { control: "text", table: { category: "Content" } },
    submitLabel: { control: "text", table: { category: "Content" } },
    showSocialProviders: {
      control: "boolean",
      description:
        "Off drops the GitHub and Google buttons and the divider, leaving the email-only arrangement.",
      table: { category: "State" },
    },
  },
  args: {
    heading: "Welcome back",
    subheading: "Enter your details to sign in.",
    showSocialProviders: true,
    submitLabel: "Sign in",
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof LoginScreen>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
