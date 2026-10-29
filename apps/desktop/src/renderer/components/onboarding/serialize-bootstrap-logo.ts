import {
  type DesktopBootstrapOrganizationLogo,
  desktopBootstrapOrganizationLogoSchema,
} from "@repo/api/src/types/desktop-bootstrap";

/** File objects are not preserved across Electron's structured-clone bridge. */
export async function serializeBootstrapLogo(
  file: File
): Promise<DesktopBootstrapOrganizationLogo> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onabort = () => reject(new Error("Logo read aborted"));
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("Invalid logo data"));
    reader.readAsDataURL(file);
  });
  return desktopBootstrapOrganizationLogoSchema.parse({
    name: file.name,
    type: file.type,
    base64: dataUrl.slice(dataUrl.indexOf(",") + 1),
  });
}
