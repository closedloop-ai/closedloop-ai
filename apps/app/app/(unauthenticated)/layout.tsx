import Image from "next/image";
import type { ReactNode } from "react";

type AuthLayoutProps = {
  readonly children: ReactNode;
};

function AuthLayout({ children }: AuthLayoutProps) {
  return (
    <div className="relative grid h-dvh lg:grid-cols-2">
      {/* Left — auth form */}
      <div className="flex h-full flex-col px-6 py-10 lg:px-10">
        <div>
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
        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-[400px]">{children}</div>
        </div>
      </div>

      {/* Right — product showcase (hidden on mobile) */}
      <div className="hidden h-full items-center justify-center p-8 lg:flex">
        <div
          className="flex h-[90%] w-[90%] items-center justify-end overflow-hidden rounded-3xl pl-12"
          style={{
            background:
              "linear-gradient(to bottom, #fff9eb, #ffe4ab 31%, #d9a2d2 68%, #4685ff)",
          }}
        >
          <Image
            alt="ClosedLoop product screenshot"
            className="max-h-full w-auto object-contain"
            height={1191}
            priority
            src="/CL-SS3.png"
            width={1060}
          />
        </div>
      </div>
    </div>
  );
}

export default AuthLayout;
