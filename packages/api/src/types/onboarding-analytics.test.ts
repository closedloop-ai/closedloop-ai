import { describe, expect, it } from "vitest";
import {
  bucketSessionVolume,
  OnboardingAccountOutcome,
  OnboardingAnalyticsEvent,
  OnboardingAnalyticsPageName,
  OnboardingCtaId,
  onboardingFailedAccountModesForOutcome,
  SessionVolumeBucket,
} from "./onboarding-analytics.ts";

/**
 * Contract pins. These fixtures are DELIBERATELY independent literals, not
 * derived from the consts under test — a fixture built from the const would
 * agree with the const's own mistake. The duplication is the test: PRD-736
 * names these wire values, and a reworded const member must redden here.
 */
describe("onboarding analytics contract (PRD-736)", () => {
  it("pins the event catalog wire names", () => {
    expect(OnboardingAnalyticsEvent).toEqual({
      FlowStarted: "onboarding_flow_started",
      StepViewed: "onboarding_step_viewed",
      StepCompleted: "onboarding_step_completed",
      StepFailed: "onboarding_step_failed",
      StepSkipped: "onboarding_step_skipped",
      StepBack: "onboarding_step_back",
      CtaClicked: "onboarding_cta_clicked",
      FlowCompleted: "onboarding_flow_completed",
      TourStarted: "onboarding_tour_started",
      TourStepViewed: "onboarding_tour_step_viewed",
      TourCompleted: "onboarding_tour_completed",
      TourSkipped: "onboarding_tour_skipped",
      ChecklistItemCompleted: "onboarding_checklist_item_completed",
      ChecklistCompleted: "onboarding_checklist_completed",
      PageViewed: "page_viewed",
      ButtonClicked: "button_clicked",
    });
  });

  it("pins the closed cta_id vocabulary", () => {
    expect(OnboardingCtaId).toEqual({
      AuthGitHub: "auth_github",
      AuthGoogle: "auth_google",
      AuthEmail: "auth_email",
      SignIn: "sign_in",
      SignOut: "sign_out",
      PrivacyPolicy: "privacy_policy",
      Terms: "terms",
      TourBack: "tour_back",
      GettingStartedInvite: "getting_started_invite",
    });
  });

  it("pins the closed page_name vocabulary", () => {
    expect(OnboardingAnalyticsPageName).toEqual({
      Dashboard: "dashboard",
      Sessions: "sessions",
      Branches: "branches",
      SessionDetail: "session_detail",
      Settings: "settings",
      BranchDetail: "branch_detail",
      Agents: "agents",
      AgentDetail: "agent_detail",
      Packs: "packs",
      PackDetail: "pack_detail",
      Insights: "insights",
      Plans: "plans",
      Approvals: "approvals",
      Requests: "requests",
      Diagnostics: "diagnostics",
      Help: "help",
      Inbox: "inbox",
      Issues: "issues",
      IssueDetail: "issue_detail",
      Documents: "documents",
      DocumentDetail: "document_detail",
      PrdDetail: "prd_detail",
      ImplementationPlanDetail: "implementation_plan_detail",
      MyTasks: "my_tasks",
      Search: "search",
      Projects: "projects",
      ProjectDetail: "project_detail",
      ArchivedProjects: "archived_projects",
      UserDetail: "user_detail",
      Build: "build",
      JudgesAnalytics: "judges_analytics",
      JudgeMetric: "judge_metric",
      LostWork: "lost_work",
      TokenOpsWaste: "token_ops_waste",
      Catalog: "catalog",
      Onboarding: "onboarding",
      SignIn: "sign_in",
      SignUp: "sign_up",
      SsoCallback: "sso_callback",
      GitHubConnect: "github_connect",
      DesktopConnect: "desktop_connect",
      DesktopAuthorize: "desktop_authorize",
      Landing: "landing",
      Pricing: "pricing",
      Blog: "blog",
      BlogPost: "blog_post",
      Community: "community",
      Resources: "resources",
      PrivacyPolicy: "privacy_policy",
      Terms: "terms",
      Docs: "docs",
      NotFound: "not_found",
    });
  });

  it("pins the frozen session-volume bucket edges", () => {
    expect(SessionVolumeBucket).toEqual({
      Zero: "0",
      OneToNine: "1-9",
      TenToNinetyNine: "10-99",
      HundredPlus: "100+",
    });
  });
});

describe("bucketSessionVolume", () => {
  it("folds counts at the frozen edges", () => {
    expect(bucketSessionVolume(0)).toBe(SessionVolumeBucket.Zero);
    expect(bucketSessionVolume(1)).toBe(SessionVolumeBucket.OneToNine);
    expect(bucketSessionVolume(9)).toBe(SessionVolumeBucket.OneToNine);
    expect(bucketSessionVolume(10)).toBe(SessionVolumeBucket.TenToNinetyNine);
    expect(bucketSessionVolume(99)).toBe(SessionVolumeBucket.TenToNinetyNine);
    expect(bucketSessionVolume(100)).toBe(SessionVolumeBucket.HundredPlus);
    expect(bucketSessionVolume(5000)).toBe(SessionVolumeBucket.HundredPlus);
  });

  it("returns null for values that cannot be a measured count, never a fabricated bucket", () => {
    expect(bucketSessionVolume(-1)).toBeNull();
    expect(bucketSessionVolume(Number.NaN)).toBeNull();
    expect(bucketSessionVolume(Number.POSITIVE_INFINITY)).toBeNull();
    expect(bucketSessionVolume(1.5)).toBeNull();
  });
});

describe("failed account outcome combinations (ISS-11127)", () => {
  it.each([
    [OnboardingAccountOutcome.CreatedSignedIn, true, null],
    [OnboardingAccountOutcome.SignedIn, true, null],
    [
      OnboardingAccountOutcome.CreatedLoggedOut,
      true,
      ["created", "logged_out"],
    ],
    [OnboardingAccountOutcome.LoggedOut, true, ["creation_unconfirmed"]],
    [OnboardingAccountOutcome.LoggedOut, false, ["creation_unattempted"]],
    [OnboardingAccountOutcome.Unknown, true, ["unknown"]],
    [undefined, true, ["unknown"]],
  ] as const)(
    "folds %s with browser opened=%s",
    (outcome, opened, expected) => {
      expect(onboardingFailedAccountModesForOutcome(outcome, opened)).toEqual(
        expected
      );
    }
  );
  it.each(["", "newer_gateway_outcome", "constructor", "__proto__"])(
    "preserves unknown fallback across versions: %s",
    (outcome) => {
      expect(
        onboardingFailedAccountModesForOutcome(
          outcome as OnboardingAccountOutcome,
          true
        )
      ).toEqual(["unknown"]);
    }
  );
});
