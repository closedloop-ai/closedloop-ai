import "./engineer-theme.css";
import { EngineerMcpProvider } from "@/contexts/engineer-mcp-context";
import { EngineerThemeProvider } from "./engineer-theme-provider";

export default function EngineerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <EngineerThemeProvider>
      <EngineerMcpProvider>{children}</EngineerMcpProvider>
    </EngineerThemeProvider>
  );
}
