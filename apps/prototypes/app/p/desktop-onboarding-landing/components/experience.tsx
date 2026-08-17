"use client";

import { useEffect, useState } from "react";
import { AppExperience } from "./app-experience";
import { BrowserSignIn } from "./browser-sign-in";
import { LandingPage } from "./landing-page";

/**
 * Top-level phase machine for the first-run flow: the marketing landing, then
 * the in-app experience once the user clicks "Get started".
 */
export const Experience = () => {
  const [phase, setPhase] = useState<ExperiencePhase>(ExperiencePhase.Landing);
  const [emptySessions, setEmptySessions] = useState(false);

  // `?empty` on the page URL models a fresh machine with no agent history
  // (r3706838798). Read after mount so SSR renders the stable default.
  useEffect(() => {
    setEmptySessions(
      new URLSearchParams(globalThis.location.search).has("empty")
    );
  }, []);

  if (phase === ExperiencePhase.BrowserAuth) {
    return (
      <BrowserSignIn
        onCancel={() => setPhase(ExperiencePhase.Landing)}
        onComplete={() => setPhase(ExperiencePhase.AuthenticatedDesktop)}
      />
    );
  }
  if (
    phase === ExperiencePhase.GuestDesktop ||
    phase === ExperiencePhase.AuthenticatedDesktop
  ) {
    return (
      <AppExperience
        emptySessions={emptySessions}
        initialSignedUp={phase === ExperiencePhase.AuthenticatedDesktop}
        onSignIn={() => setPhase(ExperiencePhase.BrowserAuth)}
      />
    );
  }
  return (
    <LandingPage
      onGetStarted={() => setPhase(ExperiencePhase.GuestDesktop)}
      onSignIn={() => setPhase(ExperiencePhase.BrowserAuth)}
    />
  );
};

const ExperiencePhase = {
  Landing: "landing",
  BrowserAuth: "browser-auth",
  GuestDesktop: "guest-desktop",
  AuthenticatedDesktop: "authenticated-desktop",
} as const;
type ExperiencePhase = (typeof ExperiencePhase)[keyof typeof ExperiencePhase];
