"use client";

import { useReducer, useState } from "react";
import { flowReducer, Phase } from "../flow-reducer";
import {
  AuthMethod,
  type AuthMethod as AuthMethodType,
  type DataSyncLevel,
  workspaceName,
} from "../mock";
import { SessionsPage } from "./sessions-page";
import { SyncTakeover } from "./sync-takeover";

// Orchestrates the post-auth desktop onboarding flow (ISS-5249). Acknowledging
// that the returning user is now authenticated is a silent background step with
// no UI, so the flow opens directly on the blocking sync takeover, then the
// Sessions page. The GitHub sign-in state is resolved in the background and
// carried as flow state, so the Sessions page renders correctly the moment it
// mounts.
export const Experience = () => {
  const [phase, dispatch] = useReducer(flowReducer, Phase.SyncTakeover);
  const [authMethod, setAuthMethod] = useState<AuthMethodType>(
    AuthMethod.GitHub
  );
  // The level committed in the takeover, so the Sessions page can acknowledge
  // the sync it just authorized.
  const [syncLevel, setSyncLevel] = useState<DataSyncLevel | null>(null);

  if (phase === Phase.SyncTakeover) {
    return (
      <SyncTakeover
        authMethod={authMethod}
        onFinish={(level) => {
          setSyncLevel(level);
          dispatch({ type: "finish-sync" });
        }}
        workspaceName={workspaceName}
      />
    );
  }
  return (
    <SessionsPage
      authMethod={authMethod}
      onAuthMethodChange={setAuthMethod}
      onRestart={() => dispatch({ type: "restart" })}
      syncLevel={syncLevel}
      workspaceName={workspaceName}
    />
  );
};
