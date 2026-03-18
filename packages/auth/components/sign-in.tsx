import { SignIn as ClerkSignIn } from "@clerk/nextjs";

export const SignIn = () => (
  <ClerkSignIn
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
