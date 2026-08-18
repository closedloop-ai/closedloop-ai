import { redirect } from "next/navigation";
import { WEB_MASTER_BASE_PATH } from "./mock";

// The master shell always shows a concrete surface; Sessions is the first
// combined artifact in the sidebar, so the gallery entry lands there.
const WebMasterPrototypePage = () => {
  redirect(`${WEB_MASTER_BASE_PATH}/sessions`);
};

export default WebMasterPrototypePage;
