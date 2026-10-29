import { withRequestCompleted } from "@/lib/observability/with-request-completed";
import { handleDesktopReplaySnapshot } from "./handler";

export const POST = withRequestCompleted(handleDesktopReplaySnapshot);
