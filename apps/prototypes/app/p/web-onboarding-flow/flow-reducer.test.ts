import { describe, expect, it } from "vitest";
import { flowReducer, Phase } from "./flow-reducer";

describe("flowReducer", () => {
  it("Get Started moves from Landing to Auth", () => {
    expect(flowReducer(Phase.Landing, { type: "get-started" })).toBe(
      Phase.Auth
    );
  });

  it("authenticate hands the auth page off to the social redirect", () => {
    expect(flowReducer(Phase.Auth, { type: "authenticate" })).toBe(
      Phase.SocialRedirect
    );
  });

  it("auth-complete returns from social login to Create Team", () => {
    expect(flowReducer(Phase.SocialRedirect, { type: "auth-complete" })).toBe(
      Phase.CreateTeam
    );
  });

  it("team-created advances to Create Project", () => {
    expect(flowReducer(Phase.CreateTeam, { type: "team-created" })).toBe(
      Phase.CreateProject
    );
  });

  it("project-created advances to the App (My Tasks)", () => {
    expect(flowReducer(Phase.CreateProject, { type: "project-created" })).toBe(
      Phase.App
    );
  });

  it("back from Auth returns to Landing", () => {
    expect(flowReducer(Phase.Auth, { type: "back" })).toBe(Phase.Landing);
  });

  it("back from Create Project returns to Create Team", () => {
    expect(flowReducer(Phase.CreateProject, { type: "back" })).toBe(
      Phase.CreateTeam
    );
  });

  it("back is a no-op where there is no earlier step", () => {
    expect(flowReducer(Phase.CreateTeam, { type: "back" })).toBe(
      Phase.CreateTeam
    );
  });

  it("unknown action returns the current phase unchanged", () => {
    // @ts-expect-error intentional unknown action for runtime guard coverage
    expect(flowReducer(Phase.Landing, { type: "unknown" })).toBe(Phase.Landing);
  });
});
