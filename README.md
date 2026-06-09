# claude-router

A local HTTP router for Claude Code. Routes each request to either `api.anthropic.com` or a local LiteLLM gateway based on the model name and current Anthropic quota state. As a side effect, captures `anthropic-ratelimit-*` response headers and writes a one-line status file at `~/.claude/usage-status.md` so Claude can read its own quota state.

> Forked from [InertiaUK/claude-quota-proxy](https://github.com/InertiaUK/claude-quota-proxy), which provided the original transparent-proxy implementation and usage-file design. LiteLLM fallback, multi-model routing, and the rename are downstream additions.

**Works with Claude Code (CLI) only.** The web chat and browser extension talk to Anthropic's infrastructure directly — they don't route through a local proxy.

## What it does

The router has four capabilities that can be used independently:

1. **Quota visibility** — always on. Forwards every request to Anthropic unchanged, scrapes the `anthropic-ratelimit-*` response headers, and writes a one-line status file at `~/.claude/usage-status.md`. Claude reads that file to know how close it is to the 5-hour, 7-day, and overage limits.

2. **LiteLLM fallback** — opt-in via `LITELLM_URL`. When any utilization window hits a configured threshold, `claude-*` requests are redirected to a local LiteLLM instance with the body's `model` field rewritten to a tier-matched substitute (`opus`, `sonnet`, `haiku`). Non-Anthropic models (`gpt-*`, `gemini-*`, etc.) always go to LiteLLM regardless of quota, with the body forwarded as-is.

3. **Composer 2.5** — opt-in via `CURSOR_API_KEY`. Routes requests to Cursor's Composer 2.5 model via native Anthropic↔OpenAI translation, enabling Claude Code to use Composer as an alternative model alongside Anthropic and LiteLLM options. Switch by naming any model matching `composer-*` (e.g. `composer-2.5`).

4. **Model-list aggregation** — automatic whenever LiteLLM and/or Composer is enabled. Intercepts `GET /v1/models` (the Anthropic Models API endpoint that backs Claude Code's model-selection dialog) and returns a single merged list: Anthropic's own models, plus every LiteLLM model (translated to Anthropic shape), plus synthetic Composer entries. Without this, the dialog only ever sees Anthropic models.

If both `LITELLM_URL` and `CURSOR_API_KEY` are unset, claude-router is byte-identical to a pure passthrough: no body buffering, no model inspection, no background probe, and `GET /v1/models` forwards straight to Anthropic.

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
| `COMPOSER_MODELS` | Comma-separated Composer model ids surfaced in the merged `GET /v1/models` list (see below). Each id must match the `composer-*` routing pattern so a selected id round-trips back to Composer. | `composer-2.5` |

**How to use:** Set your `CURSOR_API_KEY` from the Cursor Dashboard (Integrations section), then in Claude Code select a model name starting with `composer` — e.g. type `composer-2.5` when prompted for a model. The router translates your Anthropic Messages API request to OpenAI chat-completions format, forwards it to Composer, and translates the response back. Streaming is fully supported.

**Known limitations (best-effort):**
- `tool_result` errors (`is_error: true`) are forwarded as plain tool-role content with no structured error marker — OpenAI's tool role has no error channel.
- Image input is best-effort; some image formats may not round-trip perfectly.
- Token usage is estimated by composer-api and displayed for reference only — it does not update the `~/.claude/usage-status.md` quota file.
- Composer is **explicit-only** — it is never used as a quota fallback target when `LITELLM_URL` is configured. Name `composer-*` explicitly to route to Composer.

### Model-list aggregation (`GET /v1/models`)

Claude Code's model-selection dialog is backed by the Anthropic **Models API** — `GET /v1/models`, which returns `{ data: [{ type, id, display_name, created_at, … }], has_more, first_id, last_id }`. By default the router forwards that request straight to Anthropic, so the dialog only lists Anthropic's own models.

Whenever LiteLLM and/or Composer is enabled, the router instead **intercepts `GET /v1/models`** and answers with a merged list:

1. **Anthropic** is fetched first and is the source of truth. It is also the auth gate: a non-2xx Anthropic response (e.g. `401`) is passed through verbatim, so credential errors still surface correctly. The response's `anthropic-ratelimit-*` headers are scraped exactly as on any other Anthropic call, so quota tracking keeps working off model-list traffic.
2. **LiteLLM** models are fetched from `GET {LITELLM_URL}/v1/models` (OpenAI-shaped) and translated to Anthropic `ModelInfo` objects. A LiteLLM outage is non-fatal — those models are simply omitted.
3. **Composer** models are appended synthetically from `COMPOSER_MODELS` (Composer exposes no model list of its own).

Entries are concatenated in that priority order and de-duplicated by `id` (so a LiteLLM-exposed `claude-*` won't shadow the native Anthropic entry). The merged response always sets `has_more: false` — pagination is collapsed into a single page.

#### Name remapping (`claude-router-` prefix)

Claude Code's model-selection dialog only accepts model ids matching `^(claude|anthropic)` — so a raw `gemini-3.1-pro-preview` or `composer-2.5` would be filtered out. To get them accepted, the router **remaps every foreign id** (any id not already starting with `claude`/`anthropic`) into a reserved namespace before listing it:

```
gemini-3.1-pro-preview   →  claude-router-gemini-3.1-pro-preview
composer-2.5             →  claude-router-composer-2.5
claude-opus-4-7 (litellm)→  claude-opus-4-7        (already accepted — left as-is)
```

Only the `id` is wrapped; `display_name` keeps the real model name, so the picker stays readable. When a request later arrives with a `claude-router-*` model, the router **demaps it back to the real id and rewrites the request body** before routing, so the underlying backend (Composer / LiteLLM) receives the genuine model name and the dispatch rules below classify it correctly. Demapping is a no-op for ordinary `claude-*` requests and for real foreign ids you send directly (e.g. `claude --model gemini-3.1-pro-preview` still works unchanged). `claude-router-` is a reserved prefix — Anthropic ships no model under it.

#### 1M-context variants (`[1m]`)

Claude Code reads a model's context window from a literal `[1m]` suffix in the id (`/\[1m\]/i` → 1,000,000 tokens) and, when it sees one, also adds the `context-1m-2025-08-07` beta header to the request. The router can offer a 1M variant of a foreign model by listing a second `[1m]`-suffixed entry — set `MODELS_1M` to the comma-separated **real** ids (post-demap) that should get one:

```
MODELS_1M=gemini-3.1-pro-preview,composer-2.5
```

For each listed model the merged list gains an extra entry — e.g. `claude-router-gemini-3.1-pro-preview[1m]`, shown as `gemini-3.1-pro-preview (1M context)` — alongside the default 200K base entry. When such a variant is selected:

- **The `[1m]` suffix is stripped on demap** (along with the prefix), so the backend gets the plain real id — `claude-router-gemini-3.1-pro-preview[1m]` → `gemini-3.1-pro-preview`.
- **The `context-1m-2025-08-07` beta header is dropped** before forwarding to LiteLLM/Composer, since those backends don't understand it (unrelated betas are preserved).

`MODELS_1M` is opt-in and defaults to empty — only add models whose backend genuinely serves a large window, since the suffix makes Claude Code treat the model as 1M-token locally (affecting compaction/usage math). This applies **only** to the router's `claude-router-*` namespace: a native `claude-opus-4-8[1m]` request has no prefix, so its id and its 1M beta header pass through to Anthropic completely untouched.

**Client-side caveat.** Whether the *dialog* renders these entries still depends on the Claude Code build: model discovery is also gated client-side, and surfacing the list may additionally require the relevant flag (e.g. `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`) or an `availableModels` allowlist entry, depending on version. The remapping removes the `^(claude|anthropic)` id-filter obstacle; the router serving a correct, filter-passing merged `/v1/models` is the provider-agnostic, forward-compatible piece.

## Routing reference

### Dispatch rules

| Request body `model` | Quota state | Upstream | Body rewritten? |
|---|---|---|---|
| `claude-router-*` (remapped dialog pick) | any | demapped to real id, then re-classified by the rows below | yes → real id |
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

`GET /v1/models` is intercepted and answered with a merged model list (see [Model-list aggregation](#model-list-aggregation-get-v1models)) whenever LiteLLM and/or Composer is enabled; otherwise, and for every other endpoint, requests go to Anthropic without body inspection.

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
