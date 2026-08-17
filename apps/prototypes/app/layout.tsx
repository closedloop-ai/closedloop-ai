import { DesignSystemProvider } from "@repo/design-system";
import { fonts } from "@repo/design-system/lib/fonts";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { brandMarkSrc } from "@/lib/brand-mark";

import "./styles.css";

export const metadata: Metadata = {
  title: "Closedloop Prototypes",
  description:
    "Design-system prototype sandbox. Mock data only, not production code.",
  icons: {
    icon: brandMarkSrc,
  },
};

type RootLayoutProperties = {
  readonly children: ReactNode;
};

const RootLayout = ({ children }: RootLayoutProperties) => (
  <html className={fonts} lang="en" suppressHydrationWarning>
    <body className="bg-background">
      <DesignSystemProvider>{children}</DesignSystemProvider>
    </body>
  </html>
);

export default RootLayout;
