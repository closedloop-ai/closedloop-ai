import { ClientRedirect } from "@/components/client-redirect";

export default function App() {
  // Work around a Next App Router dev bug triggered by server redirects here.
  return <ClientRedirect href="/my-tasks" />;
}
