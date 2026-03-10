# Symphony Desktop Client Setup Guide

Get the Symphony /engineer feature running on your machine via the Electron desktop app.

## Prerequisites

- **Node.js** v20.19+ and **pnpm** installed
- **Git** and **GitHub CLI** (`gh`) installed and authenticated
- **Claude CLI** installed (`claude` command available in your PATH)
- A ClosedLoop account at [app.closedloop.ai](https://app.closedloop.ai) with an organization

## Setup Steps

### 1. Clone the Electron repo

```bash
git clone git@github.com:closedloop-ai/closedloop-electron.git
cd closedloop-electron
pnpm install
```

### 2. Generate an API key

1. Go to [app.closedloop.ai/settings?tab=integrations](https://app.closedloop.ai/settings?tab=integrations)
2. Scroll to the **API Keys** section
3. Create a new key with **read-write** scope
4. Copy the key (`sk_live_...`) — you'll need it in the next step

### 3. Start the desktop app

```bash
cd apps/desktop
pnpm dev
```

The app starts as a system tray icon and opens an onboarding window on first launch.

### 4. Complete onboarding

The desktop app will prompt you to:

1. **Paste your API key** — enter the `sk_live_...` key from step 2. The key is encrypted and stored locally via Electron's safeStorage. (Alternatively, set `CLOSEDLOOP_API_KEY` or `SYMPHONY_API_KEY` as an environment variable.)
2. **Set allowed directories** — add the workspace folder(s) where your repos live (e.g., `~/Workspace`). The app will only execute commands within these directories.

Once onboarding is complete, the app connects to the relay server (`relay.closedloop.ai`) and registers your machine as a compute target.

### 5. Select your compute target in the web app

1. Go to [app.closedloop.ai/engineer](https://app.closedloop.ai/engineer)
2. The page shows a **compute target selector** — pick your machine from the dropdown (it should show as online)
3. If you don't see it, check **Settings → Integrations** to verify your compute target is registered and online

### 6. Use /engineer

You're set. The web app sends commands through the relay to your desktop app, which executes them locally (Claude CLI, git operations, code reviews, etc.) and streams results back to the browser.

## How It Works

```
Browser (app.closedloop.ai/engineer)
  → API (/api/engineer-relay/*)
    → Relay Server (relay.closedloop.ai, Socket.IO)
      → Your Electron Desktop App (localhost:19432)
        → Executes locally (Claude CLI, git, gh, etc.)
      ← Streams events back through relay
    ← NDJSON response to browser
```

The desktop app runs a local gateway server on port 19432 (falls back to 19433-19435 if busy). The relay server brokers communication between the cloud web app and your local machine.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Compute target shows offline | Check the desktop app tray icon — is it running? Is the API key valid? |
| "Onboarding not completed" errors | Open the desktop app window (click tray icon) and finish setup |
| Port conflict on 19432 | The app auto-falls back to 19433-19435. Check if another instance is running. |
| Commands rejected | Make sure your allowed directories include the repo path you're working in |
| API key issues | Regenerate at Settings → Integrations → API Keys. Paste in desktop app settings. |
| Can't find `claude` command | Install Claude CLI and ensure it's in your PATH |


## Desktop App Settings

After onboarding, the desktop app tray menu lets you:

- **Pause/resume cloud commands** — temporarily stop accepting remote work
- **View activity log** — see recent command executions
- **Manage approvals** — review and approve/deny high-risk operations (configurable risk tiers)
- **Update allowed directories** — add or remove workspace paths
