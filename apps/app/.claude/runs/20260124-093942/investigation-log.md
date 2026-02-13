# Investigation Log: Clerk Account Settings UI Integration

## Search Strategy Log

| Command | Results |
|---------|---------|
| `Glob **/settings/**/*.{tsx,ts}` | 2 files: page.tsx, linear-integration-card.tsx |
| `Glob **/packages/auth/**/*.{tsx,ts}` | 8 files in auth package |
| `Grep "UserProfile\|OrganizationProfile\|OrganizationSwitcher"` | 0 files - not currently used |
| `Grep "org:\|organization\|admin\|role"` | 30+ files with org references |
| `Grep "useAuth\|useUser\|useOrganization\|Protect"` | 1 file (security package) |
| `Grep "currentUser\|auth()"` | Multiple files using auth pattern |

## Files Discovered

### Source Files
- `apps/app/app/(authenticated)/settings/page.tsx` - Current settings page (minimal)
- `apps/app/app/(authenticated)/settings/components/linear-integration-card.tsx` - Linear OAuth integration card
- `apps/app/app/(authenticated)/layout.tsx` - Auth layout with user/org checks
- `apps/app/app/(authenticated)/components/sidebar.tsx` - Navigation sidebar
- `packages/auth/client.ts` - Re-exports `@clerk/nextjs` (v6.36.7)
- `packages/auth/server.ts` - Re-exports `@clerk/nextjs/server`
- `packages/auth/provider.tsx` - ClerkProvider with theme customization

### Type/Schema Files
- `packages/auth/keys.ts` - Environment validation for Clerk keys
- `packages/design-system/components/ui/tabs.tsx` - Radix Tabs component

### Related Patterns
- `apps/app/app/(authenticated)/webhooks/page.tsx` - Example of iframe-based portal integration

## Key Findings

### 1. Current Settings Page Structure (apps/app/app/(authenticated)/settings/page.tsx:1-62)
- Simple page with only two cards:
  - `LinearIntegrationCard` - OAuth integration for Linear
  - Account card with sign-out button
- Uses `useClerk()` hook for sign-out functionality
- No Clerk profile/organization components currently used

### 2. Auth Package Structure (packages/auth/)
- **client.ts**: Re-exports all of `@clerk/nextjs` - includes access to:
  - `UserProfile`, `UserButton`
  - `OrganizationProfile`, `OrganizationSwitcher`, `OrganizationList`
  - `useUser`, `useOrganization`, `useAuth`, `useClerk`
  - `Protect` component for role-based access
- **server.ts**: Re-exports `@clerk/nextjs/server` including `auth()`, `currentUser()`
- **provider.tsx**: Custom `AuthProvider` wrapping `ClerkProvider` with theme customization
- **Version**: `@clerk/nextjs` v6.36.7, `@clerk/themes` v2.4.42

### 3. Organization Context Already Used (apps/app/app/(authenticated)/)
- `layout.tsx:19`: Uses `auth()` for redirectToSignIn
- `page.tsx:29`: Uses `auth()` to get `orgId`
- `search/page.tsx:27`: Uses `auth()` for `orgId`
- Pattern: `const { orgId } = await auth()` common throughout

### 4. Clerk Components Available (from @clerk/nextjs v6.36.7)

**User Management:**
- `<UserProfile />` - Full-featured user account management
  - Profile tab: name, email, avatar
  - Security tab: password, 2FA, active sessions
  - Can add custom pages

**Organization Management:**
- `<OrganizationProfile />` - Organization settings and member management
  - General tab: org info, leave org (admin: update, delete, verified domains)
  - Members tab: view members, roles, join dates (admin: invite, change roles, remove)
  - Billing tab: plans, invoices, payment methods
- `<OrganizationSwitcher />` - Switch between organizations
- `<OrganizationList />` - Display available organizations
- `<CreateOrganization />` - Create new organization

**Access Control:**
- `<Protect />` - Role-based content rendering
- `useOrganization()` - Hook for org context including user's role
- Default roles: `org:admin` (full access), `org:member` (limited)

### 5. Design System Components Available
- `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` (packages/design-system/components/ui/tabs.tsx)
- `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`
- `Separator`
- Existing theme integration in `AuthProvider` with dark mode support

### 6. Provider Setup (packages/auth/provider.tsx:35-44)
Already has organization-related theming:
```tsx
const elements: Theme["elements"] = {
  organizationSwitcherTrigger__open: "bg-background",
  organizationPreviewMainIdentifier: "text-foreground",
  organizationSwitcherTriggerIcon: "text-muted-foreground",
  // ...
};
```

## Implementation Approach

### Recommended Architecture
1. **Restructure `/settings` as a tabbed interface** using existing Tabs components
2. **Tab Structure:**
   - **Profile** - Embed `<UserProfile />` for user account management
   - **Organization** - Embed `<OrganizationProfile />` for org settings (visible to all org members)
   - **Admin** - Admin-only section using `<Protect role="org:admin">` with advanced org controls
   - **Integrations** - Keep existing `LinearIntegrationCard`

3. **Use Clerk's built-in components** rather than custom implementations:
   - Password reset, 2FA, sessions handled by `<UserProfile />`
   - Member management, invitations handled by `<OrganizationProfile />`
   - Role checking via `useOrganization()` hook or `<Protect />` component

4. **Role-based visibility:**
   ```tsx
   import { Protect } from "@repo/auth/client";

   <Protect role="org:admin">
     <AdminSection />
   </Protect>
   ```

### Key Implementation Decisions
- **Embed vs Route**: Clerk components can be embedded inline (recommended for settings page) or mounted at dedicated routes
- **Appearance**: Leverage existing `AuthProvider` appearance customization
- **No custom member management needed**: `OrganizationProfile` handles invites, role changes, removals

## Requirements Mapping

| Requirement | Clerk Component | Evidence |
|-------------|-----------------|----------|
| OrgSelector/switcher | `<OrganizationSwitcher />` | Already themed in provider.tsx |
| Add/remove org members | `<OrganizationProfile />` Members tab | Admin-only features built-in |
| Enable/configure 2FA | `<UserProfile />` Security tab | Personal 2FA management |
| Manage org roles | `<OrganizationProfile />` Members tab | Built-in role management |
| Password reset | `<UserProfile />` Security tab | Built-in |
| Profile management | `<UserProfile />` Profile tab | Built-in |
| Security settings (sessions) | `<UserProfile />` Security tab | Shows active sessions |
| Admin section for org admins | `<Protect role="org:admin">` wrapper | Role-based rendering |

## Uncertainties

**Question:** Should the Organization tab be visible to all members or only admins?
- `<OrganizationProfile />` shows appropriate content based on role automatically
- Recommendation: Show to all, let Clerk handle permission-based UI

**Question:** Are custom org roles needed beyond default `org:admin` and `org:member`?
- Current codebase only uses `orgId`, no custom role references found
- Recommendation: Start with defaults, can add custom roles later if needed

**Question:** Should OrganizationSwitcher be added to the settings page or kept in sidebar/header?
- Currently using `UserButton` in sidebar footer
- Could add `OrganizationSwitcher` to header or settings page
- Recommendation: Add to settings page under Organization section, optionally also in sidebar header

**Unclear:** What specific admin controls beyond member management are needed?
- Clerk provides: member invites, role changes, member removal, verified domains, delete org
- Are additional custom admin features required?
