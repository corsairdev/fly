# Corsair — Self-Hosted Instance

A single Fly.io deployment that runs your Corsair instance. One password-protected dashboard where you install plugins, connect credentials, and manage permissions. External AI clients (Claude.ai, ChatGPT) connect via MCP.

## How it works

Two processes run on one Fly machine, sharing one Postgres database and one persistent volume.

```
┌─────────────────────────────────────────────────────────────┐
│  Fly Machine                                                │
│                                                             │
│  ┌──────────────────────────┐    ┌───────────────────────┐ │
│  │  Control Server :8080    │    │  Runtime :3000        │ │
│  │  (public)                │───▶│  (internal only)      │ │
│  │                          │    │                       │ │
│  │  • Dashboard UI          │    │  • MCP server (/mcp)  │ │
│  │  • Plugin management     │    │  • Corsair instance   │ │
│  │  • Credential setup      │    │  • OAuth flows        │ │
│  │  • Permission approvals  │    │  • Key management     │ │
│  │  • MCP key management    │    │                       │ │
│  │  • Proxies everything    │    │  Restarted when       │ │
│  │    else → runtime        │    │  plugins change       │ │
│  └──────────────────────────┘    └───────────────────────┘ │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Fly Volume /workspace (persistent)                 │   │
│  │                                                     │   │
│  │  plugins.json       — which plugins are installed   │   │
│  │  src/corsair.ts     — generated from plugins.json   │   │
│  │  node_modules/      — npm packages, survives redeploy│  │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Adding a plugin

1. You click **Add** on a plugin in the dashboard
2. The control server writes the plugin to `plugins.json`
3. It regenerates `src/corsair.ts` with the new import and config
4. It runs `npm install @corsair-dev/<plugin>` into the workspace volume
5. It restarts the runtime subprocess — the new plugin is live
6. You're redirected to the credentials page to connect the integration

The Fly volume persists `node_modules`, `plugins.json`, and `corsair.ts` across both machine restarts and redeployments. Redeploying only updates the control server binary and the workspace-defaults template — it never touches the live workspace.

### Authentication

**Dashboard:** Single password (`APP_PASSWORD` env var). Correct password issues a signed session cookie (30-day expiry, stateless — no session store needed).

**MCP (Claude.ai / ChatGPT):** OAuth 2.0 Authorization Code + PKCE. You create an API key in the `/connect` page, get a `client_id` + `client_secret`, and paste them into Claude.ai when prompted. The full OAuth handshake happens automatically — you just click "Allow" once.

**Permission approvals:** When an AI agent hits an action that requires approval, it surfaces a URL like `https://<your-app>.fly.dev/approve/<token>`. The token itself is the authorization — no login needed to approve. You click the link, review the action, and approve or deny.

### Request flow

```
Claude.ai → POST /mcp
  → Control server (port 8080)
    → verifies API key / OAuth token against mcp_api_keys table
    → proxies to Runtime (port 3000)
      → corsair instance executes the tool
      → if approval required: creates corsair_permissions row, returns URL
  → 200 tool result (or approval URL)
```

---

## File reference

### Control server (`src/`)

**`src/config.ts`**
All constants in one place. This is the only file a new user needs to understand before deploying. Contains ports, paths, the public URL, dashboard password, session secret, and the internal key shared between the two processes. All values come from environment variables with sensible development defaults.

**`src/codegen.ts`**
Two responsibilities: the plugin catalog and the `corsair.ts` code generator.

The catalog is a hardcoded list of every plugin Corsair supports — id, label, npm package name, description, and auth type (OAuth / API key / bot token). Adding a plugin to the catalog makes it appear in the UI automatically.

The code generator reads `plugins.json` (stored on the Fly volume) and produces the `src/corsair.ts` file that the runtime imports. It handles the imports, the plugin list, the permission modes, and the `formatAsyncMessage` callback that tells the AI what URL to surface when an approval is needed.

**`src/manager.ts`**
Manages the runtime child process. Spawns it with `tsx`, pipes its stdout/stderr to the control server's output (prefixed with `[runtime]`), tracks its status (`starting` / `running` / `crashed` / `restarting`), and handles clean shutdown with a 5-second SIGKILL fallback. Exposes `startRuntime`, `stopRuntime`, `restartRuntime`, and `getRuntimeStatus`.

**`src/workspace.ts`**
Handles first-boot initialization. On startup, checks whether `/workspace/src` exists on the Fly volume. If not (first boot), copies `workspace-defaults/` to `/workspace/` and runs `npm install` to install the base packages. Subsequent boots skip this — the volume already has everything.

**`src/db.ts`**
Creates the `mcp_api_keys` table (owned directly by the control server). The Corsair SDK tables (`corsair_permissions`, `corsair_integrations`, etc.) are created by the runtime via the SDK's own initialization — the control server just reads `corsair_permissions` for the permissions page and approval actions.

**`src/ui.ts`**
All HTML templates as TypeScript functions. Each page is a function that takes data and returns an HTML string. No build step, no bundler, no client-side framework. Uses a single shared CSS string and a `layout()` wrapper that renders the sidebar navigation. Pages: login, plugins catalog, credentials, connect (MCP keys), permissions, and the standalone approval page.

