# claude-router

A local HTTP router for Claude Code. Routes each request to either `api.anthropic.com` or a local LiteLLM gateway based on the model name and current Anthropic quota state. As a side effect, captures `anthropic-ratelimit-*` response headers and writes a one-line status file at `~/.claude/usage-status.md` so Claude can read its own quota state.

> Forked from [InertiaUK/claude-quota-proxy](https://github.com/InertiaUK/claude-quota-proxy), which provided the original transparent-proxy implementation and usage-file design. LiteLLM fallback, multi-model routing, and the rename are downstream additions.

**Works with Claude Code (CLI) only.** The web chat and browser extension talk to Anthropic's infrastructure directly — they don't route through a local proxy.

## What it does

The router has three capabilities that can be used independently:

1. **Quota visibility** — always on. Forwards every request to Anthropic unchanged, scrapes the `anthropic-ratelimit-*` response headers, and writes a one-line status file at `~/.claude/usage-status.md`. Claude reads that file to know how close it is to the 5-hour, 7-day, and overage limits.

2. **LiteLLM fallback** — opt-in via `LITELLM_URL`. When any utilization window hits a configured threshold, `claude-*` requests are redirected to a local LiteLLM instance with the body's `model` field rewritten to a tier-matched substitute (`opus`, `sonnet`, `haiku`). Non-Anthropic models (`gpt-*`, `gemini-*`, etc.) always go to LiteLLM regardless of quota, with the body forwarded as-is.

3. **Composer 2.5** — opt-in via `CURSOR_API_KEY`. Routes requests to Cursor's Composer 2.5 model via native Anthropic↔OpenAI translation, enabling Claude Code to use Composer as an alternative model alongside Anthropic and LiteLLM options. Switch by naming any model matching `composer-*` (e.g. `composer-2.5`). By default this talks to Cursor's backend directly so your key never leaves for a third party (see [Direct Cursor mode](#direct-cursor-mode-default)); set `CURSOR_DIRECT=0` to use the hosted relay instead.

If both `LITELLM_URL` and `CURSOR_API_KEY` are unset, claude-router is byte-identical to a pure passthrough: no body buffering, no model inspection, no background probe.

## How it works

```
Claude Code
   │
   │ ANTHROPIC_BASE_URL=http://127.0.0.1:4080
   ▼
┌─────────────────────────────────────────────────────┐
│ proxy.js (single Node.js script, zero npm deps)     │
│                                                     │
│  1. classify request                                │
│       claude-*  → Anthropic   (or LiteLLM if over)  │
│       other     → LiteLLM     (always)              │
│                                                     │
│  2. forward, read response headers                  │
│  3. write ~/.claude/usage-status.md                 │
│  4. probe Anthropic every 5min while redirected     │
└─────────────────────────────────────────────────────┘
   │                          │
   ▼                          ▼
api.anthropic.com (HTTPS)   localhost:4000 (LiteLLM, optional)
```

Claude Code honors the `ANTHROPIC_BASE_URL` environment variable. Point it at the router (`http://127.0.0.1:4080`) and all API traffic flows through it. claude-router is a single Node.js script with zero npm dependencies. It runs as a Windows service (via NSSM), launchd agent (macOS), or systemd user unit (Linux).

## Quick start

1. Set `ANTHROPIC_BASE_URL=http://127.0.0.1:4080` in your environment.
2. Install claude-router as a background service (see [Installation](#installation)).
3. (Optional) Set `LITELLM_URL` and `LITELLM_API_KEY` to enable fallback to a LiteLLM gateway.
4. Restart Claude Code. Ask "what's my current quota usage?" — Claude will read `~/.claude/usage-status.md`.

## Installation

### Windows

Requires Node.js and an admin PowerShell session. NSSM is downloaded automatically.

```powershell
# Run as Administrator
& "path\to\claude-router\install-service.ps1"
```

The script:
- Validates Node.js is on PATH.
- Resolves your user profile path.
- Downloads NSSM to `./tools/nssm.exe`.
- Registers `ClaudeRouter` as an auto-starting Windows service running under `LocalSystem`.
- Sets `ANTHROPIC_BASE_URL=http://127.0.0.1:4080` as a user environment variable.

Close all Claude Code windows and open a fresh one — existing sessions inherited their env before the install.

To uninstall:

```powershell
# Run as Administrator
& "path\to\claude-router\uninstall-service.ps1"
```

### macOS (launchd)

Create `~/Library/LaunchAgents/com.claude-router.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claude-router</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/path/to/claude-router/proxy.js</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key>
    <string>/path/to/claude-router/proxy.log</string>
    <key>StandardErrorPath</key>
    <string>/path/to/claude-router/proxy-error.log</string>
    <!-- Add <key>EnvironmentVariables</key><dict>…</dict> for LITELLM_URL etc. -->
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.claude-router.plist
```

Add to `~/.zshrc` or `~/.bash_profile`:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:4080
```

### Linux (systemd user unit)

Create `~/.config/systemd/user/claude-router.service`:

```ini
[Unit]
Description=Claude Router

[Service]
ExecStart=/usr/bin/node /path/to/claude-router/proxy.js
Environment=CLAUDE_USAGE_FILE=%h/.claude/usage-status.md
# Optional — enable LiteLLM fallback:
# Environment=LITELLM_URL=http://localhost:4000
# Environment=LITELLM_API_KEY=sk-...
Restart=always
StandardOutput=append:/path/to/claude-router/proxy.log
StandardError=append:/path/to/claude-router/proxy-error.log

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable claude-router
systemctl --user start claude-router
```

Add to `~/.bashrc` or `~/.zshrc`:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:4080
```

## Configuration

All claude-router settings are environment variables. Only `ANTHROPIC_BASE_URL` (on the Claude Code side) is required.

### Quota visibility (always on)

| Variable | Purpose | Default |
|----------|---------|---------|
| `CLAUDE_USAGE_FILE` | Path to the usage status file Claude reads. | `~/.claude/usage-status.md` |
| `PORT` | TCP port the proxy listens on. | `4080` |
| `BIND` | Bind address. | `127.0.0.1` |

### LiteLLM fallback (opt-in)

The fallback feature activates only when `LITELLM_URL` is set. All other variables in this table are no-ops while it is unset.

| Variable | Purpose | Default |
|----------|---------|---------|
| `LITELLM_URL` | LiteLLM base URL, e.g. `http://localhost:4000`. **Feature gate** — unset disables the LiteLLM half of the router. | unset |
| `LITELLM_API_KEY` | Bearer token sent on every LiteLLM-bound request. Required when `LITELLM_URL` is set. | unset |
| `LITELLM_FALLBACK_OPUS` | Model name substituted into the body when a `claude-opus-*` request is redirected. Empty string disables (causes 500 on opus redirects). | `claude-opus-4-7` |
| `LITELLM_FALLBACK_SONNET` | Same, for `claude-sonnet-*`. | `claude-sonnet-4-6` |
| `LITELLM_FALLBACK_HAIKU` | Same, for `claude-haiku-*`. | `claude-haiku-4-5` |
| `REDIRECT_AT_5H_PCT` | 5-hour utilization threshold (integer 1–100). | `90` |
| `REDIRECT_AT_7D_PCT` | 7-day utilization threshold. | `90` |
| `REDIRECT_AT_OVERAGE_PCT` | Overage utilization threshold. | `80` |
| `HYSTERESIS_PCT` | How far below the threshold every window must drop before switching back to Anthropic. Prevents oscillation. | `5` |
| `PROBE_INTERVAL_MS` | Background probe period while in redirect mode (ms). | `300000` (5 min) |
| `PROBE_MODEL` | Model used in probe `count_tokens` requests. | `claude-haiku-4-5` |
| `ANTHROPIC_API_KEY_FOR_PROBES` | Dedicated Anthropic key for probe requests. When set, the cached client bearer is never used for probes. | unset |
| `MAX_BUFFER_BYTES` | Maximum body size buffered on `/v1/messages` and `/v1/messages/count_tokens`. Requests exceeding this return 413. | `10485760` (10 MB) |
| `ANTHROPIC_HOST_OVERRIDE` | Override Anthropic target as `host[:port]`. **Test seam — not for production.** | `api.anthropic.com:443` |

### Composer 2.5 (opt-in)

The Composer feature activates only when `CURSOR_API_KEY` is set. All other variables in this table are no-ops while it is unset.

| Variable | Purpose | Default |
|----------|---------|---------|
| `CURSOR_API_KEY` | Bearer token sent on every Composer-bound request. **Feature gate** — unset disables Composer. Obtain from Cursor Dashboard → Integrations. | unset |
| `COMPOSER_API_URL` | Composer API base URL. **Host-only** — scheme, host, and port are used; any path component in the URL is ignored, since the fixed route `/opencodev2/v1/chat/completions` is always appended. | `https://cursor-api.standardagents.ai` |

**How to use:** Set your `CURSOR_API_KEY` from the Cursor Dashboard (Integrations section), then in Claude Code select a model name starting with `composer` — e.g. type `composer-2.5` when prompted for a model. The router translates your Anthropic Messages API request to OpenAI chat-completions format, forwards it to Composer, and translates the response back. Streaming is fully supported.

**Known limitations (best-effort):**
- `tool_result` errors (`is_error: true`) are forwarded as plain tool-role content with no structured error marker — OpenAI's tool role has no error channel.
- Image input is best-effort; some image formats may not round-trip perfectly.
- Token usage is estimated by composer-api and displayed for reference only — it does not update the `~/.claude/usage-status.md` quota file.
- Composer is **explicit-only** — it is never used as a quota fallback target when `LITELLM_URL` is configured. Name `composer-*` explicitly to route to Composer.

### Direct Cursor mode (default)

Composer requests talk to Cursor's AgentService backend (`api2.cursor.sh`) **directly** by default, so your API key never transits a third-party relay. The alternative — the hosted relay at `cursor-api.standardagents.ai`, which forwards your key to Cursor — is available by opting out.

**Activation:** direct mode is **on by default** whenever `CURSOR_API_KEY` is set. To opt out and use the hosted relay instead, set `CURSOR_DIRECT=0`.

**Configuration variables:**

| Variable | Purpose | Default |
|----------|---------|---------|
| `CURSOR_DIRECT` | Direct-mode routing. On by default when `CURSOR_API_KEY` is set; set to `0` to opt out (use the hosted relay). | `1` (on) |
| `CURSOR_BACKEND_BASE_URL` | Cursor backend base URL. | `https://api2.cursor.sh` |
| `CURSOR_LOCAL_AGENT_ENDPOINT` | Full URL to Cursor's AgentService/Run endpoint. **Must be a complete URL**, not host-only. | `https://api2.cursor.sh/agent.v1.AgentService/Run` |
| `CURSOR_SDK_CLIENT_VERSION` | SDK client version string sent in request headers. | `sdk-1.0.13` |

**How it works:** Requests are translated from Anthropic format to OpenAI format, then to Cursor's AgentService over HTTP/2 using ConnectRPC and protobuf encoding. The connection is bidirectional: the proxy sends a run request, Cursor's backend responds with text and tool data as protobuf interaction updates, and the proxy answers a mid-stream request-context handshake before continuing to receive tool and completion messages. Responses are translated back to Anthropic format. Streaming is fully supported. Tool-calling and images (best-effort) work as with the hosted relay.

**Privacy:** In direct mode, your API key and prompts are sent only to `api2.cursor.sh` (Cursor). In hosted mode, they go to `cursor-api.standardagents.ai` which forwards them to Cursor. Neither mode sends data to the router itself.

#### ⚠️ Caveats

- **Impersonation:** Direct mode sends request headers identifying the client as an SDK instance (SDK client version `sdk-1.0.13`). This is necessary to reach Cursor's private AgentService backend, but it impersonates the Cursor SDK.
- **Terms of Service:** Using direct mode may violate Cursor's Terms of Service. The user assumes all responsibility for compliance and any consequences of using this feature.
- **Fragility:** The AgentService endpoint (`agent.v1.AgentService/Run`), protocol version, or client headers may change without notice. If Cursor updates any of these, direct mode may break (e.g., 502 or a Connect protocol error). The error message will name the `CURSOR_LOCAL_AGENT_ENDPOINT` env var so you can override it if needed.
- **Best-effort:** Images are handled best-effort; some formats may not round-trip. Sampling parameters (`temperature`, `top_p`) are not honored by Cursor's backend.

**Troubleshooting:** If you see a 502 error naming `CURSOR_LOCAL_AGENT_ENDPOINT`, the endpoint is not reachable or not recognized. Verify that `CURSOR_LOCAL_AGENT_ENDPOINT` points to the correct `agent.v1.AgentService/Run` URL, or file an issue with the raw error message from the logs.

## Routing reference

### Dispatch rules

| Request body `model` | Quota state | Upstream | Body rewritten? |
|---|---|---|---|
| `claude-opus-*` | below threshold | Anthropic | no |
| `claude-sonnet-*` | below threshold | Anthropic | no |
| `claude-haiku-*` | below threshold | Anthropic | no |
| `claude-opus-*` | at/above threshold | LiteLLM | yes → `LITELLM_FALLBACK_OPUS` |
| `claude-sonnet-*` | at/above threshold | LiteLLM | yes → `LITELLM_FALLBACK_SONNET` |
| `claude-haiku-*` | at/above threshold | LiteLLM | yes → `LITELLM_FALLBACK_HAIKU` |
| `claude-*` (unknown tier) | at/above threshold | LiteLLM | no (forwarded as-is) |
| `composer-*` | any | Composer | no (translated to OpenAI format) |
| anything else (`gpt-*`, `gemini-*`, …) | any | LiteLLM | no |
| body unparseable / missing model | any | Anthropic (fail-safe) | no |

Tier classification is by case-insensitive substring match: a model name containing `opus` is opus-tier, `sonnet` is sonnet-tier, `haiku` is haiku-tier. Anything else starting with `claude-` is "unknown tier".

Endpoints other than `/v1/messages` and `/v1/messages/count_tokens` always go to Anthropic without body inspection.

### Redirect engagement

- **Redirect engages** when **any one** of the three utilization windows reaches its threshold.
- **Switch-back requires all three** windows to drop below `threshold − HYSTERESIS_PCT` (default 5 points).
- Each mode transition logs a line: `[proxy] mode transition: anthropic -> litellm (5h=…%, 7d=…%, overage=…%)`.
- Each dispatched request logs a line: `[proxy] dispatch: anthropic|litellm reason=… model=… [rewrite=…]`.

### Background probe

While in redirect mode no Anthropic responses are arriving, so quota state cannot update from live traffic. claude-router fires a minimal `POST /v1/messages/count_tokens` against Anthropic every `PROBE_INTERVAL_MS`:

- Uses `ANTHROPIC_API_KEY_FOR_PROBES` if set; otherwise the most recently captured client `authorization` / `x-api-key` header.
- If no client auth has been captured yet and no probe key is configured, the tick is skipped.
- After three consecutive probe failures (e.g. 401), the interval doubles up to a 1-hour cap.
- When a client request arrives with a different auth value (key rotation), backoff is reset and the probe fires at the original cadence.

The probe response carries fresh `anthropic-ratelimit-*` headers, which update in-memory quota state and may trigger a switch back to Anthropic.

## Usage output

`~/.claude/usage-status.md` is overwritten on every Anthropic response (and every probe response while redirected):

```
5h=9% 7d=99%! overage=0% bottleneck=seven_day (10/05/2026, 16:19:04)
```

- **5h** — rolling 5-hour window utilization
- **7d** — rolling 7-day window utilization
- **overage** — paid burst pool (available once 7d is exhausted)
- **`!`** suffix — that window returned an `allowed_warning` status
- **bottleneck** — which window Anthropic currently considers binding

One unified pool covers all models. There is no separate Sonnet or Opus pool despite the Claude Code UI showing individual bars.

### Letting Claude read it

Once the proxy is running, ask Claude:

> What's my current quota usage?

Claude reads `~/.claude/usage-status.md` and reports the values. The file is updated on every request so it's always current.

### CLAUDE.md rules

Add a rule to your global `~/.claude/CLAUDE.md` so Claude adjusts behavior based on quota state. Examples ranked from light to strict:

**Report at session start**

```markdown
## Quota awareness
At the start of each session, read `~/.claude/usage-status.md` and report the 5h and 7d usage.
If either shows `!`, flag it.
```

**Warn before large tasks**

```markdown
## Quota awareness
Before any task involving more than ~10 tool calls or significant code generation,
read `~/.claude/usage-status.md`. If 7d usage is above 80%, say so and confirm before proceeding.
If 7d is above 95%, ask whether to continue or defer until the window resets.
```

**Adjust approach by usage level**

```markdown
## Quota awareness
Read `~/.claude/usage-status.md` at the start of each session.

- Below 70% on both windows: normal operation
- 70–90% on 7d: prefer concise responses, avoid spawning multiple subagents unless necessary
- Above 90% on 7d: lightweight mode — short responses, no subagents, note that quota is low
- `!` on any window: mention it before starting multi-step tasks
```

**Hard stop near limit**

```markdown
## Quota awareness
Read `~/.claude/usage-status.md` at the start of each session. If 7d usage is above 98%,
do not start new implementation tasks. Explain the quota state and suggest resuming tomorrow
or switching to a lighter approach.
```

### Auto-inject via hook

Instead of asking Claude to read the file, inject it into every prompt via a `UserPromptSubmit` hook. Add to your Claude Code `settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "pwsh -NoProfile -Command \"$f='$env:USERPROFILE\\.claude\\usage-status.md'; if (Test-Path $f) { $c=Get-Content $f -Raw; Write-Output (ConvertTo-Json @{hookSpecificOutput=@{hookEventName='UserPromptSubmit';additionalContext=$c}}) }\""
          }
        ]
      }
    ]
  }
}
```

On macOS/Linux, swap the command for a shell equivalent reading `~/.claude/usage-status.md`.

## Operational notes

### Buffering

When `LITELLM_URL` is set, `/v1/messages` and `/v1/messages/count_tokens` request bodies are buffered up to `MAX_BUFFER_BYTES` (10 MB default) so the model field can be inspected. Oversized bodies return 413 before any upstream call. Streaming-response bodies (from either upstream) are not buffered — they are piped straight back to the client.

If `LITELLM_URL` is unset, no body buffering occurs at all and the router is a pure pipe.

### Body parse failures

If `/v1/messages` is called with a malformed JSON body, the request is forwarded to Anthropic with the original bytes intact and logged as `dispatch: anthropic reason=parse-failed-fail-safe`. This is a deliberate fail-safe: routing a parse failure to LiteLLM would change semantics for a request claude-router doesn't understand.

### Auth-cache threat model

When `ANTHROPIC_API_KEY_FOR_PROBES` is unset, the background probe reuses the cached client `authorization` / `x-api-key` header. This cache is:

- In-memory only — never written to disk.
- Lives for the router process lifetime.
- Used exclusively for probe calls to `api.anthropic.com:443` over TLS.
- Never logged. Never sent to LiteLLM.

For security-conscious deployments, set `ANTHROPIC_API_KEY_FOR_PROBES` to a dedicated probe-only Anthropic key. This eliminates the cached-bearer scope entirely.

### Single-tenancy

claude-router assumes **one Anthropic account per running instance**. Sharing one router across multiple Anthropic accounts causes:

- Quota-state pollution (utilization is aggregated across accounts).
- Probe-credential cross-contamination (the cached auth may not belong to the account being probed).

Run a separate router on a separate port for each Anthropic account.

## Rate-limit headers reference

All headers observed on a Claude Max plan account (confirmed 2026-05-10):

| Header | Example value | Notes |
|--------|--------------|-------|
| `anthropic-ratelimit-unified-5h-utilization` | `0.09` | Decimal fraction — multiply by 100 for % |
| `anthropic-ratelimit-unified-7d-utilization` | `0.99` | |
| `anthropic-ratelimit-unified-overage-utilization` | `0.0` | Paid burst pool |
| `anthropic-ratelimit-unified-representative-claim` | `seven_day` | Which window is the bottleneck |
| `anthropic-ratelimit-unified-5h-status` | `allowed` / `allowed_warning` | |
| `anthropic-ratelimit-unified-7d-status` | `allowed_warning` | |
| `anthropic-ratelimit-unified-fallback-percentage` | `0.5` | Throttle applied if over limit |
| `anthropic-ratelimit-unified-upgrade-paths` | `overage` | Available options when at limit |

## Design notes

**Why HTTP for the local connection?** `ANTHROPIC_BASE_URL=http://…` makes the SDK speak plain HTTP to claude-router — no localhost certificate management. The router makes a separate HTTPS connection to the real API.

**Why LocalSystem for the Windows service?** Avoids storing user credentials in the service config. The install script bakes your actual home path into `CLAUDE_USAGE_FILE` at install time instead.

**Why NSSM?** One binary, no npm dependencies, handles log rotation, clean install/uninstall. `node-windows` downloads its own binary at install time and requires npm — same outcome with more moving parts.

**Why fail-safe on parse failure?** A malformed body claude-router can't read might still be valid to Anthropic (e.g. SDK version skew) but is unlikely to make sense to a LiteLLM gateway with rewritten routing. Defaulting to Anthropic preserves Claude Code's expected behavior for requests the router doesn't understand.

**Why probe with `count_tokens`?** It's the cheapest Anthropic endpoint that still returns the unified rate-limit headers. Minimal token cost while redirected.

## Testing

```bash
npm test
# or directly:
node --test tests/smoke.test.js
```

Tests use Node's built-in `node:test` (Node ≥ 18). Zero npm dependencies. Local mock servers on ephemeral ports — no real Anthropic or LiteLLM calls.

## Files

```
claude-router/
  proxy.js                zero-dependency Node.js router
  install-service.ps1     Windows service installer (run as admin)
  uninstall-service.ps1   Windows service uninstaller (run as admin)
  tests/
    smoke.test.js         smoke test suite (node:test, no npm deps)
  tools/
    nssm.exe              downloaded by install-service.ps1
  proxy.log               stdout (1 MB rotation via NSSM)
  proxy-error.log         stderr
```

## License

MIT — see [LICENSE](LICENSE). Originally forked from [InertiaUK/claude-quota-proxy](https://github.com/InertiaUK/claude-quota-proxy).
