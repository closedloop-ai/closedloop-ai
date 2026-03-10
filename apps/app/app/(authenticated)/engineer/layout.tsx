import "./engineer-theme.css";
import { EngineerMcpProvider } from "@/contexts/engineer-mcp-context";
import { isEngineerMcpEnabled } from "@/lib/engineer/mcp-mode";
import { EngineerThemeProvider } from "./engineer-theme-provider";

export default function EngineerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <EngineerThemeProvider>
      {isEngineerMcpEnabled ? (
        <EngineerMcpProvider>{children}</EngineerMcpProvider>
      ) : (
        children
      )}
    </EngineerThemeProvider>
  );
}
