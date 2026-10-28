import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

/**
 * The provider stack the Sessions page requires but these suites used to omit
 * (ISS-7869).
 *
 * The summary strip's connect ask reads the GitHub integration status, and
 * `useApiClient()` runs at hook level — it needs an `<ApiAdapterProvider>`
 * ancestor whether or not the query is enabled. Production mounts one at the
 * app root; these render sites did not.
 *
 * A fresh `QueryClient` per render keeps suites from sharing cache state,
 * nested INSIDE the story providers' own client so it is the one the read hooks
 * resolve; retries are off so a failing read surfaces immediately instead of
 * being retried past the assertion.
 */
export function SessionsPageTestProviders({
  children,
}: {
  children: ReactNode;
}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <AppCoreStoryProviders>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </AppCoreStoryProviders>
  );
}
