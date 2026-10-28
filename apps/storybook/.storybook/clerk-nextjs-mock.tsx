import type { ReactNode } from "react";

/**
 * Storybook's stand-in for `@clerk/nextjs` (aliased in ./module-aliases.ts).
 *
 * Surfaces mounts the live app's own route components so a page in
 * Storybook has every element the live page has. Those components read the
 * signed-in user and organization from Clerk, and Storybook has no Clerk
 * instance, so the real hooks throw. This module answers them as one
 * signed-in admin in one organization, the same identity the app-core story
 * providers use (`createStaticAuthAdapter`: `user_test` / `org_test`, memory
 * navigation slug `org-test`).
 *
 * Clerk's hosted UI (`<SignIn>`, `<OrganizationProfile>`, ...) cannot render
 * without Clerk, so each renders a labelled region where the live app shows it.
 */

export const STORYBOOK_CLERK_USER_ID = "user_test";
export const STORYBOOK_CLERK_ORG_ID = "org_test";
export const STORYBOOK_CLERK_ORG_SLUG = "org-test";

const user = {
  id: STORYBOOK_CLERK_USER_ID,
  firstName: "Dana",
  lastName: "Reyes",
  fullName: "Dana Reyes",
  username: "dana",
  imageUrl: "",
  hasImage: false,
  primaryEmailAddress: {
    id: "email_test",
    emailAddress: "dana@example.com",
  },
  primaryEmailAddressId: "email_test",
  emailAddresses: [{ id: "email_test", emailAddress: "dana@example.com" }],
  externalAccounts: [],
  passwordEnabled: false,
  publicMetadata: {},
  unsafeMetadata: {},
  reload: async () => undefined,
  update: async () => undefined,
  createExternalAccount: async () => undefined,
};

const organization = {
  id: STORYBOOK_CLERK_ORG_ID,
  slug: STORYBOOK_CLERK_ORG_SLUG,
  name: "ClosedLoop",
  imageUrl: "",
  hasImage: false,
  membersCount: 6,
  publicMetadata: {},
};

const membership = {
  id: "orgmem_test",
  role: "org:admin",
  organization,
};

const session = {
  id: "sess_test",
  status: "active",
  user,
  getToken: async () => "storybook-session-token",
};

const noop = async () => undefined;

const clerk = {
  loaded: true as boolean,
  user: user as typeof user | null,
  session,
  organization,
  signOut: noop,
  openSignIn: noop,
  openSignUp: noop,
  openUserProfile: noop,
  openOrganizationProfile: noop,
  setActive: noop,
  redirectToSignIn: noop,
  redirectToSignUp: noop,
  handleRedirectCallback: noop,
  addListener: () => () => undefined,
};

export const useAuth = () => ({
  isLoaded: true,
  isSignedIn: true,
  userId: STORYBOOK_CLERK_USER_ID,
  orgId: STORYBOOK_CLERK_ORG_ID,
  orgSlug: STORYBOOK_CLERK_ORG_SLUG,
  orgRole: membership.role,
  sessionId: session.id,
  getToken: session.getToken,
  signOut: noop,
  has: () => true,
});

// Read off `clerk` so an auth-screen story can put Clerk in the state the
// live screen meets (not loaded yet, signed out) by setting `clerk.loaded` or
// `clerk.user` for the life of the story.
export const useUser = () => ({
  isLoaded: clerk.loaded,
  isSignedIn: clerk.user !== null,
  user: clerk.user,
});

export const useOrganization = () => ({
  isLoaded: true,
  organization,
  membership,
  memberships: { data: [membership], count: 1, isLoading: false },
  invitations: { data: [], count: 0, isLoading: false },
  membershipRequests: { data: [], count: 0, isLoading: false },
});

export const useOrganizationList = () => ({
  isLoaded: true,
  setActive: noop,
  userMemberships: { data: [membership], count: 1, isLoading: false },
  userInvitations: { data: [], count: 0, isLoading: false },
  userSuggestions: { data: [], count: 0, isLoading: false },
  createOrganization: noop,
});

export const useClerk = () => clerk;

export const useSession = () => ({ isLoaded: true, isSignedIn: true, session });

// One resource for every call, like Clerk's, so a story can answer `sso`
// (the redirect sign-in `/connect/github` starts) the way the live screen
// meets it. `noop` resolves with no error: the redirect is under way.
const signInResource = {
  status: null,
  create: noop,
  authenticateWithRedirect: noop,
  sso: noop,
};

export const useSignIn = () => ({
  isLoaded: true,
  setActive: noop,
  signIn: signInResource,
});

export const useSignUp = () => ({
  isLoaded: true,
  setActive: noop,
  signUp: {
    status: null,
    create: noop,
    authenticateWithRedirect: noop,
  },
});

/** Clerk wraps an action that may need re-verification; here it runs as-is. */
export const useReverification =
  <TArgs extends unknown[], TResult>(action: (...args: TArgs) => TResult) =>
  (...args: TArgs) =>
    action(...args);

const Passthrough = ({ children }: { children?: ReactNode }) => children;

export const ClerkProvider = Passthrough;
export const ClerkLoaded = Passthrough;
export const SignedIn = Passthrough;
export const Protect = Passthrough;
export const Show = Passthrough;
export const SignedOut = () => null;
export const ClerkLoading = () => null;
export const ClerkFailed = () => null;
export const AuthenticateWithRedirectCallback = () => null;
export const RedirectToSignIn = () => null;

function ClerkHostedRegion({ name }: { name: string }) {
  return (
    <div
      className="flex min-h-48 items-center justify-center rounded-lg border border-dashed p-6 text-muted-foreground text-sm"
      data-clerk-hosted={name}
    >
      Clerk {name}
    </div>
  );
}

export const SignIn = () => <ClerkHostedRegion name="SignIn" />;
export const SignUp = () => <ClerkHostedRegion name="SignUp" />;
export const UserProfile = () => <ClerkHostedRegion name="UserProfile" />;
export const CreateOrganization = () => (
  <ClerkHostedRegion name="CreateOrganization" />
);
export const OrganizationProfile = () => (
  <ClerkHostedRegion name="OrganizationProfile" />
);
export const UserButton = () => <ClerkHostedRegion name="UserButton" />;
export const OrganizationSwitcher = () => (
  <ClerkHostedRegion name="OrganizationSwitcher" />
);
