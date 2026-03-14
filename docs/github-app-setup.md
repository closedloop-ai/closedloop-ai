# GitHub App Setup Guide

This guide covers setting up the ClosedLoop GitHub App for development, staging, and production environments.

## Overview

ClosedLoop uses a **GitHub App** (not a standalone OAuth App) to:
1. **Track installations** - Know which GitHub orgs have installed ClosedLoop
2. **Dispatch workflows** - Trigger GitHub Actions in customer repositories
3. **Access repositories** - Read code and create PRs on behalf of the installation
4. **Authenticate users** - Verify users have access to claimed installations via OAuth

### Why a GitHub App (not OAuth App)?

- GitHub Apps are installed at the org/account level with explicit permissions
- They provide `installation_id` for multi-tenant tracking
- They support both server-to-server (installation tokens) and user-to-server (OAuth) authentication
- They have granular, per-repo permissions

### Connect Flow

```mermaid
sequenceDiagram
    participant User
    participant ClosedLoop
    participant GitHub

    User->>ClosedLoop: Click "Connect GitHub"
    ClosedLoop->>ClosedLoop: Generate CSRF state token
    ClosedLoop->>GitHub: Redirect to install page with state
    User->>GitHub: Install app + authorize OAuth

    par Race Condition Handling
        GitHub-->>ClosedLoop: Webhook: installation.created
        Note over ClosedLoop: Creates record with PENDING_CLAIM<br/>(may arrive before or after OAuth)
    and
        GitHub->>ClosedLoop: OAuth callback with code + installation_id + state
    end

    ClosedLoop->>ClosedLoop: Validate state (CSRF protection)
    ClosedLoop->>GitHub: Exchange code for user token
    ClosedLoop->>GitHub: GET /user (fetch GitHub user info)
    ClosedLoop->>GitHub: GET /user/installations (verify access)

    alt Installation record exists (webhook arrived first)
        ClosedLoop->>ClosedLoop: Update existing record
    else Installation record missing (OAuth arrived first)
        ClosedLoop->>ClosedLoop: Create record from GitHub API data
    end

    ClosedLoop->>ClosedLoop: Set status=ACTIVE, link to org
    ClosedLoop->>GitHub: GET /user/installations/{id}/repositories
    ClosedLoop->>ClosedLoop: Sync repositories
    ClosedLoop->>User: Connected!
```

### Disconnect Flow

```mermaid
sequenceDiagram
    participant User
    participant ClosedLoop
    participant GitHub

    User->>ClosedLoop: Click "Disconnect GitHub"
    ClosedLoop->>ClosedLoop: Show confirmation dialog
    User->>ClosedLoop: Confirm disconnect

    ClosedLoop->>GitHub: DELETE /app/installations/{id}
    Note over GitHub: Uninstalls app from GitHub side

    par Webhook may arrive
        GitHub-->>ClosedLoop: Webhook: installation.deleted
        Note over ClosedLoop: Sets status=UNINSTALLED,<br/>organizationId=null
    end

    ClosedLoop->>ClosedLoop: Update DB: status=UNINSTALLED,<br/>organizationId=null
    ClosedLoop->>User: Disconnected!

    Note over User,GitHub: User can now reconnect with fresh OAuth flow
```

### Reconnect After Disconnect

When a user disconnects and then reconnects:

1. **Disconnect** sets `status: UNINSTALLED` and `organizationId: null`
2. **Reconnect** triggers new `installation.created` webhook
3. Webhook sees `status: UNINSTALLED` → does NOT preserve old `organizationId`
4. Installation starts fresh with `PENDING_CLAIM` status
5. OAuth callback claims it normally

## Environment Variables Required

| Variable | Where Used | Description |
|----------|------------|-------------|
| `GITHUB_APP_ID` | API server | Numeric App ID from GitHub App settings |
| `GITHUB_APP_PRIVATE_KEY` | API server | PEM private key for generating installation tokens |
| `GITHUB_APP_WEBHOOK_SECRET` | API server | Secret for verifying webhook signatures |
| `GITHUB_APP_CLIENT_SECRET` | API server | OAuth client secret for user authorization |
| `GITHUB_APP_CLIENT_ID` | API server | OAuth client ID for token exchange |
| `GITHUB_APP_DISPATCH_REPO` | API server | Fallback repo for workflow dispatch (legacy, will be deprecated) |
| `NEXT_PUBLIC_GITHUB_APP_SLUG` | App (frontend) | App's URL slug for install links |

## Creating a GitHub App

### Step 1: Navigate to GitHub App Settings

**For organization-owned apps:**
1. Go to your GitHub organization
2. Click **Settings** > **Developer settings** > **GitHub Apps**
3. Click **New GitHub App**

**For personal account apps (dev only):**
1. Go to GitHub **Settings** > **Developer settings** > **GitHub Apps**
2. Click **New GitHub App**

### Step 2: Basic Information

| Field | Value |
|-------|-------|
| **GitHub App name** | `symphony-{env}` (e.g., `symphony-stage`, `symphony-prod`) |
| **Description** | ClosedLoop AI-powered software delivery platform |
| **Homepage URL** | `https://{your-domain}` |

