import { withRequestCompleted } from "@/lib/observability/with-request-completed";
import { handleDesktopOtlpExport } from "./handler";

export const POST = withRequestCompleted(handleDesktopOtlpExport);
