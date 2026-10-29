// gardener-support: test and story data, not shipped
import type { CliTool } from "./session-types";

export const cliTools: CliTool[] = [
  {
    id: "claude",
    name: "Claude",
    description: "Used for Claude Code session ingestion and hook wiring.",
    path: "/Applications/Claude.app/Contents/MacOS/Claude",
    hint: "Detected from the installed desktop app bundle.",
    state: "detected",
  },
  {
    id: "codex",
    name: "Codex",
    description: "Used for Codex session capture and approval prompts.",
    path: "/usr/local/bin/codex",
    hint: "Custom override saved for this machine.",
    state: "custom",
  },
  {
    id: "python3",
    name: "Python 3",
    description: "Required by importers and pack install tooling.",
    path: "/tmp/venv/bin/python3",
    hint: "This path does not exist or is not executable.",
    state: "invalid",
  },
  {
    id: "git",
    name: "Git",
    description:
      "Required for PR extraction, diff inspection, and repo metadata.",
    path: "",
    hint: "Reset to auto-detect or provide a valid executable path.",
    state: "missing",
  },
];
