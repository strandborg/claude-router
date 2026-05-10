# anthropic-quota-proxy

A local HTTP proxy that makes Claude aware of its own usage limits.

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
  tools/
    nssm.exe              downloaded by install-service.ps1
  proxy.log               stdout (1 MB rotation via NSSM)
  proxy-error.log         stderr
```
