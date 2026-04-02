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
        card: { boxShadow: "none", border: "none", paddingBottom: 0 },
        cardBox: { boxShadow: "none", border: "none" },
        footer: { background: "var(--background)" },
        formButtonPrimary: {
          background: "var(--primary)",
          color: "var(--primary-foreground)",
          backgroundImage: "none",
          height: "2.5rem",
        },
        main: { gap: "0.9rem" },
        buttonArrowIcon: { display: "none" },
        formButtonPrimary__icon: { display: "none" },
      },
    }}
  />
);