### Step 3: Callback URLs

Set the **Callback URL** (User authorization callback URL):
- Local: `http://localhost:3000/api/integrations/github/callback`
- Staging: `https://app.stage.yourdomain.com/api/integrations/github/callback`
- Production: `https://app.yourdomain.com/api/integrations/github/callback`

> **Important:** You can add multiple callback URLs. Add your local URL for development alongside the deployed URL.

### Step 4: Post Installation Settings

| Field | Value |
|-------|-------|
| **Setup URL** | Leave blank |
| **Redirect on update** | Unchecked |
| **Request user authorization (OAuth) during installation** | **CHECKED** (Critical!) |

> **Critical:** The "Request user authorization (OAuth) during installation" checkbox MUST be enabled. This is GitHub's "golden standard" - it combines app installation with OAuth authorization in a single step, providing both `code` and `installation_id` in the callback.

### Step 5: Webhook Configuration

| Field | Value |
|-------|-------|
| **Active** | Checked |
| **Webhook URL** | `https://api.{your-domain}/webhooks/github` |
| **Webhook secret** | Generate a secure random string (save this for `GITHUB_APP_WEBHOOK_SECRET`) |

For local development, use a tunnel service like ngrok:
```bash
ngrok http 3002
# Use the ngrok URL: https://abc123.ngrok.io/webhooks/github
```

### Step 6: Permissions

#### Repository Permissions

| Permission | Access Level | Reason |
|------------|--------------|--------|
| **Actions** | Read and write | Trigger workflow dispatch, read workflow runs |
| **Contents** | Read | Read repository files for code analysis |
| **Metadata** | Read | Required for basic repo info |
| **Pull requests** | Read and write | Create PRs for generated code |
| **Workflows** | Read and write | Manage workflow files |

#### Organization Permissions

| Permission | Access Level | Reason |
|------------|--------------|--------|
| **Members** | Read | Verify org membership during claiming |

#### Account Permissions

None required.

### Step 7: Subscribe to Events

Check the following webhook events:

- **Installation** - `installation.created`, `installation.deleted`, `installation.suspend`, `installation.unsuspend`
- **Installation repositories** - `installation_repositories.added`, `installation_repositories.removed`
- **Workflow run** - `workflow_run.completed`, `workflow_run.requested`

### Step 8: Where Can This App Be Installed?

Choose based on your needs:
- **Only on this account** - For internal/private use
- **Any account** - For public/marketplace distribution

### Step 9: Create the App

Click **Create GitHub App**.

## Gathering Credentials

After creating the app, gather these values:

### 1. App ID and Client ID

From the app's **General** settings page:
- **App ID** → `GITHUB_APP_ID` (numeric, e.g., `123456`)
- **Client ID** → `GITHUB_APP_CLIENT_ID` (e.g., `Iv1.abc123def456`)

### 2. App Slug

The **slug** is the URL-friendly identifier that appears in your GitHub App's public URL. It's typically a lowercase, hyphenated version of your app name.

```
https://github.com/apps/closedloop-ai-stage
                        ^^^^^^^^^^^^^^^^^^^ This is the slug
```

**ClosedLoop's actual slugs:**
| Environment | Slug | Install URL |
|-------------|------|-------------|
| Production | `closedloop-ai` | `https://github.com/apps/closedloop-ai` |
| Staging | `closedloop-ai-stage` | `https://github.com/apps/closedloop-ai-stage` |

→ `NEXT_PUBLIC_GITHUB_APP_SLUG` = `closedloop-ai` (prod) or `closedloop-ai-stage` (stage)

### 3. Client Secret

1. Scroll to **Client secrets** section
2. Click **Generate a new client secret**
3. Copy immediately (shown only once!)
→ `GITHUB_APP_CLIENT_SECRET`

### 4. Private Key

1. Scroll to **Private keys** section
2. Click **Generate a private key**
3. A `.pem` file downloads automatically
4. The content of this file is your `GITHUB_APP_PRIVATE_KEY`

**For environment variables**, the private key must be properly formatted:
```bash
# Option 1: Base64 encode it
cat symphony-stage.pem | base64 -w 0
# Then decode in your app

# Option 2: Replace newlines with \n
cat symphony-stage.pem | awk 'NF {sub(/\r/, ""); printf "%s\\n",$0;}'

# Option 3: Use the actual newlines in your .env file (requires quotes)
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA...
...
-----END RSA PRIVATE KEY-----"
```

### 5. Webhook Secret

This is the secret you generated in Step 5:
→ `GITHUB_APP_WEBHOOK_SECRET`

## Environment Configuration

### Local Development (.env.local)

```bash
# apps/api/.env.local (all GitHub secrets live here)
GITHUB_APP_ID="123456"
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIE....\n-----END RSA PRIVATE KEY-----"
GITHUB_APP_WEBHOOK_SECRET="your-webhook-secret"
GITHUB_APP_CLIENT_ID="Iv1.abc123"
GITHUB_APP_CLIENT_SECRET="your-client-secret"
GITHUB_APP_DISPATCH_REPO="your-org/your-repo"

# apps/app/.env.local (only the public slug needed for install URL)
# Use your personal dev app slug or the staging slug for local testing
NEXT_PUBLIC_GITHUB_APP_SLUG="closedloop-ai-stage"
```

