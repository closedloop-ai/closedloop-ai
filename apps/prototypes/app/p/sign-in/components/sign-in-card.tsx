import {
  GitHubMark,
  GoogleGlyph,
} from "@repo/design-system/components/ui/brand-icons";
import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { Separator } from "@repo/design-system/components/ui/separator";
import { signInCopy } from "../mock";

const OrDivider = () => (
  <div className="flex items-center gap-3">
    <Separator className="flex-1" />
    <span className="text-muted-foreground text-xs">or</span>
    <Separator className="flex-1" />
  </div>
);

/**
 * The generic sign-in entry. Still the right screen for someone who arrived at
 * /sign-in themselves - it is only the wrong screen for a click that already
 * said "Connect to GitHub", which is what the deep link routes past.
 */
export const SignInCard = () => (
  <div className="w-full">
    <h1 className="text-center font-semibold text-2xl">{signInCopy.heading}</h1>

    {/* Primary action: GitHub is the single filled/default button, alone
        above the divider so it reads as the one recommended way in. */}
    <div className="mt-8">
      <Button className="w-full" size="lg">
        <GitHubMark className="size-4" />
        Continue with GitHub
      </Button>
    </div>

    <div className="my-6">
      <OrDivider />
    </div>

    {/* Everything below the divider is the de-emphasized alternatives bucket. */}
    <div className="flex flex-col gap-4">
      {/* Outline matches the email field's bg-input/border. */}
      <Button className="w-full" size="lg" variant="outline">
        <GoogleGlyph className="size-4" />
        Continue with Google
      </Button>

      <div className="flex flex-col gap-2">
        <Label htmlFor="email">{signInCopy.emailLabel}</Label>
        <Input
          autoComplete="email"
          id="email"
          placeholder={signInCopy.emailPlaceholder}
          type="email"
        />
      </div>

      {/* Secondary so the email path never competes with GitHub as primary. */}
      <Button className="w-full" size="lg" variant="secondary">
        {signInCopy.continueLabel}
      </Button>
    </div>

    <p className="mt-6 text-center text-muted-foreground text-sm">
      {signInCopy.signUpPrompt}{" "}
      <Button
        className="h-auto p-0 align-baseline font-medium text-foreground"
        variant="link"
      >
        {signInCopy.signUpCta}
      </Button>
    </p>
  </div>
);
