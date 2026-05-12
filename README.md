# anthropic-quota-proxy

A local HTTP proxy that makes Claude Code aware of its own usage limits.

**Works with Claude Code (CLI) only.** The web chat and browser extension make requests directly from Anthropic's infrastructure — they don't go through a local proxy and can't use this.

Claude Code (Max plan) shows usage bars for the 5-hour and 7-day quota windows in the UI. The model itself has no access to those values — there's no API, no tool, no hook that exposes them during a conversation. This proxy sits between Claude Code and `api.anthropic.com`, captures the rate-limit headers on every response, and writes a one-line status file that Claude can read any time.

## How it works

Claude Code respects the `ANTHROPIC_BASE_URL` environment variable. Set it to `http://127.0.0.1:4080` and all API traffic routes through the proxy. The proxy forwards every request unchanged, reads the rate-limit response headers, and writes `~/.claude/usage-status.md`. Claude reads that file when it needs to know the current quota state.

```
Claude Code → HTTP → 127.0.0.1:4080 (proxy) → HTTPS → api.anthropic.com
                              ↓
                    captures response headers
                              ↓
                ~/.claude/usage-status.md
```

The proxy is a single Node.js script with zero npm dependencies. On Windows it runs as a Windows service via [NSSM](https://nssm.cc). On macOS and Linux the same script runs via launchd or systemd.

## Output

A single line in `~/.claude/usage-status.md`, updated on every inference response:

```
5h=9% 7d=99%! overage=0% bottleneck=seven_day (10/05/2026, 16:19:04)
```

`!` means that window has an `allowed_warning` status — you're close to the limit.

The three pools:

- **5h** — rolling 5-hour window
- **7d** — rolling 7-day window  
- **overage** — paid burst pool, available once the 7d pool is exhausted

One unified pool covers all models. There is no separate Sonnet or Opus pool despite the Claude Code UI showing individual model bars.

## Setup

### Windows

Requires Node.js and an admin PowerShell session. NSSM is downloaded automatically.

```powershell
# Run as Administrator
& "path\to\usage-proxy\install-service.ps1"
```

The script validates Node.js, confirms your user profile path, downloads NSSM to `./tools/nssm.exe`, registers `AnthropicQuotaProxy` as an auto-starting Windows service, and sets `ANTHROPIC_BASE_URL=http://127.0.0.1:4080` as a user environment variable.

After it finishes, close all Claude Code windows and open a fresh one. Existing sessions won't route through the proxy — they inherited environment variables before the change.

To uninstall:

```powershell
# Run as Administrator
& "path\to\usage-proxy\uninstall-service.ps1"
```

### macOS

Create a launchd plist at `~/Library/LaunchAgents/com.anthropic-quota-proxy.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.anthropic-quota-proxy</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/path/to/usage-proxy/proxy.js</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/path/to/usage-proxy/proxy.log</string>
    <key>StandardErrorPath</key>
    <string>/path/to/usage-proxy/proxy-error.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.anthropic-quota-proxy.plist
```

Add to `~/.zshrc` or `~/.bash_profile`:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:4080
```

### Linux

Create `~/.config/systemd/user/anthropic-quota-proxy.service`:

```ini
[Unit]
Description=Anthropic Quota Proxy

[Service]
ExecStart=/usr/bin/node /path/to/usage-proxy/proxy.js
Environment=CLAUDE_USAGE_FILE=%h/.claude/usage-status.md
Restart=always
StandardOutput=append:/path/to/usage-proxy/proxy.log
StandardError=append:/path/to/usage-proxy/proxy-error.log

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable anthropic-quota-proxy
systemctl --user start anthropic-quota-proxy
```

Add to `~/.bashrc` or `~/.zshrc`:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:4080
```

## Asking Claude for current usage

Once the proxy is running, Claude can read the status file directly. Ask it:

> "What's my current quota usage?"

Claude reads `~/.claude/usage-status.md` and reports the values. The file is updated on every request so it's always current.

## CLAUDE.md rules

Add rules to your global `~/.claude/CLAUDE.md` to make Claude behave differently based on quota state. A few options depending on how much you want it involved.

### Report at session start

```markdown
## Quota awareness
At the start of each session, read `~/.claude/usage-status.md` and report the 5h and 7d usage.
If either shows `!`, flag it.
```

### Warn before large tasks

```markdown
## Quota awareness
Before any task involving more than ~10 tool calls or significant code generation,
read `~/.claude/usage-status.md`. If 7d usage is above 80%, say so and confirm before proceeding.
If 7d is above 95%, ask whether to continue or defer until the window resets.
```

### Adjust approach by usage level

```markdown
## Quota awareness
Read `~/.claude/usage-status.md` at the start of each session.

- Below 70% on both windows: normal operation
- 70–90% on 7d: prefer concise responses, avoid spawning multiple subagents unless necessary
- Above 90% on 7d: lightweight mode — short responses, no subagents, note that quota is low
- `!` on any window: mention it before starting multi-step tasks
```

### Hard stop near limit

```markdown
## Quota awareness
Read `~/.claude/usage-status.md` at the start of each session. If 7d usage is above 98%,
do not start new implementation tasks. Explain the quota state and suggest resuming tomorrow
or switching to a lighter approach.
```

### Auto-inject via hook (no manual reads needed)

Instead of asking Claude to read the file, inject it into every prompt automatically. Add to your Claude Code `settings.json`:

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

On macOS/Linux, replace the command with a shell equivalent reading `~/.claude/usage-status.md`.

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

**Why HTTP not HTTPS for the local connection?** Setting `ANTHROPIC_BASE_URL=http://` makes the SDK connect to the proxy over plain HTTP — no certificate management needed for localhost. The proxy makes a separate HTTPS connection to the real API.

**Why LocalSystem for the Windows service?** Avoids storing user credentials in the service config. The install script bakes your actual home path into `CLAUDE_USAGE_FILE` at install time instead.

**Why NSSM?** One binary, no npm dependencies, handles log rotation, clean install/remove. The alternative (`node-windows`) downloads a binary itself during install and requires npm — same end result with more moving parts.

## Files

```
usage-proxy/
  proxy.js                zero-dependency Node.js proxy
  install-service.ps1     Windows service installer (run as admin)
  uninstall-service.ps1   Windows service uninstaller (run as admin)
  tests/
    smoke.test.js         smoke test suite (node:test, no npm deps)
  tools/
    nssm.exe              downloaded by install-service.ps1
  proxy.log               stdout (1 MB rotation via NSSM)
  proxy-error.log         stderr
```

---

## v0.2 — LiteLLM fallback mode

### What it does (v0.2)

v0.2 extends the transparent proxy with an optional LiteLLM fallback. When quota on any of the three Anthropic windows approaches a configured threshold, `claude-*` requests are automatically redirected to a local LiteLLM instance with the body's `model` field rewritten to a tier-matched substitute. Non-`claude-*` models (e.g. `gpt-5`, `gemini-*`) always go to LiteLLM regardless of quota. The feature is opt-in: if `LITELLM_URL` is unset the proxy behaves exactly as v0.1 — pure passthrough to `api.anthropic.com`, no model inspection, no probes.

### Default behavior (legacy / v0.1)

With `LITELLM_URL` unset:

- All requests forwarded to `api.anthropic.com` unchanged.
- Response headers written to `~/.claude/usage-status.md` as before.
- No body buffering, no quota inspection, no background probe.
- One new startup log line: `[proxy] feature: litellm-fallback disabled (LITELLM_URL unset)`.

### LiteLLM fallback mode

Set `LITELLM_URL` to enable. All other env vars are optional with the defaults below.

| Variable | Purpose | Default |
|----------|---------|---------|
| `LITELLM_URL` | LiteLLM base URL, e.g. `http://localhost:4000`. **Feature gate** — unset = v0.1 behaviour. | unset |
| `LITELLM_API_KEY` | Bearer token on every LiteLLM-bound request. Required if `LITELLM_URL` is set. | unset |
| `LITELLM_FALLBACK_OPUS` | Model name substituted when a `claude-opus-*` request is redirected. Set to an empty string to disable (causes 500 on opus redirects). | `claude-opus-4-7` |
| `LITELLM_FALLBACK_SONNET` | Same, for `claude-sonnet-*`. | `claude-sonnet-4-6` |
| `LITELLM_FALLBACK_HAIKU` | Same, for `claude-haiku-*`. | `claude-haiku-4-5` |
| `REDIRECT_AT_5H_PCT` | 5-hour utilization threshold (integer 1–100). | `90` |
| `REDIRECT_AT_7D_PCT` | 7-day utilization threshold. | `90` |
| `REDIRECT_AT_OVERAGE_PCT` | Overage utilization threshold. | `80` |
| `HYSTERESIS_PCT` | How far below the threshold utilization must drop before switching back to Anthropic. Prevents oscillation. | `5` |
| `PROBE_INTERVAL_MS` | Background probe period while in redirect mode (ms). | `300000` (5 min) |
| `PROBE_MODEL` | Model used in probe `count_tokens` requests. | `claude-haiku-4-5` |
| `ANTHROPIC_API_KEY_FOR_PROBES` | Dedicated Anthropic key for probe requests. When set, the cached client bearer is never used for probes. | unset (cached client auth used) |
| `MAX_BUFFER_BYTES` | Maximum body size buffered on `/v1/messages` and `/v1/messages/count_tokens`. Requests exceeding this return 413. | `10485760` (10 MB) |
| `ANTHROPIC_HOST_OVERRIDE` | Override Anthropic target as `host[:port]`. **Test seam — not for production use.** | `api.anthropic.com:443` |
| `CLAUDE_USAGE_FILE` | Override `~/.claude/usage-status.md` path. | `~/.claude/usage-status.md` |

### Dispatch rules

| Model prefix | Quota state | Upstream | Body rewritten? |
|-------------|-------------|----------|----------------|
| `claude-opus-*` | below threshold | Anthropic | no |
| `claude-sonnet-*` | below threshold | Anthropic | no |
| `claude-haiku-*` | below threshold | Anthropic | no |
| `claude-opus-*` | at/above threshold | LiteLLM | yes → `LITELLM_FALLBACK_OPUS` |
| `claude-sonnet-*` | at/above threshold | LiteLLM | yes → `LITELLM_FALLBACK_SONNET` |
| `claude-haiku-*` | at/above threshold | LiteLLM | yes → `LITELLM_FALLBACK_HAIKU` |
| `claude-*` (unknown tier) | at/above threshold | LiteLLM | no (forwarded as-is) |
| anything else (`gpt-*`, `gemini-*`, …) | any | LiteLLM | no |

Redirect engages when **any one** of the three utilization windows is at or above its threshold. Switch-back requires **all three** to drop below `threshold − HYSTERESIS_PCT` (default 5 points). Tier classification is by case-insensitive substring match: a model name containing `opus` is opus-tier, `sonnet` is sonnet-tier, `haiku` is haiku-tier.

### Background probe

While in redirect mode the proxy cannot see fresh Anthropic rate-limit headers (requests go to LiteLLM). A background timer fires every `PROBE_INTERVAL_MS` and sends a minimal `POST /v1/messages/count_tokens` to Anthropic using the most recently observed client auth header. The probe response updates the in-memory quota state; if quota has dropped below the switch-back threshold the next `claude-*` request goes to Anthropic again.

If no client request has been seen yet (no cached auth) and `ANTHROPIC_API_KEY_FOR_PROBES` is unset, the probe tick is skipped.

After three consecutive probe failures (e.g. 401 from Anthropic), the probe interval doubles up to a 1-hour cap. When a client request arrives with a different auth value (key rotation), the backoff is immediately reset and the probe fires at the original cadence.

### Buffering caveat

Body-bearing endpoints (`/v1/messages`, `/v1/messages/count_tokens`) are buffered up to `MAX_BUFFER_BYTES` (10 MB default) when `LITELLM_URL` is set; oversized bodies return 413 before any upstream call is made.

### Auth-cache threat model

The probe reuses the cached client `authorization` / `x-api-key` header when `ANTHROPIC_API_KEY_FOR_PROBES` is unset. This cache is in-memory, lasts for the lifetime of the proxy process, and is used only for probe calls to `api.anthropic.com:443` over TLS. It is never logged, never written to disk, and never sent to LiteLLM.

Security-conscious operators should set `ANTHROPIC_API_KEY_FOR_PROBES` to a dedicated probe-only key, which eliminates the cached-bearer threat scope entirely.

**Single-tenancy note:** this proxy assumes one Anthropic account per running instance. Sharing a single proxy across multiple Anthropic accounts will cause quota-state pollution (quota is aggregated across all accounts) and probe-credential cross-contamination (the cached auth may belong to a different account than the current request). Run one proxy instance per Anthropic account.

### Running as a service

See `install-service.ps1` (Windows/NSSM) and `uninstall-service.ps1` for Windows service setup. For macOS and Linux, use the launchd/systemd examples in the Setup section above.

### Testing

```bash
npm test
# or directly:
node --test tests/smoke.test.js
```

The smoke test suite uses Node's built-in `node:test` (Node >= 18). No npm dependencies required. Tests use local mock servers on ephemeral ports — no real Anthropic or LiteLLM calls are made.
