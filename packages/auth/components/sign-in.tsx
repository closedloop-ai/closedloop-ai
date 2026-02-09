import { SignIn as ClerkSignIn } from "@clerk/nextjs";
import type React from "react";

export const SignIn = (): React.JSX.Element => (
  <ClerkSignIn
    appearance={{
      elements: {
        header: "hidden",
      },
    }}
  />
);
