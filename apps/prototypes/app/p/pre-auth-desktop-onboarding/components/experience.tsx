"use client";

import { useReducer } from "react";
import { flowReducer, Phase } from "../flow-reducer";
import { AuthPanel } from "./auth-panel";
import { LandingPage } from "./landing-page";
import { WebApp } from "./web-app";

export const Experience = () => {
  const [phase, dispatch] = useReducer(flowReducer, Phase.Landing);

  if (phase === Phase.OnboardingApp) {
    return (
      <WebApp
        initialDesktopConnected
        initialGithubConnected={false}
        initialTourActive
        onSignUp={() => dispatch({ type: "sign-in" })}
        signedIn={false}
        workspaceName="Acme Engineering"
      />
    );
  }
  if (phase === Phase.ReturningApp) {
    return (
      <WebApp
        initialDesktopConnected
        initialGithubConnected={false}
        initialTourActive={false}
        onSignUp={() => {}}
        signedIn
        workspaceName="Acme Engineering"
      />
    );
  }
  if (phase === Phase.SignIn) {
    return (
      <AuthPanel
        onBack={() => dispatch({ type: "back" })}
        onComplete={() => dispatch({ type: "auth-complete" })}
      />
    );
  }
  return (
    <LandingPage
      onGetStarted={() => dispatch({ type: "get-started" })}
      onSignIn={() => dispatch({ type: "sign-in" })}
    />
  );
};
