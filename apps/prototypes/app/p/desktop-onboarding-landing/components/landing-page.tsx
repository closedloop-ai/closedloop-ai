"use client";

import { HeroSection } from "./hero-section";
import { TopBar } from "./top-bar";

/**
 * The pre-login marketing landing: a single viewport, nothing below the fold.
 * The How/What sections and closing CTA were removed (PM decision 2026-08-04).
 * "Get started" hands off to the in-app experience; "Sign in" to the browser
 * auth flow.
 */
export const LandingPage = ({
  onGetStarted,
  onSignIn,
}: {
  onGetStarted: () => void;
  onSignIn: () => void;
}) => (
  <main className="relative min-h-svh bg-background">
    <TopBar />
    <HeroSection onGetStarted={onGetStarted} onSignIn={onSignIn} />
  </main>
);
