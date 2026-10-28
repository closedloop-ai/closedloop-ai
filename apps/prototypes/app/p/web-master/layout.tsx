import { WebMasterPreviewShell } from "@repo/app/shell/v2/components/web-master-preview/web-master-preview-shell";
import Image from "next/image";
import type { ReactNode } from "react";
import { prototypeNavigationAdapter } from "@/lib/navigation/next-prototype-adapter";

const WebMasterLayout = ({ children }: { children: ReactNode }) => (
  <WebMasterPreviewShell
    imageComponent={Image}
    navigationAdapter={prototypeNavigationAdapter}
  >
    {children}
  </WebMasterPreviewShell>
);

export default WebMasterLayout;
