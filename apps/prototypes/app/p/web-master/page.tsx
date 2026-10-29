import { WEB_MASTER_BASE_PATH } from "@repo/app/shell/v2/components/web-master-preview/mock";
import { redirect } from "next/navigation";

// Dashboard is the single prototype entry point; onboarding begins in its
// blocking FTUE modal.
const WebMasterPrototypePage = () => {
  redirect(`${WEB_MASTER_BASE_PATH}/dashboard`);
};

export default WebMasterPrototypePage;
