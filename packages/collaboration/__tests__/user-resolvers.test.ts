import { describe, expect, it, vi } from "vitest";
import {
  createResolveMentionSuggestions,
  createResolveUsers,
  type UserInfo,
} from "../user-resolvers";

// Mock the user-colors module
vi.mock("../user-colors", () => ({
  getConsistentColor: (userId: string) => `color-${userId}`,
}));

// Test fixtures
const mockUsers: UserInfo[] = [
  {
    id: "user-1",
    firstName: "John",
    lastName: "Doe",
    email: "john.doe@example.com",
    avatarUrl: "https://example.com/john.jpg",
    active: true,
  },
  {
    id: "user-2",
    firstName: "Jane",
    lastName: "Smith",
    email: "jane.smith@example.com",
    avatarUrl: null,
    active: true,
  },
  {
    id: "user-3",
    firstName: null,
    lastName: null,
    email: "noname@example.com",
    avatarUrl: null,
    active: true,
  },
  {
    id: "user-4",
    firstName: "Bob",
    lastName: "Johnson",
    email: "bob.johnson@example.com",
    avatarUrl: "https://example.com/bob.jpg",
    active: false, // Inactive user
  },
  {
    id: "user-5",
    firstName: "Alice",
    lastName: "",
    email: "alice@example.com",
    avatarUrl: null,
    active: true,
  },
];

describe("createResolveUsers", () => {
  it("should resolve user IDs to display info", () => {
    const resolveUsers = createResolveUsers(mockUsers);
    const result = resolveUsers({ userIds: ["user-1", "user-2"] });

    expect(result).toEqual([
      {
        name: "John Doe",
        avatar: "https://example.com/john.jpg",
        color: "color-user-1",
      },
      {
        name: "Jane Smith",
        avatar: undefined,
        color: "color-user-2",
      },
    ]);
  });

  it("should use email as fallback when no name is provided", () => {
    const resolveUsers = createResolveUsers(mockUsers);
    const result = resolveUsers({ userIds: ["user-3"] });

    expect(result).toEqual([
      {
        name: "noname@example.com",
        avatar: undefined,
        color: "color-user-3",
      },
    ]);
  });

  it("should handle empty lastName", () => {
    const resolveUsers = createResolveUsers(mockUsers);
    const result = resolveUsers({ userIds: ["user-5"] });

    expect(result).toEqual([
      {
        name: "Alice",
        avatar: undefined,
        color: "color-user-5",
      },
    ]);
  });

  it("should return undefined for non-existent user IDs", () => {
    const resolveUsers = createResolveUsers(mockUsers);
    const result = resolveUsers({ userIds: ["non-existent"] });

    expect(result).toEqual([undefined]);
  });

  it("should handle mixed valid and invalid user IDs", () => {
    const resolveUsers = createResolveUsers(mockUsers);
    const result = resolveUsers({
      userIds: ["user-1", "non-existent", "user-2"],
    });

    expect(result).toEqual([
      {
        name: "John Doe",
        avatar: "https://example.com/john.jpg",
        color: "color-user-1",
      },
      undefined,
      {
        name: "Jane Smith",
        avatar: undefined,
        color: "color-user-2",
      },
    ]);
  });

  it("should return empty array for empty user IDs", () => {
    const resolveUsers = createResolveUsers(mockUsers);
    const result = resolveUsers({ userIds: [] });

    expect(result).toEqual([]);
  });

  it("should handle empty users list", () => {
    const resolveUsers = createResolveUsers([]);
    const result = resolveUsers({ userIds: ["user-1"] });

    expect(result).toEqual([undefined]);
  });

  it("should include inactive users in resolution", () => {
    const resolveUsers = createResolveUsers(mockUsers);
    const result = resolveUsers({ userIds: ["user-4"] });

    expect(result).toEqual([
      {
        name: "Bob Johnson",
        avatar: "https://example.com/bob.jpg",
        color: "color-user-4",
      },
    ]);
  });
});

