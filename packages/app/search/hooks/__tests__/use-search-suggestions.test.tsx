import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { mockUseOrganizationUsers, mockUseProjects } = vi.hoisted(() => ({
  mockUseOrganizationUsers: vi.fn(),
  mockUseProjects: vi.fn(),
}));

vi.mock("@repo/app/users/hooks/use-users", () => ({
  useOrganizationUsers: (options?: { enabled?: boolean }) =>
    mockUseOrganizationUsers(options),
}));

vi.mock("../../../projects/hooks/use-projects", () => ({
  useProjects: (teamId: unknown, options?: { enabled?: boolean }) =>
    mockUseProjects(teamId, options),
}));

import {
  filterSuggestionOptions,
  type SuggestionOption,
  useMemberSuggestions,
  useProjectSuggestions,
} from "../use-search-suggestions";

function user(overrides: Record<string, unknown> = {}) {
  return {
    id: "u1",
    clerkId: "c1",
    organizationId: "org1",
    email: "alice@acme.com",
    firstName: "Alice",
    lastName: "Anderson",
    avatarUrl: null,
    phoneNumber: null,
    role: "ENGINEER",
    linearId: null,
    slackId: null,
    githubUsername: "alice-gh",
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("useMemberSuggestions", () => {
  it("gates the fetch on `enabled` and maps to the GitHub-username handle", () => {
    mockUseOrganizationUsers.mockReturnValue({
      data: [user()],
      isLoading: false,
      isError: false,
    });

    const { result } = renderHook(() => useMemberSuggestions(true));

    // The fetch is gated on the surface being active.
    expect(mockUseOrganizationUsers).toHaveBeenCalledWith({ enabled: true });
    // The committed token is the stable GitHub handle the parser resolves by.
    expect(result.current.options).toEqual([
      { value: "alice-gh", label: "Alice Anderson", detail: "alice-gh" },
    ]);
  });

  it("falls back to email when a member has no GitHub username", () => {
    mockUseOrganizationUsers.mockReturnValue({
      data: [user({ githubUsername: null })],
      isLoading: false,
      isError: false,
    });

    const { result } = renderHook(() => useMemberSuggestions(true));
    expect(result.current.options[0].value).toBe("alice@acme.com");
  });

  it("surfaces the loading and error state honestly", () => {
    mockUseOrganizationUsers.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    });
    const { result } = renderHook(() => useMemberSuggestions(true));
    expect(result.current.isLoading).toBe(true);
    expect(result.current.options).toEqual([]);
  });
});

describe("useProjectSuggestions", () => {
  it("gates the fetch on `enabled` and maps to the project slug", () => {
    mockUseProjects.mockReturnValue({
      data: [{ id: "p1", name: "Acme", slug: "acme" }],
      isLoading: false,
      isError: false,
    });

    const { result } = renderHook(() => useProjectSuggestions(true));

    expect(mockUseProjects).toHaveBeenCalledWith(undefined, { enabled: true });
    // The slug is the resolvable value; it differs from the display name, so it
    // shows as the secondary detail line.
    expect(result.current.options).toEqual([
      { value: "acme", label: "Acme", detail: "acme" },
    ]);
  });

  it("falls back to the name when a project has no slug", () => {
    mockUseProjects.mockReturnValue({
      data: [{ id: "p1", name: "No Slug", slug: null }],
      isLoading: false,
      isError: false,
    });
    const { result } = renderHook(() => useProjectSuggestions(true));
    expect(result.current.options[0].value).toBe("No Slug");
  });
});

describe("filterSuggestionOptions", () => {
  const options: SuggestionOption[] = [
    { value: "alice-gh", label: "Alice Anderson", detail: "alice-gh" },
    { value: "bob-gh", label: "Bob Baker", detail: "bob-gh" },
  ];

  it("matches on label and value", () => {
    expect(filterSuggestionOptions(options, "ali")).toHaveLength(1);
    expect(filterSuggestionOptions(options, "bob-gh")).toHaveLength(1);
  });

  it("returns the whole list for an empty filter", () => {
    expect(filterSuggestionOptions(options, "")).toHaveLength(2);
  });
});
