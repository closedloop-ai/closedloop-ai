import { notFound } from "next/navigation";
import { env } from "@/env";
import { ErrorBoundaryValidationTrigger } from "./error-boundary-validation-trigger";

/**
 * ISS-6996: a route that throws on purpose, so an e2e can prove that Next's
 * FILE CONVENTION routes a render failure to `app/error.tsx`. Mounting the
 * boundary component in a unit test proves it handles an error; only a real
 * navigation proves it is the file Next hands the boundary at build time.
 *
 * Kept away from real users the way `/rum-validation` is: the route 404s unless
 * a server-only env var is set, and it is set in exactly one place — the
 * `app-visual` compose service the containerized e2e drives. No deployed
 * environment sets it.
 */
// Without this the page has no dynamic input and Next prerenders it AT BUILD,
// where the env var is absent — baking the 404 in and making the gate
// unopenable at runtime.
export const dynamic = "force-dynamic";

export default function ErrorBoundaryValidationPage() {
  if (env.ERROR_BOUNDARY_VALIDATION_ROUTE_ENABLED !== "true") {
    notFound();
  }

  // plain <div>, not <main>: the shell's SidebarInset owns the page's single main landmark (no-nested-main-landmark gate).
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
      <h1 className="font-semibold text-lg">Error boundary validation</h1>
      <ErrorBoundaryValidationTrigger />
    </div>
  );
}