**`src/index.ts`**
The Express application. All routes are here, grouped with comments into sections:

- **Approval pages** — `GET /approve/:token`, `POST /approve/:token/approve|deny`. Token-gated, no session required. Reads and writes `corsair_permissions` directly.
- **Auth** — `GET/POST /login`, `POST /logout`. Session cookie via `cookie-session`.
- **Session middleware** — applied to everything below; redirects to `/login` if not authenticated.
- **Plugins** — `GET /plugins` renders the catalog. `POST /api/plugins/add` installs a package and restarts the runtime. `POST /api/plugins/remove` uninstalls and restarts. `POST /api/plugins/:id/mode` changes the permission mode, regenerates `corsair.ts`, and restarts.
- **Credentials** — `GET /credentials/:plugin` shows the credentials form for an installed plugin. `POST /api/credentials/:plugin/key` saves an API key by proxying to the runtime's `/api/keys`. `POST /api/credentials/:plugin/root` saves OAuth client credentials. `POST /api/credentials/:plugin/oauth` kicks off the OAuth flow by asking the runtime for the authorization URL and redirecting the browser there.
- **Connect** — `GET /connect`, `POST /api/mcp-keys`, `POST /api/mcp-keys/:id/revoke`. MCP API key CRUD handled directly against the `mcp_api_keys` table.
- **Permissions** — `GET /permissions` reads pending rows from `corsair_permissions`. `POST /api/permissions/:id/approve|deny` updates the row. The runtime detects the status change and allows or blocks the pending tool call.
- **Proxy** — catches everything not matched above and proxies it to the runtime on port 3000. Injects `x-admin-key` so the runtime trusts admin-level calls.

---

### Runtime (`workspace-defaults/`)

This directory is copied to the Fly volume on first boot. After that, the live copy on the volume is what actually runs — this template is only used to initialize a fresh volume.

**`workspace-defaults/src/corsair.ts`**
The initial Corsair instance with no plugins. This file gets regenerated by the control server every time you add, remove, or change the permission mode of a plugin. You should never edit it directly — use the `/plugins` page instead.

**`workspace-defaults/src/db.ts`**
Minimal pg pool for the runtime process. Uses the same `DATABASE_URL` as the control server — both processes share one Postgres database.

**`workspace-defaults/src/index.ts`**
The runtime Express server. Listens on port 3000 (internal only). Routes:

- **`/mcp`** — the MCP endpoint. Verifies the request carries a valid `cors_*` API key (checked against `mcp_api_keys` table) or a live OAuth token (in-memory map). Then passes the request to the Corsair MCP server for tool execution.
- **`/.well-known/oauth-authorization-server`** and **`/.well-known/oauth-protected-resource`** — OAuth discovery endpoints. Claude.ai hits these to find the authorization and token URLs.
- **`GET/POST /authorize`** and **`POST /oauth/token`** — the OAuth 2.0 Authorization Code + PKCE server. Used when Claude.ai connects for the first time. Auth codes and tokens are kept in memory (lost on restart — users re-auth, which is seamless).
- **`POST/PATCH /api/keys`** and **`POST/PATCH /api/root-keys`** — read and write integration credentials via the Corsair key managers (which handle encryption at rest using `CORSAIR_KEK`). Called by the control server when the user saves credentials in the UI.
- **`POST /api/oauth/start`** and **`GET /api/oauth/callback`** — handles the OAuth flow for integrations (Gmail, Slack, etc.). The control server redirects the user's browser to the provider, the provider redirects back to `/api/oauth/callback`, and the runtime exchanges the code for tokens and stores them.
- **`POST /api/setup`** — creates the `corsair_integrations` and `corsair_accounts` DB rows for all installed plugins. Called automatically on startup.

**`workspace-defaults/package.json`**
Base dependencies for the runtime: `corsair`, `@corsair-dev/mcp`, `express`, `pg`, `dotenv`. No plugins — they get installed via `npm install` into the workspace volume when you add them through the UI.

---

## Secrets reference

| Secret | How to set | Purpose |
|--------|-----------|---------|
| `PUBLIC_URL` | `fly secrets set PUBLIC_URL=https://<app>.fly.dev` | OAuth redirects, approval links, MCP metadata |
| `APP_PASSWORD` | `fly secrets set APP_PASSWORD=...` | Dashboard login |
| `SESSION_SECRET` | Auto-generated by `deploy.sh` | Signs session cookies |
| `DATABASE_URL` | Auto-set by `fly postgres attach` | Postgres connection |
| `CORSAIR_KEK` | Auto-generated by `deploy.sh` | Encrypts stored integration credentials |
| `CONTROL_API_KEY` | Auto-generated by `deploy.sh` | Internal auth between control server and runtime |

## Deployment

```bash
cd fly
./deploy.sh
```

The script picks an app name, generates the secrets, creates Fly Postgres, attaches it, creates the workspace volume, sets all secrets, and deploys. After it finishes, sign in at `https://<app>.fly.dev` with your `APP_PASSWORD`.
