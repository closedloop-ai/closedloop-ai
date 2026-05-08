// Mock for @clerk/nextjs in tests
import type { ReactNode } from "react";

export const useAuth = () => ({
  orgId: undefined as string | undefined,
  userId: undefined as string | undefined,
  isLoaded: true,
  isSignedIn: true,
});

export const useUser = () => ({
  user: null,
  isLoaded: true,
  isSignedIn: false,
});

export const useOrganization = () => ({
  organization: null,
  isLoaded: true,
});

export const ClerkProvider = ({ children }: { children: ReactNode }) =>
  children;

export const SignIn = () => null;
export const SignUp = () => null;
export const UserButton = () => null;
export const OrganizationSwitcher = () => null;
