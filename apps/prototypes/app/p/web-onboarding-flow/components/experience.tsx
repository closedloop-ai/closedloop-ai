"use client";

import { useReducer, useState } from "react";
import { flowReducer, Phase } from "../flow-reducer";
import { AuthProvider } from "../mock";
import { AuthCard } from "./auth-card";
import { CreateProjectStep } from "./create-project-step";
import { CreateTeamStep } from "./create-team-step";
import { LandingPage } from "./landing-page";
import { SocialRedirectPanel } from "./social-redirect-panel";
import { WebAppShell } from "./web-app-shell";
import { WizardShell, WizardStep } from "./wizard-shell";

const DEFAULT_WORKSPACE_NAME = "Your team";
// Only used as a type-level fallback: the App phase is reached exclusively via
// project-created, which always sets the project first.
const DEFAULT_PROJECT_NAME = "Your project";

type CreatedProject = {
  name: string;
  description: string;
};

export const Experience = () => {
  const [phase, dispatch] = useReducer(flowReducer, Phase.Landing);
  const [team, setTeam] = useState<string | null>(null);
  const [project, setProject] = useState<CreatedProject | null>(null);
  const [provider, setProvider] = useState<AuthProvider>(AuthProvider.GitHub);
  const [authEmail, setAuthEmail] = useState("");

  if (phase === Phase.Auth) {
    return (
      <AuthCard
        onAuthenticate={(chosen, email) => {
          setProvider(chosen);
          setAuthEmail(email ?? "");
          dispatch({ type: "authenticate" });
        }}
        onBack={() => dispatch({ type: "back" })}
      />
    );
  }

  if (phase === Phase.SocialRedirect) {
    return (
      <SocialRedirectPanel
        email={authEmail}
        onComplete={() => dispatch({ type: "auth-complete" })}
        provider={provider}
      />
    );
  }

  if (phase === Phase.CreateTeam) {
    return (
      <WizardShell currentStep={WizardStep.CreateTeam}>
        <CreateTeamStep
          createdTeamName={team}
          onNext={(teamName) => {
            setTeam(teamName);
            dispatch({ type: "team-created" });
          }}
        />
      </WizardShell>
    );
  }

  if (phase === Phase.CreateProject) {
    return (
      <WizardShell
        currentStep={WizardStep.CreateProject}
        onBack={() => dispatch({ type: "back" })}
      >
        <CreateProjectStep
          onNext={(projectName, description) => {
            setProject({ name: projectName, description });
            dispatch({ type: "project-created" });
          }}
        />
      </WizardShell>
    );
  }

  if (phase === Phase.App) {
    return (
      <WebAppShell
        projectDescription={project?.description}
        projectName={project?.name ?? DEFAULT_PROJECT_NAME}
        workspaceName={team ?? DEFAULT_WORKSPACE_NAME}
      />
    );
  }

  return (
    <LandingPage
      onGetStarted={() => dispatch({ type: "get-started" })}
      onSignIn={() => dispatch({ type: "get-started" })}
    />
  );
};
