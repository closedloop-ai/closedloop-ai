import { withRequestCompleted } from "@/lib/observability/with-request-completed";

export const GET = withRequestCompleted(
  (): Response => new Response("OK", { status: 200 })
);
