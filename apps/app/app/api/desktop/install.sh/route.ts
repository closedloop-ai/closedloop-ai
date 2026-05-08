import { DESKTOP_INSTALLER_SCRIPT } from "@/lib/desktop-installer-script";

export function GET() {
  return new Response(DESKTOP_INSTALLER_SCRIPT, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/x-shellscript; charset=utf-8",
    },
  });
}
