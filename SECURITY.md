# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest `main` | Yes |
| Older deploys | Security fixes only |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email: security@closedloop.ai

- Response time: 48 hours acknowledgment, 7 days triage
- Include: description, reproduction steps, affected versions, potential impact
- We will confirm receipt, investigate, and coordinate a fix before any public disclosure

## Security Architecture

### Authentication & Authorization

- **Clerk** handles all authentication (SSO, social login, email/password, MFA)
- **JWT validation** on every API route via `withAuth()` wrapper
- **Organization isolation** — all database queries scoped by `organizationId` from JWT
- **Role-based access** — Clerk organization roles (`org:admin`, `org:owner`, `org:member`) gate admin features

### Application Security

- **Nosecone** — security headers via `@nosecone/next`
- **Webhook verification** — GitHub (HMAC SHA-256), Clerk (Svix), Stripe (SDK), all with timing-safe comparison
- **Environment variable validation** — Zod schemas via `@t3-oss/env-nextjs` at startup
- **`server-only` imports** — critical packages prevent accidental client-side inclusion

### Data Handling

- Multi-tenant isolation with organization-scoped queries throughout
- OAuth tokens (Linear, Slack) stored in database with refresh token rotation
- GitHub App credentials stored as environment variables, not in database
- S3 artifact storage with presigned URLs for access control

## Scope

**In-scope** for security reports:

- Authentication or authorization bypass
- Cross-tenant data leakage
- Webhook signature verification bypass
- API route access without proper authentication
- Command injection via Engineer feature routes
- OAuth token exposure or mishandling

**Out-of-scope:**

- Issues in upstream dependencies (Clerk, Stripe, GitHub) — report to those providers
- Theoretical vulnerabilities without proof of concept
- UI-only display preferences not enforced server-side (non-security cosmetic gating)