### Staging / Production

Add these secrets to your deployment platform (Vercel, AWS Secrets Manager, etc.):

```bash
# Staging
GITHUB_APP_ID=<staging-app-id>
GITHUB_APP_PRIVATE_KEY=<base64-encoded-or-escaped-pem>
GITHUB_APP_WEBHOOK_SECRET=<webhook-secret>
GITHUB_APP_CLIENT_SECRET=<client-secret>
GITHUB_APP_CLIENT_ID=<staging-client-id>
GITHUB_APP_DISPATCH_REPO=closedloop-ai/symphony-alpha
NEXT_PUBLIC_GITHUB_APP_SLUG=closedloop-ai-stage

# Production
GITHUB_APP_ID=<prod-app-id>
GITHUB_APP_PRIVATE_KEY=<base64-encoded-or-escaped-pem>
GITHUB_APP_WEBHOOK_SECRET=<webhook-secret>
GITHUB_APP_CLIENT_SECRET=<client-secret>
GITHUB_APP_CLIENT_ID=<prod-client-id>
GITHUB_APP_DISPATCH_REPO=closedloop-ai/symphony-alpha
NEXT_PUBLIC_GITHUB_APP_SLUG=closedloop-ai
```

## Multi-Environment Setup

**Do NOT share the same GitHub App between staging and production.**

### Why Separate Apps?

1. **Webhooks** - Each app has one webhook URL. You can't route staging events to staging and prod events to prod with one app.
2. **Security isolation** - Compromised staging credentials shouldn't affect production.
3. **Testing** - You can test installation flows without affecting production users.

### Recommended Setup

| Environment | GitHub App Name | Slug | Webhook URL |
|-------------|-----------------|------|-------------|
| Local | Personal dev app | (your dev slug) | `https://{ngrok-id}.ngrok.io/webhooks/github` |
| Staging | closedloop-ai-stage | `closedloop-ai-stage` | `https://api.stage.symphony.closedloop.ai/webhooks/github` |
| Production | closedloop-ai | `closedloop-ai` | `https://api.symphony.closedloop.ai/webhooks/github` |

### Shared Local Development

For team development, you can share a single "dev" GitHub App:
1. Create `symphony-dev` owned by your organization
2. Use a shared ngrok account or a stable tunnel URL
3. Share credentials via 1Password/secrets manager

## Testing the Integration

### 1. Verify Webhook Connectivity

After setup, GitHub shows delivery status in **App Settings** > **Advanced** > **Recent Deliveries**.

### 2. Test Installation Flow

1. Navigate to Settings > Integrations in ClosedLoop
2. Click "Connect GitHub"
3. Should redirect to GitHub App installation page
4. Select an org/account and repositories
5. Authorize OAuth (combined with installation)
6. Should redirect back to ClosedLoop with "Connected" status

### 3. Test Webhook Events

Install/uninstall the app and check:
- `installation.created` → Creates `GitHubInstallation` with `PENDING_CLAIM` status
- `installation.deleted` → Updates status to `UNINSTALLED`

## Troubleshooting

### "OAuth state mismatch" error

- Cookies may have expired (10 min timeout)
- User took too long to complete installation
- Try the flow again

### "Not authenticated" error on callback

- User wasn't signed into ClosedLoop when GitHub redirected back
- Ensure user is signed in before clicking "Connect GitHub"

### Webhook not received

1. Check GitHub App settings > Advanced > Recent Deliveries
2. Verify webhook URL is correct and accessible
3. Check webhook secret matches `GITHUB_APP_WEBHOOK_SECRET`
4. Check API server logs for signature verification errors

### "Installation not found" when claiming

This error should be rare since the OAuth callback now handles the race condition by fetching installation details from GitHub API if the webhook hasn't arrived yet. If you still see this error:

- The user may not have access to the installation they're trying to claim
- Check GitHub App settings > Advanced > Recent Deliveries for webhook status
- Verify the user completed the app installation (not just OAuth)

### Private key format issues

The most common issue. Ensure:
- Key includes `-----BEGIN RSA PRIVATE KEY-----` and `-----END RSA PRIVATE KEY-----`
- Newlines are preserved (use `\n` or actual newlines in quotes)
- No extra whitespace at start/end

## Security Considerations

1. **Never commit credentials** - Use environment variables or secrets managers
2. **Rotate keys periodically** - Generate new private keys and client secrets
3. **Limit permissions** - Only request permissions actually needed
4. **Audit installations** - Regularly review which orgs have installed the app
5. **Monitor webhooks** - Set up alerting for failed webhook deliveries

## References

- [GitHub Apps Documentation](https://docs.github.com/en/apps/creating-github-apps)
- [GitHub App Permissions](https://docs.github.com/en/rest/overview/permissions-required-for-github-apps)
- [Generating User Access Tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [Webhook Events](https://docs.github.com/en/webhooks/webhook-events-and-payloads)
