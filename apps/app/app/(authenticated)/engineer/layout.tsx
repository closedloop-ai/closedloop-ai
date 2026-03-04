import "./engineer-theme.css";
import { EngineerTransportBootstrap } from "@/components/engineer/engineer-transport-bootstrap";
import { EngineerMcpProvider } from "@/contexts/engineer-mcp-context";
import { isEngineerMcpEnabled } from "@/lib/engineer/mcp-mode";
import { EngineerThemeProvider } from "./engineer-theme-provider";

export default function EngineerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const content = (
    <>
      <EngineerTransportBootstrap />
      {children}
    </>
  );

  return (
    <EngineerThemeProvider>
      {isEngineerMcpEnabled ? (
        <EngineerMcpProvider>{content}</EngineerMcpProvider>
      ) : (
        content
      )}
    </EngineerThemeProvider>
  );
}
