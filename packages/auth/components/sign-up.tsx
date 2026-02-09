import { SignUp as ClerkSignUp } from "@clerk/nextjs";
import type React from "react";

export const SignUp = (): React.JSX.Element => (
  <ClerkSignUp
    appearance={{
      elements: {
        header: "hidden",
      },
    }}
  />
);
