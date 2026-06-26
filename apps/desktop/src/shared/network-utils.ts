export function isLoopbackIPv4(hostname: string): boolean {
  if (!hostname.startsWith("127.")) {
    return false;
  }
  const parts = hostname.split(".");
  if (parts.length !== 4) {
    return false;
  }
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}
