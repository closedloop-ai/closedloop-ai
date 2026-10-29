import { DesktopReleaseLinuxUpdaterMetadataAssetName } from "@repo/api/src/types/desktop-release";
import { withRequestCompleted } from "@/lib/observability/with-request-completed";
import { getDesktopUpdaterFeed } from "../updater-feed-service";

export const GET = withRequestCompleted((request: Request) =>
  getDesktopUpdaterFeed(request, DesktopReleaseLinuxUpdaterMetadataAssetName)
);
