# Analytics Package Guidelines

- Keep PostHog/analytics runtime selection and feature-flag client compatibility inside `@repo/analytics`; app, auth, route, and service modules should consume analytics package APIs instead of switching between analytics runtimes directly.
- When a shared service/helper is used by both Next.js route code and non-Next runtimes such as Socket.IO, do not use inline dynamic imports to choose runtime-specific dependencies. Require the runtime entrypoint to inject the dependency from a top-level import, for example `@repo/analytics/server` in Next-owned modules and `@repo/analytics/node` in standalone server modules.
