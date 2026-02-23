import "./engineer-theme.css";
import { EngineerThemeProvider } from "./engineer-theme-provider";

export default function EngineerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <EngineerThemeProvider>{children}</EngineerThemeProvider>;
}
