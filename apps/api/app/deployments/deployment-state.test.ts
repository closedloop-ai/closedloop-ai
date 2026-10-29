import { describe, expect, it } from "vitest";
import { DEPLOYMENT_STATE_OPTIONS, DeploymentState } from "./deployment-state";

/**
 * The GitHub `deployment_status.state` spellings the ISS-4975 normalizer
 * (`PROVIDER_STATE_BY_NAME`) mapped before ISS-12780 deleted it. ISS-9434
 * shipped `DeploymentState` missing `waiting`, and the conformance gauge reads
 * this set as the DEPLOYMENT vocabulary, so a gap flags a real row as
 * off-vocabulary. Equality pins both directions.
 */
const GITHUB_DEPLOYMENT_STATUS_STATES = [
  "queued",
  "pending",
  "waiting",
  "in_progress",
  "success",
  "failure",
  "error",
  "inactive",
];

describe("DeploymentState pins the provider vocabulary", () => {
  it("carries exactly the GitHub deployment_status spellings", () => {
    expect([...DEPLOYMENT_STATE_OPTIONS].sort()).toEqual(
      [...GITHUB_DEPLOYMENT_STATUS_STATES].sort()
    );
  });

  it("includes waiting, the member ISS-9434 originally omitted", () => {
    expect(DEPLOYMENT_STATE_OPTIONS).toContain(DeploymentState.Waiting);
  });
});
