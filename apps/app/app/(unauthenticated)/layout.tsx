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
        <div className="relative z-20 flex items-center font-medium text-lg text-primary">
          <Image
            alt="ClosedLoop logo"
            className="mr-2"
            height={24}
            src="/logo.svg"
            width={24}
          />
          ClosedLoop
        </div>
        <p className="relative z-20 mt-2 text-muted-foreground text-sm">
          Go fast AND go together.
        </p>
        <div className="absolute top-4 right-4">
          <ModeToggle />
        </div>
        <div className="relative z-20 mt-auto text-primary">
          <div className="space-y-2">
            <p className="font-medium text-lg">ClosedLoop.ai</p>
            <p className="text-sm">Go fast AND go together.</p>
          </div>
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
