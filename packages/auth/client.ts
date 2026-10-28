// biome-ignore lint/performance/noBarrelFile: re-exporting Clerk auth client
export * from "@clerk/nextjs";
/**
 * These SHADOW the bare Clerk re-exports above (an explicit export wins over a
 * star export), so every consumer gets the lane-aware versions without changing
 * its import. Each returns Clerk's own hook or component untouched unless the
 * `AUTH_MODE=local_trusted` identity context is mounted, which no real
 * deployment does (ISS-10335, ISS-12054).
 */
export {
  CreateOrganization,
  OrganizationProfile,
  Show,
  UserProfile,
} from "./local-trusted-components";
export {
  useAuth,
  useClerk,
  useOrganization,
  useOrganizationList,
  useReverification,
  useSession,
  useUser,
} from "./local-trusted-hooks";