describe("createResolveMentionSuggestions", () => {
  it("should return all active user IDs when text is empty", () => {
    const resolveSuggestions = createResolveMentionSuggestions(mockUsers);
    const result = resolveSuggestions({ text: "" });

    expect(result).toEqual(["user-1", "user-2", "user-3", "user-5"]);
    expect(result).not.toContain("user-4"); // Inactive user
  });

  it("should filter users by first name (case-insensitive)", () => {
    const resolveSuggestions = createResolveMentionSuggestions(mockUsers);
    const result = resolveSuggestions({ text: "john" });

    expect(result).toEqual(["user-1"]);
  });

  it("should filter users by last name (case-insensitive)", () => {
    const resolveSuggestions = createResolveMentionSuggestions(mockUsers);
    const result = resolveSuggestions({ text: "smith" });

    expect(result).toEqual(["user-2"]);
  });

  it("should filter users by full name (case-insensitive)", () => {
    const resolveSuggestions = createResolveMentionSuggestions(mockUsers);
    const result = resolveSuggestions({ text: "jane smith" });

    expect(result).toEqual(["user-2"]);
  });

  it("should filter users by email (case-insensitive)", () => {
    const resolveSuggestions = createResolveMentionSuggestions(mockUsers);
    const result = resolveSuggestions({ text: "noname@example" });

    expect(result).toEqual(["user-3"]);
  });

  it("should handle partial matches", () => {
    const resolveSuggestions = createResolveMentionSuggestions(mockUsers);
    const result = resolveSuggestions({ text: "j" });

    expect(result).toContain("user-1"); // John
    expect(result).toContain("user-2"); // Jane
    expect(result).not.toContain("user-5"); // Alice
  });

  it("should exclude inactive users from suggestions", () => {
    const resolveSuggestions = createResolveMentionSuggestions(mockUsers);
    const result = resolveSuggestions({ text: "bob" });

    expect(result).toEqual([]);
    expect(result).not.toContain("user-4");
  });

  it("should return empty array when no matches found", () => {
    const resolveSuggestions = createResolveMentionSuggestions(mockUsers);
    const result = resolveSuggestions({ text: "xyz" });

    expect(result).toEqual([]);
  });

  it("should handle empty users list", () => {
    const resolveSuggestions = createResolveMentionSuggestions([]);
    const result = resolveSuggestions({ text: "john" });

    expect(result).toEqual([]);
  });

  it("should match email domain", () => {
    const resolveSuggestions = createResolveMentionSuggestions(mockUsers);
    const result = resolveSuggestions({ text: "example.com" });

    // Should match all active users with @example.com email
    expect(result).toContain("user-1");
    expect(result).toContain("user-2");
    expect(result).toContain("user-3");
    expect(result).toContain("user-5");
    expect(result).not.toContain("user-4"); // Inactive
  });

  it("should be case-insensitive for search", () => {
    const resolveSuggestions = createResolveMentionSuggestions(mockUsers);
    const resultLower = resolveSuggestions({ text: "john" });
    const resultUpper = resolveSuggestions({ text: "JOHN" });
    const resultMixed = resolveSuggestions({ text: "JoHn" });

    expect(resultLower).toEqual(["user-1"]);
    expect(resultUpper).toEqual(["user-1"]);
    expect(resultMixed).toEqual(["user-1"]);
  });

  it("should handle special characters in search", () => {
    const usersWithSpecialChars: UserInfo[] = [
      {
        id: "user-special",
        firstName: "O'Brien",
        lastName: "McTest",
        email: "test+tag@example.com",
        avatarUrl: null,
        active: true,
      },
    ];

    const resolveSuggestions = createResolveMentionSuggestions(
      usersWithSpecialChars
    );
    const result = resolveSuggestions({ text: "o'brien" });

    expect(result).toEqual(["user-special"]);
  });

  it("should match on firstName when lastName is empty", () => {
    const resolveSuggestions = createResolveMentionSuggestions(mockUsers);
    const result = resolveSuggestions({ text: "alice" });

    expect(result).toEqual(["user-5"]);
  });
});
