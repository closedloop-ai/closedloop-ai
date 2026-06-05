import { auth, currentUser } from "@repo/auth/server";
import { ModeToggle } from "@repo/design-system/components/ui/mode-toggle";
import Image from "next/image";
import type { ReactNode } from "react";

type OnboardingLayoutProps = {
  readonly children: ReactNode;
};

const OnboardingLayout = async ({ children }: OnboardingLayoutProps) => {
  const [{ redirectToSignIn }, user] = await Promise.all([
    auth(),
    currentUser(),
  ]);

  if (!user) {
    return redirectToSignIn();
  }

  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center bg-background p-4">
      <div className="absolute top-4 left-6">
        <Image
          alt="ClosedLoop logo"
          className="dark:hidden"
          height={60}
          src="/logo.svg"
          width={200}
        />
        <Image
          alt="ClosedLoop logo"
          className="hidden dark:block"
          height={60}
          src="/logo-dark.svg"
          width={200}
        />
      </div>
      <div className="absolute top-4 right-6">
        <ModeToggle />
      </div>
      {children}
    </div>
  );
};

export default OnboardingLayout;
