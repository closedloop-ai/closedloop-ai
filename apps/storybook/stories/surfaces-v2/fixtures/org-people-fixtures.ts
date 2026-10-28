import type { BasicUser, User } from "@repo/api/src/types/user";
import { ApproverRole } from "@repo/api/src/types/user";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import { currentUserFixture } from "./live-app-fixtures";

// The workspace's people, for pages that list or assign them (`GET /users`).
// The signed-in user (`currentUserFixture`, Dana Reyes) is first; the rest
// are the teammates the Sessions and Branches fixtures name.

function teammate(
  id: string,
  firstName: string,
  lastName: string,
  role: User["role"]
): User {
  return {
    ...currentUserFixture,
    clerkId: id,
    email: `${firstName.toLowerCase()}@example.com`,
    firstName,
    githubUsername: `${firstName.toLowerCase()}-${lastName.toLowerCase()}`,
    id,
    lastName,
    role,
  };
}

export const orgUsersFixture: User[] = [
  currentUserFixture,
  teammate("user-priya", "Priya", "Shah", ApproverRole.Pm),
  teammate("user-marco", "Marco", "Lind", ApproverRole.Engineer),
  teammate("user-hana", "Hana", "Okafor", ApproverRole.Designer),
];

/** The `BasicUser` projection documents embed for assignees and approvers. */
export function basicUser(user: User): BasicUser {
  return {
    avatarUrl: user.avatarUrl,
    email: user.email,
    firstName: user.firstName,
    id: user.id,
    lastName: user.lastName,
  };
}

export const [dana, priya, marco, hana] = orgUsersFixture.map(basicUser) as [
  BasicUser,
  BasicUser,
  BasicUser,
  BasicUser,
];

export const orgUsersRoute: FixtureRoute = {
  method: "GET",
  path: "/users",
  respond: () => orgUsersFixture,
};

/** The viewer's starred artifacts (`GET /artifacts/favorites`): none. */
export const noFavoritesRoute: FixtureRoute = {
  method: "GET",
  path: "/artifacts/favorites",
  respond: () => [],
};
