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
    <div className="relative flex h-dvh flex-col items-center overflow-y-auto bg-background px-4 pt-24 pb-8">
      <div className="absolute top-4 left-6">
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
      </div>
      <div className="absolute top-4 right-6">
        <ModeToggle />
      </div>
      {children}
    </div>
  );
};

export default OnboardingLayout;
