import { ModeToggle } from "@repo/design-system/components/ui/mode-toggle";
import Image from "next/image";
import type { ReactNode } from "react";

type AuthLayoutProps = {
  readonly children: ReactNode;
};

function AuthLayout({ children }: AuthLayoutProps) {
  return (
    <div className="container relative grid h-dvh flex-col items-center justify-center lg:max-w-none lg:grid-cols-2 lg:px-0">
      <div className="relative hidden h-full flex-col bg-muted p-10 text-white lg:flex dark:border-r">
        <div className="absolute inset-0 bg-muted" />
        <div className="relative z-20">
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
        <div className="absolute top-4 right-4">
          <ModeToggle />
        </div>
      </div>
      <div className="lg:p-8">
        <div className="mx-auto flex w-full max-w-[400px] flex-col justify-center space-y-6">
          {children}
        </div>
      </div>
    </div>
  );
}

export default AuthLayout;
