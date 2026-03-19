import { SignUp as ClerkSignUp } from "@clerk/nextjs";

export const SignUp = () => (
  <ClerkSignUp
    appearance={{
      layout: {
        logoPlacement: "none",
      },
      elements: {
        headerSubtitle: "hidden",
        headerTitle: { fontSize: "1.3rem" },
        cardBox: { boxShadow: "none", border: "1px solid var(--border)" },
        footer: { background: "var(--background)" },
      },
    }}
  />
);
