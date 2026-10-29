import { withRequestCompleted } from "@/lib/observability/with-request-completed";
import {
  DesktopUpdaterFeedCacheControl as feedCacheControl,
  getDesktopUpdaterFeed,
} from "../updater-feed-service";

export const DesktopUpdaterFeedCacheControl = feedCacheControl;

export const GET = withRequestCompleted((request: Request) =>
  getDesktopUpdaterFeed(request)
);
