# Implementation Plan: Clerk Account Settings UI Integration

## Summary

- **Objective:** Restructure the `/settings` page to integrate Clerk's embeddable UI components for comprehensive account and organization management, including user profile controls, organization switcher, and admin-only organization management features.
- **In-scope:**
  - Integrate `OrganizationSwitcher` for organization selection
  - Embed `UserProfile` component for individual user settings (password, profile, security/2FA, sessions)
  - Embed `OrganizationProfile` component for organization management (members, roles, settings)
  - Implement role-based visibility using `Protect` component for admin-only sections
  - Restructure settings page into tabbed interface (Profile, Organization, Admin, Integrations)
- **Out-of-scope:**
  - Custom organization roles beyond Clerk's default `org:admin` and `org:member`
  - Custom member management UI (using Clerk's built-in components)
  - Organization billing management (Clerk provides this out-of-box)
- **Platforms:** web
- **Dependencies:**
  - `@clerk/nextjs` v6.36.7 (already installed)
  - `@clerk/themes` v2.4.42 (already installed)
  - Radix UI Tabs component (already available in design-system)

## Architecture Fit

- **Impacted routes/screens/components:**
  - `apps/app/app/(authenticated)/settings/page.tsx` - Complete restructure from simple card layout to tabbed interface
  - `apps/app/app/(authenticated)/settings/components/linear-integration-card.tsx` - Retained in Integrations tab
- **State/Storage changes:** None - all user/org state managed by Clerk
- **Integrations:**
  - Auth: Leverages existing `@repo/auth/client` exports (UserProfile, OrganizationProfile, OrganizationSwitcher, Protect)
  - Theme: Uses existing `AuthProvider` appearance customization from `packages/auth/provider.tsx`
- **Notes for Next/SSR:**
  - Settings page is client component (`"use client"`) for Clerk component interactivity
  - Clerk components handle their own SSR/hydration
  - No server-side data fetching required (Clerk manages auth state)

## Tasks (Traceable)

### task-001: Restructure settings page with tabbed navigation

**Files:** `apps/app/app/(authenticated)/settings/page.tsx`
**Complexity:** M
**AC Refs:** AC-001, AC-002, AC-003, AC-004, AC-005

**Description:** Transform the current simple card-based settings page into a tabbed interface with four tabs: Profile (user settings), Organization (org settings for all members), Admin (org admin controls), and Integrations (existing Linear integration). Use Radix Tabs components from design-system.

**Implementation Details:**

**Tab Structure Mapping:**
| Tab Name | Content | Visibility | Component Source |
|----------|---------|------------|------------------|
| Profile | User account management | All users | `<UserProfile />` from `@repo/auth/client` |
| Organization | Org settings & member list | All org members | `<OrganizationProfile />` from `@repo/auth/client` |
| Admin | Admin-only org controls | `org:admin` role only | `<Protect role="org:admin">` wrapper |
| Integrations | Linear integration card | All users | Existing `<LinearIntegrationCard />` |

**Component Structure Template:**
```tsx
"use client";

import { UserProfile, OrganizationProfile, OrganizationSwitcher, Protect } from "@repo/auth/client";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@repo/design-system/components/ui/tabs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@repo/design-system/components/ui/card";
import { Separator } from "@repo/design-system/components/ui/separator";
import { LinearIntegrationCard } from "./components/linear-integration-card";

export default function SettingsPage() {
  return (
    <div className="flex flex-1 flex-col gap-6 p-6">
      {/* Page header */}
      <div>
        <h1 className="font-semibold text-2xl tracking-tight">Settings</h1>
        <p className="text-muted-foreground">
          Manage your account settings and preferences.
        </p>
      </div>

      <Separator />

      {/* Tabbed interface */}
      <Tabs defaultValue="profile" className="flex-1">
        <TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="organization">Organization</TabsTrigger>
          <TabsTrigger value="admin">Admin</TabsTrigger>
          <TabsTrigger value="integrations">Integrations</TabsTrigger>
        </TabsList>

        {/* Tab content - see subsequent tasks */}
      </Tabs>
    </div>
  );
}
```

**Styling Notes:**
- Preserve existing page padding and gap structure (`flex flex-1 flex-col gap-6 p-6`)
- Use consistent separator between header and tabs
- Tab content should fill available vertical space

---

### task-002: Implement Profile tab with UserProfile component

**Files:** `apps/app/app/(authenticated)/settings/page.tsx`
**Complexity:** S
**AC Refs:** AC-003

**Description:** Add TabsContent for "profile" tab containing Clerk's UserProfile component. This provides built-in UI for password reset, profile management, and personal security settings (2FA, active sessions).

**Implementation Details:**

**UserProfile Integration:**
```tsx
<TabsContent value="profile" className="space-y-6">
  <Card>
    <CardHeader>
      <CardTitle>User Profile</CardTitle>
      <CardDescription>
        Manage your personal account settings, security, and profile information.
      </CardDescription>
    </CardHeader>
    <CardContent>
      <UserProfile
        appearance={{
          elements: {
            // Inherit theme from AuthProvider
            rootBox: "w-full",
            cardBox: "shadow-none border-0",
          },
        }}
      />
    </CardContent>
  </Card>
</TabsContent>
```

**UserProfile Features (built-in from Clerk):**
- **Profile tab:** Name, email, avatar upload
- **Security tab:** Password reset, 2FA enrollment, active device sessions
- No additional configuration required - Clerk handles all interactions

---

### task-003: Implement Organization tab with OrganizationProfile component

**Files:** `apps/app/app/(authenticated)/settings/page.tsx`
**Complexity:** S
**AC Refs:** AC-001, AC-002

**Description:** Add TabsContent for "organization" tab containing Clerk's OrganizationProfile component. This shows organization info to all members, and provides admin controls (member management, roles) only to org admins.

**Implementation Details:**

**OrganizationProfile Integration:**
```tsx
<TabsContent value="organization" className="space-y-6">
  <Card>
    <CardHeader>
      <CardTitle>Organization Settings</CardTitle>
      <CardDescription>
        Manage organization information, members, and roles.
      </CardDescription>
    </CardHeader>
    <CardContent>
      <OrganizationProfile
        appearance={{
          elements: {
            rootBox: "w-full",
            cardBox: "shadow-none border-0",
          },
        }}
      />
    </CardContent>
  </Card>
</TabsContent>
```

**OrganizationProfile Features (built-in from Clerk):**
- **General tab:** Org name, logo (admin: update, delete org)
- **Members tab:** View members, roles, join dates (admin: invite, change roles, remove members)
- **Verified Domains tab:** (admin only) Configure email domain verification
- Clerk automatically shows/hides admin-only features based on user's role

---

### task-004: Implement Admin tab with Protect wrapper and OrganizationSwitcher

**Files:** `apps/app/app/(authenticated)/settings/page.tsx`
**Complexity:** M
**AC Refs:** AC-002, AC-004

**Description:** Add TabsContent for "admin" tab containing admin-only controls wrapped in Clerk's Protect component. Include OrganizationSwitcher for easy org switching and additional admin-specific tools. Tab is only visible to users with `org:admin` role.

**Implementation Details:**

**Role-Based Tab Visibility:**
The Admin tab trigger should only render for org admins. Use conditional rendering based on user's role:

```tsx
import { useOrganization } from "@repo/auth/client";

export default function SettingsPage() {
  const { membership } = useOrganization();
  const isAdmin = membership?.role === "org:admin";

  return (
    // ...
    <TabsList>
      <TabsTrigger value="profile">Profile</TabsTrigger>
      <TabsTrigger value="organization">Organization</TabsTrigger>
      {isAdmin && <TabsTrigger value="admin">Admin</TabsTrigger>}
      <TabsTrigger value="integrations">Integrations</TabsTrigger>
    </TabsList>
    // ...
  );
}
```

**Admin Tab Content:**
```tsx
<TabsContent value="admin" className="space-y-6">
  <Protect
    role="org:admin"
    fallback={
      <Card>
        <CardHeader>
          <CardTitle>Access Denied</CardTitle>
          <CardDescription>
            You must be an organization admin to view this section.
          </CardDescription>
        </CardHeader>
      </Card>
    }
  >
    <Card>
      <CardHeader>
        <CardTitle>Organization Switcher</CardTitle>
        <CardDescription>
          Switch between organizations you manage.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <OrganizationSwitcher
          appearance={{
            elements: {
              rootBox: "w-full",
              organizationSwitcherTrigger: "w-full justify-between",
            },
          }}
        />
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>Advanced Organization Management</CardTitle>
        <CardDescription>
          Admin-only controls for organization configuration.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-muted-foreground text-sm">
          Additional admin controls can be added here in the future.
          For now, use the Organization tab to manage members, roles, and settings.
        </p>
      </CardContent>
    </Card>
  </Protect>
</TabsContent>
```

**Role Check Algorithm:**
1. Import `useOrganization` hook from `@repo/auth/client`
2. Extract `membership` object from hook result
3. Check if `membership.role === "org:admin"`
4. Conditionally render Admin tab trigger only for admins
5. Wrap admin tab content in `<Protect role="org:admin">` for security

---

### task-005: Implement Integrations tab with existing Linear integration

**Files:** `apps/app/app/(authenticated)/settings/page.tsx`
**Complexity:** S
**AC Refs:** AC-005

**Description:** Add TabsContent for "integrations" tab containing the existing LinearIntegrationCard component. This preserves existing functionality while organizing it within the new tabbed structure.

**Implementation Details:**

**Integrations Tab Structure:**
```tsx
<TabsContent value="integrations" className="space-y-6">
  <LinearIntegrationCard />

  {/* Placeholder for future integrations */}
  <Card>
    <CardHeader>
      <CardTitle>More Integrations</CardTitle>
      <CardDescription>
        Additional integrations will appear here as they become available.
      </CardDescription>
    </CardHeader>
  </Card>
</TabsContent>
```

**Migration Notes:**
- Move existing `<LinearIntegrationCard />` from top-level grid to Integrations tab content
- Remove old "Account" card with sign-out button (UserProfile handles sign-out)
- LinearIntegrationCard requires no changes - it's self-contained

---

### task-006: Remove obsolete account card and sign-out button

**Files:** `apps/app/app/(authenticated)/settings/page.tsx`
**Complexity:** S
**AC Refs:** AC-003

**Description:** Remove the standalone "Account" card with sign-out button since UserProfile component provides sign-out functionality in its Security tab. Clean up unused imports.

**Implementation Details:**

**Before (lines 37-59 in current file):**
```tsx
<Card>
  <CardHeader>
    <CardTitle>Account</CardTitle>
    <CardDescription>
      Manage your account settings and sign out.
    </CardDescription>
  </CardHeader>
  <CardContent>
    <div className="flex items-center justify-between">
      <div>
        <p className="font-medium">Sign out</p>
        <p className="text-muted-foreground text-sm">
          Sign out of your account on this device.
        </p>
      </div>
      <Button onClick={handleLogout} variant="destructive">
        <LogOutIcon className="mr-2 h-4 w-4" />
        Sign out
      </Button>
    </div>
  </CardContent>
</Card>
```

**After:**
- Delete entire Account card block (lines 37-59)
- Delete `handleLogout` function (lines 19-21)
- Remove unused imports: `useClerk`, `LogOutIcon`
- UserProfile's Security tab includes "Sign out from all devices" and individual session management

---

### task-007: Update AuthProvider theme elements for embedded Clerk components

**Files:** `packages/auth/provider.tsx`
**Complexity:** S
**AC Refs:** AC-001, AC-002, AC-003

**Description:** Extend the existing AuthProvider theme configuration to add styling elements for UserProfile and OrganizationProfile components when embedded in Card components (remove default shadows/borders since Card provides them).

**Implementation Details:**

**Theme Elements Addition (lines 35-44):**
```tsx
const elements: Theme["elements"] = {
  dividerLine: "bg-border",
  socialButtonsIconButton: "bg-card",
  navbarButton: "text-foreground",
  organizationSwitcherTrigger__open: "bg-background",
  organizationPreviewMainIdentifier: "text-foreground",
  organizationSwitcherTriggerIcon: "text-muted-foreground",
  organizationPreview__organizationSwitcherTrigger: "gap-2",
  organizationPreviewAvatarContainer: "shrink-0",

  // Add these for embedded profile components
  rootBox: "w-full",
  cardBox: "shadow-none border-0", // Remove Clerk's default card styling
  profileSectionPrimaryButton: "bg-primary text-primary-foreground hover:bg-primary/90",
  formButtonPrimary: "bg-primary text-primary-foreground hover:bg-primary/90",
  badge: "bg-muted text-muted-foreground",
};
```

**Rationale:**
- `rootBox: "w-full"` - Ensure Clerk components fill their container width
- `cardBox: "shadow-none border-0"` - Remove Clerk's card styling since we wrap in design-system Card
- Button/badge classes ensure consistency with design-system theme

## API & Data Models

No new API endpoints or data models required. All authentication, organization, and user management is handled by Clerk's existing infrastructure:

- **User data:** Managed via Clerk's User object (accessible via `useUser()` hook)
- **Organization data:** Managed via Clerk's Organization object (accessible via `useOrganization()` hook)
- **Membership/roles:** Handled by Clerk's membership system (`org:admin`, `org:member`)
- **Validation:** Clerk components handle all form validation internally
- **Error states:** Clerk components display inline errors for failed operations

## UX/UI Implementation

### Components to create/change

**Changed:**
- `apps/app/app/(authenticated)/settings/page.tsx` - Complete restructure to tabbed interface

**New:**
- None (using existing Clerk components and design-system primitives)

**Retained:**
- `apps/app/app/(authenticated)/settings/components/linear-integration-card.tsx` - No changes needed

### Accessibility

**Keyboard Navigation:**
- Tabs component uses Radix UI primitives with built-in arrow key navigation between tabs
- Tab + Shift+Tab navigate into/out of tab content areas
- Clerk components have built-in WCAG 2.1 AA compliance (focus management, ARIA labels)

**ARIA Labels:**
- TabsList has implicit `role="tablist"`
- TabsTrigger has `role="tab"` with `aria-selected` states
- TabsContent has `role="tabpanel"` with `aria-labelledby` linking to trigger
- Clerk components include appropriate `aria-label` attributes on interactive elements

**Screen Reader Support:**
- Page heading ("Settings") provides context via `<h1>`
- Card titles provide section landmarks via semantic heading structure
- Clerk components announce state changes (e.g., "Member added", "Password updated")

**Focus Management:**
- Tab switching moves focus to newly active TabsTrigger
- Clerk modal dialogs trap focus and return focus on close
- No custom focus management required

### Responsive/adaptive behaviors

**Breakpoints:**
- Mobile (<640px): Tabs stack vertically, Clerk components use mobile-optimized layouts
- Tablet (640-1024px): Horizontal tab list, Clerk components adjust column layouts
- Desktop (>1024px): Full horizontal layout with expanded Clerk component views

**Adaptive Notes:**
- Clerk components are responsive by default
- TabsList wraps on narrow screens if needed
- Card padding remains consistent across breakpoints
- No custom media queries required

## Tests

### Unit Tests

**File:** `apps/app/app/(authenticated)/settings/__tests__/page.test.tsx` (new file)

**Coverage:**
1. **Tab rendering:** Verify all 4 tabs render for org admins (Profile, Organization, Admin, Integrations)
2. **Role-based visibility:** Verify Admin tab hidden for non-admin users
3. **Component integration:** Verify LinearIntegrationCard renders in Integrations tab
4. **Default tab:** Verify Profile tab is active by default

**Test Structure:**
```tsx
import { render, screen } from "@testing-library/react";
import { useOrganization } from "@repo/auth/client";
import SettingsPage from "../page";

jest.mock("@repo/auth/client", () => ({
  useOrganization: jest.fn(),
  UserProfile: () => <div data-testid="user-profile" />,
  OrganizationProfile: () => <div data-testid="org-profile" />,
  OrganizationSwitcher: () => <div data-testid="org-switcher" />,
  Protect: ({ children }) => <div>{children}</div>,
}));

describe("SettingsPage", () => {
  it("renders all tabs for org admin", () => {
    (useOrganization as jest.Mock).mockReturnValue({
      membership: { role: "org:admin" },
    });
    render(<SettingsPage />);
    expect(screen.getByRole("tab", { name: /profile/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /organization/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /admin/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /integrations/i })).toBeInTheDocument();
  });

  it("hides Admin tab for non-admin users", () => {
    (useOrganization as jest.Mock).mockReturnValue({
      membership: { role: "org:member" },
    });
    render(<SettingsPage />);
    expect(screen.queryByRole("tab", { name: /admin/i })).not.toBeInTheDocument();
  });
});
```

### Integration Tests

**File:** `apps/app/app/(authenticated)/settings/__tests__/integration.test.tsx` (new file)

**Coverage:**
1. **Tab switching:** Verify clicking tab triggers switches active content
2. **Clerk component rendering:** Verify UserProfile/OrganizationProfile render in correct tabs
3. **Protect wrapper:** Verify admin content only accessible to org:admin role

### E2E Tests

**File:** `apps/app/e2e/settings.spec.ts` (new file)

**Critical Paths:**
1. **Non-admin user flow:**
   - Navigate to /settings
   - Verify Profile, Organization, Integrations tabs visible
   - Verify Admin tab not visible
   - Click through each tab, verify content loads

2. **Admin user flow:**
   - Sign in as org:admin
   - Navigate to /settings
   - Verify all 4 tabs visible including Admin
   - Click Admin tab, verify OrganizationSwitcher renders
   - Verify Protect wrapper shows admin content

3. **User profile management:**
   - Click Profile tab
   - Verify UserProfile component renders
   - Attempt password reset flow (up to email sent)

4. **Organization member management:**
   - Sign in as org:admin
   - Click Organization tab
   - Verify OrganizationProfile Members tab accessible
   - Verify member list displays

**Fixtures/Mocks:**
- Use Clerk's testing tokens for E2E (configured in `@repo/auth/keys.ts`)
- Seed test organization with admin and member users
- No custom mocks needed for unit/integration tests (Jest mocks sufficient)

## Telemetry & Observability

### Analytics Events

**Event:** `settings_tab_viewed`
- **Props:** `{ tab_name: "profile" | "organization" | "admin" | "integrations", user_role: "org:admin" | "org:member" }`
- **Trigger:** User clicks tab trigger
- **Implementation:** Add event tracking to TabsTrigger onClick handler

**Event:** `clerk_component_interaction`
- **Props:** `{ component_type: "UserProfile" | "OrganizationProfile" | "OrganizationSwitcher", action: string }`
- **Trigger:** User interacts with Clerk component (password change, member invite, etc.)
- **Implementation:** Clerk components emit webhook events (configure in Clerk dashboard)

**Event:** `settings_page_loaded`
- **Props:** `{ has_admin_access: boolean, organization_id: string }`
- **Trigger:** Settings page mounts
- **Implementation:** useEffect hook on mount

### Error Boundaries

**Boundary:** Wrap entire settings page in ErrorBoundary
- **File:** `apps/app/app/(authenticated)/settings/error.tsx` (new)
- **Fallback UI:** Show error message with "Reload page" button
- **Logging:** Send error to Sentry with context (user ID, org ID, active tab)

**Clerk Component Errors:**
- Clerk components handle their own error states inline
- No additional error boundary needed
- Errors logged to Clerk dashboard automatically

### Logs & Dashboards

**Logs:**
- Log tab switches at info level: `logger.info("Settings tab viewed", { tab, userId, orgId })`
- Log component mount/unmount at debug level
- Clerk API errors logged automatically via Clerk SDK

**Dashboard Metrics:**
- Track settings page visit rate (daily active users viewing settings)
- Track tab engagement (which tabs most frequently viewed)
- Monitor Clerk component interaction rates (profile updates, member invites)
- Alert on elevated error rates from Clerk components

## Performance & Security

### Performance

**Risks:**
- Clerk components load external assets (fonts, icons) - potential network latency
- Multiple Clerk components on one page may increase initial bundle size

**Mitigations:**
- Lazy load tab content: Only render Clerk components when tab is active
  ```tsx
  <TabsContent value="profile">
    {activeTab === "profile" && <UserProfile />}
  </TabsContent>
  ```
- Leverage Next.js code splitting - Clerk components auto-split via dynamic imports
- Clerk components use CDN-cached assets with aggressive caching headers
- Expected bundle size increase: ~45KB gzipped (acceptable for settings page)

**Benchmarks:**
- Target: Settings page interactive within 2s on 3G connection
- Lighthouse Performance score target: >90
- Clerk component render time: <300ms per component

### Security

**Risks:**
- Admin controls accessible to non-admin users if Protect wrapper fails
- Session hijacking could expose sensitive user/org data in Clerk components
- XSS vulnerabilities if Clerk components render user-supplied content unsafely

**Mitigations:**
- **Defense in depth:** Use both `useOrganization()` hook check (UI) and `<Protect>` wrapper (security)
- **Server-side validation:** Clerk enforces role checks server-side - client-side checks are UI-only
- **Session security:** Clerk manages session tokens with short expiry (10min default) and automatic refresh
- **XSS protection:** Clerk components sanitize all user-supplied content (names, emails, org names)
- **CSRF protection:** Clerk API requests include anti-CSRF tokens automatically
- **Content Security Policy:** Verify `packages/security` CSP allows Clerk domains (clerk.com, accounts.dev)

**Privacy:**
- User profile data (email, name) only visible to user themselves
- Organization member list visible to all org members (expected behavior)
- Admin-only data (audit logs, verified domains) only accessible via `org:admin` role
- No analytics events include PII - only user/org IDs (hashed)

## Release & Ops

### Feature Flags & Rollout

**Flag:** `clerk_settings_ui_enabled`
- **Type:** Boolean (default: false)
- **Rollout Plan:**
  1. Enable for internal team members only (Week 1)
  2. Enable for 10% of organizations (Week 2)
  3. Enable for 50% of organizations (Week 3)
  4. Enable for 100% (Week 4)
- **Implementation:** Check flag in settings page, render old UI if false
  ```tsx
  import { useFeatureFlag } from "@repo/feature-flags";

  export default function SettingsPage() {
    const newUIEnabled = useFeatureFlag("clerk_settings_ui_enabled");
    return newUIEnabled ? <NewSettingsUI /> : <LegacySettingsUI />;
  }
  ```

### Build/CI/CD Updates

**Build:**
- No build script changes required
- Verify Clerk environment variables present in CI: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`

**CI:**
- Add settings page tests to Jest test suite (existing CI step)
- Add E2E settings tests to Playwright suite (existing CI step)
- Verify linting passes with new imports (`pnpm lint`)

**CD:**
- Deploy to staging first, manual QA of all 4 tabs
- Verify Clerk components render correctly in production Clerk environment
- Monitor Sentry for errors in first 24h after production deploy

### Docs to Update

**User Documentation:**
- Update "Account Settings" doc page with screenshots of new tabbed interface
- Add section on "Organization Management" explaining admin controls
- Document how to reset password, manage 2FA, view active sessions

**Developer Documentation:**
- Add ADR (Architecture Decision Record) for using Clerk components over custom UI
- Update component inventory with Clerk component usage examples
- Document how to add new tabs to settings page

**API Documentation:**
- No API changes - Clerk components use Clerk's hosted APIs

## Risks / Open Questions

### Risks

1. **Clerk component styling conflicts:** Clerk's default styles may conflict with design-system theme
   - **Mitigation:** Test thoroughly in both light/dark modes, override via `appearance` prop
   - **Severity:** Medium (visual bugs, non-blocking)

2. **Organization switcher confusion:** Users may accidentally switch orgs while configuring settings
   - **Mitigation:** Place OrganizationSwitcher in Admin tab only, add confirmation dialog
   - **Severity:** Low (reversible action)

3. **Breaking change for users with muscle memory:** Existing users expect simple settings page
   - **Mitigation:** Use feature flag for gradual rollout, provide in-app announcement
   - **Severity:** Low (UX friction, not functional breakage)

### Open Questions

1. **Should OrganizationSwitcher also appear in the sidebar header?**
   - Investigation log suggests this as an option
   - Recommendation: Start with Admin tab only, gather user feedback
   - Decision owner: Product team

2. **Do we need custom organization roles beyond org:admin and org:member?**
   - Current codebase has no custom role references
   - Recommendation: Start with defaults, extend later if needed via Clerk dashboard
   - Decision owner: Product team

3. **Should the Integrations tab include a "Coming soon" section for future integrations?**
   - Current implementation includes placeholder card
   - Recommendation: Keep placeholder to signal roadmap
   - Decision owner: Product team

4. **Is there a need for organization-level 2FA enforcement settings?**
   - Clerk's OrganizationProfile includes this by default in verified domains
   - No custom implementation needed
   - Decision owner: Security team

## Traceability

See `traceability.csv` for detailed acceptance criteria → tasks → tests mapping.
