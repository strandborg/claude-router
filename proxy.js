'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

// Decompress a buffered upstream body per its content-encoding. We force
// `accept-encoding: identity` toward Composer (we must read the body to translate
// it), so this is a defensive fallback for servers that compress anyway. Node 20
// has no zstd decoder, so zstd is intentionally not handled here — `identity`
// prevents it upstream. Returns the original buffer if encoding is absent/unknown
// or decompression fails.
function decompressBody(buf, contentEncoding) {
    const enc = (contentEncoding || '').trim().toLowerCase();
    try {
        if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf);
        if (enc === 'deflate') return zlib.inflateSync(buf);
        if (enc === 'br') return zlib.brotliDecompressSync(buf);
    } catch { /* fall through to raw buffer */ }
    return buf;
}

const PORT = 4080;
const BIND = '127.0.0.1';
const UPSTREAM_TIMEOUT_MS = 300000; // 5 min — inference can be slow
const PROBE_INTERVAL_MS_DEFAULT = 300000;
const PROBE_BACKOFF_CAP_MS = 3600000; // 1 hour
const PROBE_TIMEOUT_MS = 30000;

// Allow override via env var for when running as LocalSystem (home dir differs)
const USAGE_FILE = process.env.CLAUDE_USAGE_FILE
    || path.join(os.homedir(), '.claude', 'usage-status.md');

// Static hop-by-hop headers that must never be forwarded end-to-end (RFC 2616 §13.5.1)
const HOP_BY_HOP_STATIC = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailers', 'transfer-encoding', 'upgrade',
]);

const BODY_BEARING_PATHS = new Set(['/v1/messages', '/v1/messages/count_tokens']);

// GET on this exact path (query stripped) is intercepted and answered with a merged
// model list aggregated across every backend the router knows (Anthropic + LiteLLM +
// Composer). Anything else under /v1/models/* (e.g. retrieve by id) is left to passthrough.
const MODELS_LIST_PATH = '/v1/models';
const MODELS_FETCH_TIMEOUT_MS = 10000; // per-upstream cap for the models-list fan-out

// Reserved namespace for foreign (LiteLLM / Composer) model ids surfaced in the
// merged GET /v1/models list. Claude Code's model-selection dialog only accepts ids
// matching /^(claude|anthropic)/i, so foreign ids are exposed wrapped in this prefix
// (which begins with `claude-`) and demapped back to the real id on the inbound
// request before routing. Anthropic never ships a model under this prefix.
const REMAP_PREFIX = 'claude-router-';

// Claude Code reads the 1M context window off a literal `[1m]` suffix in the model
// name (regex /\[1m\]/i) and, when present, also adds this beta header to the request.
// We can therefore offer a 1M variant of a foreign model by exposing `<id>[1m]` — but
// the suffix must be stripped back off on the inbound request (Composer/LiteLLM don't
// understand it), and the beta header must NOT be forwarded to a non-Anthropic backend.
const ONE_M_SUFFIX = '[1m]';
const ONE_M_BETA = 'context-1m-2025-08-07';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// RFC 2616 §14.10: headers named in the Connection header value are also hop-by-hop
function stripHopByHop(headers) {
    const drop = new Set(HOP_BY_HOP_STATIC);
    const conn = headers['connection'];
    if (conn) {
        for (const name of conn.split(',')) drop.add(name.trim().toLowerCase());
    }
    const out = {};
    for (const [k, v] of Object.entries(headers)) {
        if (!drop.has(k.toLowerCase())) out[k] = v;
    }
    return out;
}

function parseUtilPct(val) {
    if (!val) return null;
    const n = parseFloat(val);
    if (isNaN(n)) return null;
    // Anthropic may return fraction (0.23) or integer percentage (23)
    return n <= 1.0 ? Math.round(n * 100) : Math.round(n);
}

// ANTHROPIC_HOST_OVERRIDE test seam — format: host[:port]
// Split on the *last* `:` so IPv6 literals like `[::1]:9999` work (brackets required for IPv6).
function parseHostOverride(raw) {
    if (!raw) return { host: 'api.anthropic.com', port: 443 };
    const idx = raw.lastIndexOf(':');
    // Treat as host-only if no ':' or if ':' is inside an unclosed IPv6 bracket
    if (idx === -1 || (raw.startsWith('[') && !raw.includes(']'))) {
        return { host: raw, port: 443 };
    }
    const host = raw.slice(0, idx);
    const portStr = raw.slice(idx + 1);
    const port = Number(portStr);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(`ANTHROPIC_HOST_OVERRIDE: invalid port '${portStr}'`);
    }
    return { host, port };
}

function parseIntEnv(raw, fallback) {
    if (raw === undefined || raw === null || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return n;
}

// classifyModel(name) → 'opus' | 'sonnet' | 'haiku' | 'non-claude' | 'unknown'
// Case-insensitive substring match. null/undefined/non-string → 'unknown'.
// A `claude-*` name without a recognized tier substring → 'unknown'.
function classifyModel(name) {
    if (typeof name !== 'string' || name.length === 0) return 'unknown';
    const lower = name.toLowerCase();
    if (lower.includes('opus')) return 'opus';
    if (lower.includes('sonnet')) return 'sonnet';
    if (lower.includes('haiku')) return 'haiku';
    if (lower.startsWith('claude-') || lower.startsWith('claude/')) return 'unknown';
    return 'non-claude';
}

// shouldRedirect(state, thresholds, currentMode)
// ANTHROPIC→LITELLM at `>= threshold`; LITELLM→ANTHROPIC at `< (threshold - HYSTERESIS_PCT)`.
// All three windows compared independently — redirect if ANY one crosses.
function shouldRedirect(state, thresholds, currentMode) {
    const adj = currentMode === 'litellm' ? thresholds.hysteresisPct : 0;
    return state.fiveHourPct  >= (thresholds.redirectAt5h      - adj)
        || state.sevenDayPct  >= (thresholds.redirectAt7d      - adj)
        || state.overagePct   >= (thresholds.redirectAtOverage - adj);
}

// pickFallbackModel(tier, config) — returns the configured fallback model name.
// Throws if the relevant env var is unset so the caller can return 500 with a clear message.
function pickFallbackModel(tier, cfg) {
    let envName;
    let value;
    if (tier === 'opus')        { envName = 'LITELLM_FALLBACK_OPUS';   value = cfg.fallbackOpus; }
    else if (tier === 'sonnet') { envName = 'LITELLM_FALLBACK_SONNET'; value = cfg.fallbackSonnet; }
    else if (tier === 'haiku')  { envName = 'LITELLM_FALLBACK_HAIKU';  value = cfg.fallbackHaiku; }
    else throw new Error(`pickFallbackModel: unsupported tier '${tier}'`);
    if (!value) throw new Error(`${envName} is not set`);
    return value;
}

// rewriteModelInBody(bodyBuf, newModel) — JSON-parse, set model, re-serialize. Throws on parse error.
function rewriteModelInBody(bodyBuf, newModel) {
    const parsed = JSON.parse(bodyBuf.toString('utf8'));
    parsed.model = newModel;
    return Buffer.from(JSON.stringify(parsed));
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const anthropicTarget = parseHostOverride(process.env.ANTHROPIC_HOST_OVERRIDE);

const config = {
    litellmUrl: process.env.LITELLM_URL || '',
    litellmApiKey: process.env.LITELLM_API_KEY || '',
    // Defaults match Anthropic's native model IDs — works out-of-the-box for any LiteLLM
    // tenant that exposes models under their canonical Anthropic names. Set the env var to
    // a non-empty string to override, or to '' to disable (causing 500 on tier redirect).
    fallbackOpus: process.env.LITELLM_FALLBACK_OPUS ?? 'claude-opus-4-7',
    fallbackSonnet: process.env.LITELLM_FALLBACK_SONNET ?? 'claude-sonnet-4-6',
    fallbackHaiku: process.env.LITELLM_FALLBACK_HAIKU ?? 'claude-haiku-4-5',
    thresholds: {
        redirectAt5h:      parseIntEnv(process.env.REDIRECT_AT_5H_PCT, 90),
        redirectAt7d:      parseIntEnv(process.env.REDIRECT_AT_7D_PCT, 90),
        redirectAtOverage: parseIntEnv(process.env.REDIRECT_AT_OVERAGE_PCT, 80),
        hysteresisPct:     parseIntEnv(process.env.HYSTERESIS_PCT, 5),
    },
    probeIntervalMs: parseIntEnv(process.env.PROBE_INTERVAL_MS, PROBE_INTERVAL_MS_DEFAULT),
    probeModel: process.env.PROBE_MODEL || 'claude-haiku-4-5',
    maxBufferBytes: parseIntEnv(process.env.MAX_BUFFER_BYTES, 10 * 1024 * 1024), // 10 MB per plan §1
    anthropicApiKeyForProbes: process.env.ANTHROPIC_API_KEY_FOR_PROBES || '',
    anthropicHost: anthropicTarget.host,
    anthropicPort: anthropicTarget.port,
    // Composer 2.5 backend (opt-in, independent of litellm). Enabled iff CURSOR_API_KEY set.
    composerApiUrl: process.env.COMPOSER_API_URL || 'https://cursor-api.standardagents.ai',
    cursorApiKey: process.env.CURSOR_API_KEY || '',
    // Comma-separated composer model ids surfaced in the GET /v1/models aggregation.
    // These are synthetic (Composer exposes no Anthropic-shaped model list) — they let the
    // model-selection dialog offer Composer alongside Anthropic + LiteLLM models. The ids
    // must match the composer-* routing pattern so a picked id round-trips to forwardToComposer.
    composerModels: process.env.COMPOSER_MODELS || 'composer-2.5',
    // Comma-separated REAL model ids (LiteLLM or Composer, as they route — i.e. post-demap)
    // that should ALSO be offered as a `[1m]` 1M-context variant in GET /v1/models. Opt-in:
    // only models whose backend genuinely supports a 1M window belong here, since the suffix
    // makes Claude Code treat the model as 1M-token locally. Default empty (no 1M variants).
    models1m: process.env.MODELS_1M || '',
};

const FEATURE_ENABLED = !!config.litellmUrl;
// Composer feature gate — computed from cursorApiKey ONLY, never referencing litellmUrl (AC2 independence).
const COMPOSER_ENABLED = !!config.cursorApiKey;
// Fixed tool-capable route on composer-api (spec L38/AC8). COMPOSER_API_URL is host-only;
// any path component in the env value is ignored and this route is always appended at dispatch.
const COMPOSER_ROUTE = '/opencodev2/v1/chat/completions';

// Pre-parse LiteLLM URL once at startup so dispatch is cheap.
let litellmParsed = null;
if (FEATURE_ENABLED) {
    try {
        const u = new URL(config.litellmUrl);
        const defaultPort = u.protocol === 'https:' ? 443 : 80;
        litellmParsed = {
            protocol: u.protocol,
            hostname: u.hostname,
            port: u.port ? Number(u.port) : defaultPort,
            // Use hostname (no port) for Host header when default; include port otherwise.
            hostHeader: u.port ? `${u.hostname}:${u.port}` : u.hostname,
        };
    } catch (err) {
        console.error(`[proxy] Invalid LITELLM_URL '${config.litellmUrl}': ${err.message}`);
        process.exit(1);
    }
}

// Pre-parse COMPOSER_API_URL once at startup (mirrors the litellm parse above). Host-only:
// scheme/host/port are used; any path component is discarded (the fixed COMPOSER_ROUTE is
// appended at dispatch). `composerParsed` is parsed-once immutable config (NOT per-request
// mutable state — distinct from the translator-state rule in Principle 6).
let composerParsed = null;
if (COMPOSER_ENABLED) {
    try {
        const u = new URL(config.composerApiUrl);
        const defaultPort = u.protocol === 'https:' ? 443 : 80;
        composerParsed = {
            protocol: u.protocol,
            hostname: u.hostname,
            port: u.port ? Number(u.port) : defaultPort,
            hostHeader: u.port ? `${u.hostname}:${u.port}` : u.hostname,
        };
    } catch (err) {
        console.error(`[proxy] Invalid COMPOSER_API_URL '${config.composerApiUrl}': ${err.message}`);
        process.exit(1);
    }
}

// ---------------------------------------------------------------------------
// Module-level mutable state
// ---------------------------------------------------------------------------

const quotaState = { fiveHourPct: 0, sevenDayPct: 0, overagePct: 0, updatedAt: 0 };
let lastClientAuth = null; // { value, sourceHeader: 'authorization'|'x-api-key', capturedAt }
let mode = 'anthropic';    // 'anthropic' | 'litellm'  (informational; dispatch re-derives from state)
let probeFailures = 0;
let probeIntervalMs = config.probeIntervalMs;
let activeProbeTimer = null;

let headersLogged = false; // log all ratelimit headers once to discover per-model pools
let noUtilHeadersLogged = false; // log once when an Anthropic response carries no util headers

// ---------------------------------------------------------------------------
// Usage file + quota mutation
// ---------------------------------------------------------------------------

function writeUsageFile(headers) {
    // On first response, dump every anthropic-ratelimit-* header to the log so we can
    // discover whether Sonnet/Opus have separate pool headers
    if (!headersLogged) {
        const allLimits = Object.entries(headers).filter(([k]) => k.startsWith('anthropic-ratelimit-'));
        if (allLimits.length) {
            console.log('[proxy] all rate-limit headers (first response):');
            for (const [k, v] of allLimits) console.log(`  ${k}: ${v}`);
            headersLogged = true;
        }
    }

    const fiveH    = parseUtilPct(headers['anthropic-ratelimit-unified-5h-utilization']);
    const sevenD   = parseUtilPct(headers['anthropic-ratelimit-unified-7d-utilization']);
    const overage  = parseUtilPct(headers['anthropic-ratelimit-unified-overage-utilization']);
    const neck     = headers['anthropic-ratelimit-unified-representative-claim'] || 'unknown';
    const status7d = headers['anthropic-ratelimit-unified-7d-status'] || '';
    const status5h = headers['anthropic-ratelimit-unified-5h-status'] || '';

    if (fiveH === null && sevenD === null) {
        // Diagnostic: this is the silent stranding mode. If the probe / non-body-bearing
        // endpoint does not include unified-utilization headers, quotaState never updates
        // and the proxy gets stuck in litellm mode forever. Logging once (gated like the
        // header dump) keeps recurring requests quiet but makes the situation visible.
        if (!noUtilHeadersLogged) {
            console.warn('[proxy] writeUsageFile: response had no unified-utilization headers — quotaState not updated. Endpoint does not surface rate-limit data.');
            noUtilHeadersLogged = true;
        }
        return;
    }

    const now = new Date().toLocaleString('en-GB', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
    });

    const warn5h  = status5h  === 'allowed_warning' ? '!' : '';
    const warn7d  = status7d  === 'allowed_warning' ? '!' : '';

    // Single line — keeps context injection cost negligible
    const content = `5h=${fiveH !== null ? fiveH + '%' : '?'}${warn5h} 7d=${sevenD !== null ? sevenD + '%' : '?'}${warn7d} overage=${overage !== null ? overage + '%' : '?'} bottleneck=${neck} (${now})\n`;

    try {
        fs.writeFileSync(USAGE_FILE, content, 'utf8');
    } catch (err) {
        console.error(`[proxy] Failed to write ${USAGE_FILE}:`, err.message);
    }

    // Update in-memory quota state (always — cost is one assignment).
    // Feature-visible side effects live downstream of updateModeFromQuota, which IS gated.
    if (fiveH !== null) quotaState.fiveHourPct = fiveH;
    if (sevenD !== null) quotaState.sevenDayPct = sevenD;
    if (overage !== null) quotaState.overagePct = overage;
    quotaState.updatedAt = Date.now();

    updateModeFromQuota();
}

// updateModeFromQuota — gated on FEATURE_ENABLED so feature-off mode is byte-identical (Principle 2).
function updateModeFromQuota() {
    if (!FEATURE_ENABLED) return;
    const prev = mode;
    const next = shouldRedirect(quotaState, config.thresholds, prev) ? 'litellm' : 'anthropic';
    if (next !== prev) {
        mode = next;
        console.log(`[proxy] mode transition: ${prev} -> ${next} (5h=${quotaState.fiveHourPct}%, 7d=${quotaState.sevenDayPct}%, overage=${quotaState.overagePct}%)`);
        // If we just entered redirect mode, make sure a probe is armed.
        if (next === 'litellm' && FEATURE_ENABLED && !activeProbeTimer) {
            scheduleNextProbe();
        }
    }
}

// ---------------------------------------------------------------------------
// Client auth capture (feeds probe)
// ---------------------------------------------------------------------------

function captureClientAuth(headers) {
    let value = null;
    let sourceHeader = null;
    // Prefer Authorization if both exist.
    if (headers['authorization']) {
        value = headers['authorization'];
        sourceHeader = 'authorization';
    } else if (headers['x-api-key']) {
        value = headers['x-api-key'];
        sourceHeader = 'x-api-key';
    }
    if (!value) return;

    const prevValue = lastClientAuth && lastClientAuth.value;
    lastClientAuth = { value, sourceHeader, capturedAt: Date.now() };

    // C4 stranded-mode reset: auth rotation invalidates backoff/probe-failure state.
    if (FEATURE_ENABLED && prevValue !== null && prevValue !== value) {
        probeFailures = 0;
        probeIntervalMs = config.probeIntervalMs;
        if (activeProbeTimer) {
            clearTimeout(activeProbeTimer);
            activeProbeTimer = null;
        }
        if (mode === 'litellm') scheduleNextProbe();
    }
}

// ---------------------------------------------------------------------------
// Composer translation (Anthropic Messages <-> OpenAI chat-completions)
// Pure functions — no I/O, no module-level mutable state. Exported for unit tests.
// ---------------------------------------------------------------------------

// Flatten an Anthropic content value (string OR array of blocks) to a plain string.
// Used for `system` and for `tool_result.content`.
function flattenAnthropicText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text)
            .join('');
    }
    return '';
}

// OpenAI finish_reason -> Anthropic stop_reason. null/absent (mid-stream) -> null.
function mapFinishReason(fr) {
    if (fr === 'stop') return 'end_turn';
    if (fr === 'tool_calls') return 'tool_use';
    if (fr === 'length') return 'max_tokens';
    if (fr === 'content_filter') return 'end_turn'; // best-effort
    return null;
}

function randomMsgId() {
    return 'msg_' + Math.random().toString(36).slice(2, 14);
}

// ---------------------------------------------------------------------------
// Model-list aggregation (GET /v1/models) — pure helpers
// Translate foreign model descriptors into the Anthropic Models API `ModelInfo`
// shape so a single merged list can be returned to the client. Pure: no I/O.
// ---------------------------------------------------------------------------

// remapModelId(id) — wrap a foreign model id so it passes Claude Code's
// /^(claude|anthropic)/i dialog filter. Ids that already start with claude/anthropic
// are returned unchanged (they pass the filter and their routing is already meaningful);
// everything else is prefixed with REMAP_PREFIX. Inverse of demapModelId.
function remapModelId(id) {
    if (typeof id !== 'string' || id.length === 0) return id;
    if (/^(claude|anthropic)/i.test(id)) return id;
    return REMAP_PREFIX + id;
}

// demapModelId(name) — recover the real underlying model id from a remapped name.
// Strips the REMAP_PREFIX and, if present, the trailing `[1m]` 1M-context marker that
// the dialog adds to the id (the real backend model carries neither). ONLY touches ids
// in our claude-router-* namespace — a native `claude-opus-4-8[1m]` has no prefix and is
// returned untouched, so genuine Anthropic 1M requests are never altered. No-op for any
// name that was never remapped, so it is always safe to call.
function demapModelId(name) {
    if (typeof name !== 'string' || !name.startsWith(REMAP_PREFIX)) return name;
    let real = name.slice(REMAP_PREFIX.length);
    if (real.toLowerCase().endsWith(ONE_M_SUFFIX)) real = real.slice(0, -ONE_M_SUFFIX.length);
    return real;
}

// addOneMVariants(entries, oneMSet) — for each entry whose (real) id is in oneMSet,
// append an extra entry carrying the `[1m]` suffix so Claude Code offers a 1M-context
// variant in the dialog. Operates on real-id entries (before remapping). The variant's
// display_name gets a "(1M context)" tag. Never mutates inputs.
function addOneMVariants(entries, oneMSet) {
    if (!Array.isArray(entries)) return [];
    const out = [];
    for (const e of entries) {
        out.push(e);
        if (e && typeof e.id === 'string' && oneMSet && oneMSet.has(e.id)) {
            out.push({
                ...e,
                id: e.id + ONE_M_SUFFIX,
                display_name: `${e.display_name || e.id} (1M context)`,
            });
        }
    }
    return out;
}

// withoutBeta(headerValue, token) — remove one beta token from a comma-separated
// `anthropic-beta` header value (case-insensitive), preserving the rest. Returns the
// new value, or null when nothing remains (caller deletes the header). Pure.
function withoutBeta(headerValue, token) {
    if (typeof headerValue !== 'string' || !headerValue) return null;
    const kept = headerValue
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((t) => t.toLowerCase() !== token.toLowerCase());
    return kept.length ? kept.join(',') : null;
}

// remapEntries(entries) — return copies of ModelInfo entries with their `id` remapped
// for dialog exposure. `display_name` is left untouched so the picker still shows the
// real, human-recognizable model name. Never mutates the inputs.
function remapEntries(entries) {
    if (!Array.isArray(entries)) return [];
    return entries.map((e) => (e && typeof e.id === 'string' ? { ...e, id: remapModelId(e.id) } : e));
}

// openAIModelToAnthropic(m) — map one OpenAI/LiteLLM `/v1/models` entry to an
// Anthropic ModelInfo. LiteLLM returns OpenAI-shaped objects: { id, object:'model',
// created (unix seconds), owned_by }. Returns null when there is no usable id.
function openAIModelToAnthropic(m) {
    if (!m || typeof m.id !== 'string' || m.id.length === 0) return null;
    let createdAt = '2025-01-01T00:00:00Z';
    if (typeof m.created === 'number' && Number.isFinite(m.created)) {
        // OpenAI `created` is unix seconds; ms = *1000. Guard against absurd values.
        try {
            const d = new Date(m.created * 1000);
            if (!isNaN(d.getTime())) createdAt = d.toISOString();
        } catch { /* keep default */ }
    }
    return {
        type: 'model',
        id: m.id,
        // No human label is available from the OpenAI list shape — surface the id,
        // which is also exactly what the client must send back as `model`.
        display_name: m.id,
        created_at: createdAt,
    };
}

// composerModelEntries(cfg) — synthesize Anthropic ModelInfo entries for Composer.
// Composer exposes no Anthropic-shaped model list, so the ids come from config
// (COMPOSER_MODELS, comma-separated). Ids must match the composer-* routing pattern.
function composerModelEntries(cfg) {
    const raw = (cfg && cfg.composerModels) || '';
    return raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((id) => {
            // "composer-2.5" -> "Composer 2.5"; anything else falls back to the id.
            let displayName = id;
            const m = /^composer[-/](.+)$/i.exec(id);
            if (m) displayName = `Composer ${m[1]}`;
            return {
                type: 'model',
                id,
                display_name: displayName,
                created_at: '2025-01-01T00:00:00Z',
            };
        });
}

// mergeModelLists(anthropicData, litellmData, composerData) — concatenate the three
// sources in priority order (Anthropic first, then LiteLLM, then Composer), dropping
// later entries whose id was already seen. Inputs are arrays of ModelInfo objects.
// Returns a fresh array; never mutates inputs.
function mergeModelLists(anthropicData, litellmData, composerData) {
    const out = [];
    const seen = new Set();
    for (const list of [anthropicData, litellmData, composerData]) {
        if (!Array.isArray(list)) continue;
        for (const entry of list) {
            if (!entry || typeof entry.id !== 'string' || seen.has(entry.id)) continue;
            seen.add(entry.id);
            out.push(entry);
        }
    }
    return out;
}

// anthropicToOpenAIRequest(parsed) — translate a parsed Anthropic Messages request body
// into an OpenAI chat-completions request body. `model` is forwarded as-is (AC3).
function anthropicToOpenAIRequest(parsed) {
    const out = {
        model: parsed.model,
        messages: [],
        stream: parsed.stream === true,
    };
    // Sampling params — omit when absent (never send undefined).
    if (parsed.max_tokens !== undefined) out.max_tokens = parsed.max_tokens;
    if (parsed.temperature !== undefined) out.temperature = parsed.temperature;
    if (parsed.top_p !== undefined) out.top_p = parsed.top_p;
    if (parsed.stop_sequences !== undefined) out.stop = parsed.stop_sequences;

    // system (string or array of text blocks) -> leading system message.
    if (parsed.system !== undefined && parsed.system !== null) {
        const sysText = flattenAnthropicText(parsed.system);
        if (sysText) out.messages.push({ role: 'system', content: sysText });
    }

    const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
    for (const msg of msgs) {
        const role = msg.role;
        const content = msg.content;

        if (role === 'user') {
            if (typeof content === 'string') {
                out.messages.push({ role: 'user', content });
                continue;
            }
            if (Array.isArray(content)) {
                const textParts = [];
                const toolMessages = [];
                for (const block of content) {
                    if (!block || typeof block !== 'object') continue;
                    if (block.type === 'text' && typeof block.text === 'string') {
                        textParts.push(block.text);
                    } else if (block.type === 'tool_result') {
                        // M3: OpenAI's tool-role message has NO error channel. An Anthropic
                        // tool_result with is_error:true is forwarded as ordinary content with
                        // no marker (best-effort) — the model sees error text, not a flag.
                        toolMessages.push({
                            role: 'tool',
                            tool_call_id: block.tool_use_id,
                            content: flattenAnthropicText(block.content),
                        });
                    }
                }
                // Emit tool messages first so they follow the prior assistant tool_calls turn,
                // then any free-standing user text (correlated by tool_use_id, AC7).
                for (const tm of toolMessages) out.messages.push(tm);
                if (textParts.length) out.messages.push({ role: 'user', content: textParts.join('') });
                continue;
            }
            continue;
        }

        if (role === 'assistant') {
            if (typeof content === 'string') {
                out.messages.push({ role: 'assistant', content });
                continue;
            }
            if (Array.isArray(content)) {
                const textParts = [];
                const toolCalls = [];
                for (const block of content) {
                    if (!block || typeof block !== 'object') continue;
                    if (block.type === 'text' && typeof block.text === 'string') {
                        textParts.push(block.text);
                    } else if (block.type === 'tool_use') {
                        toolCalls.push({
                            id: block.id, // preserved verbatim for round-trip (R2)
                            type: 'function',
                            function: {
                                name: block.name,
                                arguments: JSON.stringify(block.input ?? {}),
                            },
                        });
                    }
                }
                const assistantMsg = { role: 'assistant' };
                if (toolCalls.length) {
                    // M2: content:null (NOT '') when tool_calls present and no text — some
                    // OpenAI-compatible backends reject content:'' alongside tool_calls.
                    assistantMsg.content = textParts.length ? textParts.join('') : null;
                    assistantMsg.tool_calls = toolCalls;
                } else {
                    assistantMsg.content = textParts.join('');
                }
                out.messages.push(assistantMsg);
                continue;
            }
            continue;
        }

        // Unknown role — best-effort passthrough for string content.
        if (typeof content === 'string') out.messages.push({ role, content });
    }

    // tools: Anthropic {name, description, input_schema} -> OpenAI function tool.
    if (Array.isArray(parsed.tools) && parsed.tools.length) {
        out.tools = parsed.tools.map((t) => ({
            type: 'function',
            function: {
                name: t.name,
                description: t.description,
                parameters: t.input_schema,
            },
        }));
    }
    // tool_choice: auto->auto, any->required, {type:'tool',name}->{type:'function',function:{name}}.
    if (parsed.tool_choice !== undefined && parsed.tool_choice !== null) {
        const tc = parsed.tool_choice;
        if (tc.type === 'auto') out.tool_choice = 'auto';
        else if (tc.type === 'any') out.tool_choice = 'required';
        else if (tc.type === 'tool' && tc.name) out.tool_choice = { type: 'function', function: { name: tc.name } };
    }

    return out;
}

// openAIToAnthropicResponse(openai, reqModel) — translate a non-streaming OpenAI
// chat-completion object into an Anthropic Messages response object.
// C4: returns `null` when there is no usable choice/message — the caller surfaces a 502.
function openAIToAnthropicResponse(openai, reqModel) {
    const choice = openai && openai.choices && openai.choices[0];
    if (!choice || !choice.message) return null;
    const msg = choice.message;

    const content = [];
    if (typeof msg.content === 'string' && msg.content.length > 0) {
        content.push({ type: 'text', text: msg.content });
    }
    if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
            const fn = tc.function || {};
            let input = {};
            try {
                input = JSON.parse(fn.arguments && fn.arguments.length ? fn.arguments : '{}');
            } catch {
                input = {}; // best-effort: never crash on malformed arguments
            }
            content.push({ type: 'tool_use', id: tc.id, name: fn.name, input });
        }
    }

    const usage = openai.usage || {};
    return {
        id: openai.id || randomMsgId(),
        type: 'message',
        role: 'assistant',
        model: reqModel,
        content,
        stop_reason: mapFinishReason(choice.finish_reason) ?? 'end_turn',
        stop_sequence: null,
        usage: {
            // Display only — does NOT feed writeUsageFile/quotaState (AC10).
            input_tokens: usage.prompt_tokens ?? 0,
            output_tokens: usage.completion_tokens ?? 0,
        },
    };
}

// makeSSETranslator(reqModel, emit) — factory returning { feed(chunkStr), end() }.
// `emit(eventType, dataObj)` writes one Anthropic SSE event. ALL mutable state lives
// inside this closure (Principle 6 / R9) — nothing at module scope.
function makeSSETranslator(reqModel, emit) {
    let started = false;          // emitted message_start yet?
    let finalized = false;        // C3: close sequence emitted yet?
    let nextBlockIndex = 0;       // C2: lazy Anthropic block-index allocator
    let textBlockIndex = null;    // Anthropic index of the (single) text block, once opened
    const toolIndexMap = new Map(); // C2: OpenAI tc.index -> { anthropicIndex, opened, id, argBuffer }
    let openBlockIndex = null;    // index of the currently-open content block
    let stopReason = null;        // captured from finish_reason
    let usageOutputTokens = 0;    // stashed completion_tokens (defaults 0)
    let usageInputTokens = 0;     // stashed prompt_tokens
    let lineBuf = '';             // partial-line buffer across TCP chunks

    function ensureStarted(chunk) {
        if (started) return;
        started = true;
        if (chunk && chunk.usage && typeof chunk.usage.prompt_tokens === 'number') {
            usageInputTokens = chunk.usage.prompt_tokens;
        }
        emit('message_start', {
            type: 'message_start',
            message: {
                id: (chunk && chunk.id) || randomMsgId(),
                type: 'message',
                role: 'assistant',
                model: reqModel,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: usageInputTokens, output_tokens: 0 },
            },
        });
    }

    function closeOpenBlock() {
        if (openBlockIndex !== null) {
            emit('content_block_stop', { type: 'content_block_stop', index: openBlockIndex });
            openBlockIndex = null;
        }
    }

    function openTextBlock() {
        // N1: if a non-text block is open, close it before opening/reopening the text block.
        if (openBlockIndex !== null && openBlockIndex !== textBlockIndex) closeOpenBlock();
        if (textBlockIndex === null) textBlockIndex = nextBlockIndex++; // C2: lazy allocation
        emit('content_block_start', {
            type: 'content_block_start',
            index: textBlockIndex,
            content_block: { type: 'text', text: '' },
        });
        openBlockIndex = textBlockIndex;
    }

    function finalize() {
        if (finalized) return; // C3: idempotent
        finalized = true;
        if (!started) ensureStarted(null); // zero-delta streams still produce a valid envelope
        closeOpenBlock();
        emit('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: stopReason ?? 'end_turn', stop_sequence: null },
            usage: { output_tokens: usageOutputTokens ?? 0 },
        });
        emit('message_stop', { type: 'message_stop' });
    }

    function processChunk(chunk) {
        // C4 / usage capture: stash usage even on choice-less chunks.
        if (chunk.usage) {
            if (typeof chunk.usage.completion_tokens === 'number') usageOutputTokens = chunk.usage.completion_tokens;
            if (typeof chunk.usage.prompt_tokens === 'number') usageInputTokens = chunk.usage.prompt_tokens;
        }
        // Mid-stream OpenAI error field -> Anthropic error event -> finalize.
        if (chunk.error) {
            ensureStarted(chunk);
            emit('error', { type: 'error', error: { type: 'upstream_error', message: (chunk.error && chunk.error.message) || 'composer-api error' } });
            finalize();
            return;
        }
        const choice = chunk.choices && chunk.choices[0];
        if (!choice) return; // C4: usage-only trailing chunk — captured above, no throw
        ensureStarted(chunk);
        const delta = choice.delta || {};

        // Text deltas.
        if (typeof delta.content === 'string' && delta.content.length > 0) {
            // N1: assumes upstream emits all text before tool_calls within a single response;
            // re-interleaved text after a tool block is best-effort (close tool block, reopen text).
            if (textBlockIndex === null || openBlockIndex !== textBlockIndex) openTextBlock();
            emit('content_block_delta', {
                type: 'content_block_delta',
                index: textBlockIndex,
                delta: { type: 'text_delta', text: delta.content },
            });
        }

        // Tool-call deltas. OpenAI tc.index is a SEPARATE namespace — never used as the
        // Anthropic block index (C2); mapped through toolIndexMap.
        if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
                const key = tc.index;
                let entry = toolIndexMap.get(key);
                if (!entry) {
                    // First appearance keyed on tc.index (not on id presence).
                    entry = { anthropicIndex: null, opened: false, id: null, argBuffer: '' };
                    toolIndexMap.set(key, entry);
                }
                if (tc.id && !entry.id) entry.id = tc.id;
                const fn = tc.function || {};
                const name = fn.name;
                // Defer content_block_start until BOTH id and name are known.
                if (!entry.opened && entry.id && name) {
                    entry.anthropicIndex = nextBlockIndex++; // C2: lazy allocation
                    if (openBlockIndex !== null) closeOpenBlock();
                    emit('content_block_start', {
                        type: 'content_block_start',
                        index: entry.anthropicIndex,
                        content_block: { type: 'tool_use', id: entry.id, name, input: {} },
                    });
                    entry.opened = true;
                    openBlockIndex = entry.anthropicIndex;
                    // Flush any argument fragments buffered before the block opened.
                    if (entry.argBuffer) {
                        emit('content_block_delta', {
                            type: 'content_block_delta',
                            index: entry.anthropicIndex,
                            delta: { type: 'input_json_delta', partial_json: entry.argBuffer },
                        });
                        entry.argBuffer = '';
                    }
                }
                // Argument fragments — opaque, forwarded verbatim, never parsed mid-stream (R3).
                if (typeof fn.arguments === 'string' && fn.arguments.length > 0) {
                    if (entry.opened) {
                        emit('content_block_delta', {
                            type: 'content_block_delta',
                            index: entry.anthropicIndex,
                            delta: { type: 'input_json_delta', partial_json: fn.arguments },
                        });
                    } else {
                        entry.argBuffer += fn.arguments; // buffer until the block opens
                    }
                }
            }
        }

        // finish_reason — stash only; finalize is shared/idempotent (C3).
        if (choice.finish_reason) stopReason = mapFinishReason(choice.finish_reason);
    }

    function feed(chunkStr) {
        if (finalized) return;
        lineBuf += chunkStr;
        let nlIdx;
        while ((nlIdx = lineBuf.indexOf('\n')) !== -1) {
            let line = lineBuf.slice(0, nlIdx);
            lineBuf = lineBuf.slice(nlIdx + 1);
            if (line.endsWith('\r')) line = line.slice(0, -1); // CRLF tolerance
            line = line.trim();
            if (line === '' || !line.startsWith('data:')) continue;
            const data = line.slice(5).trim(); // tolerate both 'data: ' and 'data:'
            if (data === '[DONE]') { finalize(); return; }
            let chunk;
            try {
                chunk = JSON.parse(data);
            } catch {
                continue; // ignore unparseable line
            }
            processChunk(chunk);
            if (finalized) return; // a delta-carried error may have finalized
        }
    }

    function end() {
        finalize();
    }

    return { feed, end };
}

// ---------------------------------------------------------------------------
// Forwarders
// ---------------------------------------------------------------------------

function forwardToAnthropic(clientReq, clientRes, opts) {
    const { bodyBufOrStream, captureUsage, reason, modelName } = opts;

    const hostHeader = config.anthropicPort === 443
        ? config.anthropicHost
        : `${config.anthropicHost}:${config.anthropicPort}`;

    const upstreamHeaders = {
        ...stripHopByHop(clientReq.headers),
        host: hostHeader,
    };

    if (Buffer.isBuffer(bodyBufOrStream)) {
        upstreamHeaders['content-length'] = Buffer.byteLength(bodyBufOrStream);
    }

    const options = {
        hostname: config.anthropicHost,
        port: config.anthropicPort,
        path: clientReq.url,
        method: clientReq.method,
        headers: upstreamHeaders,
        timeout: UPSTREAM_TIMEOUT_MS,
    };

    const upstreamReq = https.request(options, (upstreamRes) => {
        if (captureUsage) writeUsageFile(upstreamRes.headers);

        const responseHeaders = stripHopByHop(upstreamRes.headers);
        clientRes.writeHead(upstreamRes.statusCode, responseHeaders);

        let responseEnded = false;
        upstreamRes.on('end', () => { responseEnded = true; });

        // If client disconnects mid-stream, kill the upstream to avoid orphaned connections
        clientReq.on('close', () => {
            if (!responseEnded) upstreamReq.destroy();
        });

        upstreamRes.pipe(clientRes, { end: true });
    });

    upstreamReq.on('timeout', () => {
        upstreamReq.destroy(new Error('Upstream request timed out'));
    });

    upstreamReq.on('error', (err) => {
        console.error('[proxy] Upstream error:', err.message);
        if (!clientRes.headersSent) {
            clientRes.writeHead(502, { 'content-type': 'text/plain' });
        }
        clientRes.end('Proxy upstream error');
    });

    clientReq.on('error', (err) => {
        console.error('[proxy] Client request error:', err.message);
        upstreamReq.destroy(err);
    });

    if (FEATURE_ENABLED && reason) {
        console.log(`[proxy] dispatch: anthropic reason=${reason}${modelName ? ` model=${modelName}` : ''}`);
    }

    if (Buffer.isBuffer(bodyBufOrStream)) {
        upstreamReq.write(bodyBufOrStream);
        upstreamReq.end();
    } else {
        // Stream (legacy passthrough)
        bodyBufOrStream.pipe(upstreamReq, { end: true });
    }
}

function forwardToLiteLLM(clientReq, clientRes, opts) {
    const { bodyBuf, rewrite, reason, modelName } = opts;

    // Start from the client's hop-by-hop-stripped headers, then strip Anthropic auth
    // and overwrite with LiteLLM credentials.
    const upstreamHeaders = {
        ...stripHopByHop(clientReq.headers),
        host: litellmParsed.hostHeader,
        authorization: `Bearer ${config.litellmApiKey}`,
        'content-length': Buffer.byteLength(bodyBuf),
    };
    delete upstreamHeaders['x-api-key']; // strip inbound Anthropic auth
    // Also strip the inbound proxy auth header if present (we just overwrote authorization).

    const requester = litellmParsed.protocol === 'https:' ? https : http;

    const upstreamReq = requester.request({
        hostname: litellmParsed.hostname,
        port: litellmParsed.port,
        path: clientReq.url,
        method: clientReq.method,
        headers: upstreamHeaders,
        timeout: UPSTREAM_TIMEOUT_MS,
    }, (upstreamRes) => {
        // Response-side: pipe identically to forwardToAnthropic (Principle 3).
        // NOTE: do NOT call writeUsageFile here — LiteLLM never touches the usage file (AC11).
        const responseHeaders = stripHopByHop(upstreamRes.headers);
        clientRes.writeHead(upstreamRes.statusCode, responseHeaders);

        let responseEnded = false;
        upstreamRes.on('end', () => { responseEnded = true; });

        clientReq.on('close', () => {
            if (!responseEnded) upstreamReq.destroy();
        });

        upstreamRes.pipe(clientRes, { end: true });
    });

    upstreamReq.on('timeout', () => {
        upstreamReq.destroy(new Error('Upstream request timed out'));
    });

    upstreamReq.on('error', (err) => {
        console.error('[proxy] LiteLLM upstream error:', err.message);
        if (!clientRes.headersSent) {
            clientRes.writeHead(502, { 'content-type': 'text/plain' });
        }
        clientRes.end('Proxy upstream error');
    });

    clientReq.on('error', (err) => {
        console.error('[proxy] Client request error:', err.message);
        upstreamReq.destroy(err);
    });

    console.log(`[proxy] dispatch: litellm reason=${reason} model=${modelName || '(none)'} rewrite=${!!rewrite}`);
    upstreamReq.write(bodyBuf);
    upstreamReq.end();
}

// forwardToComposer — native Anthropic<->OpenAI translating forwarder for the Composer
// backend. Mirrors forwardToLiteLLM's header discipline but POSTs to the fixed COMPOSER_ROUTE
// and translates both request and response. NEVER calls writeUsageFile (AC10).
function forwardToComposer(clientReq, clientRes, opts) {
    const { parsed, modelName } = opts;
    const isStream = parsed.stream === true;

    // Translate the inbound Anthropic request to OpenAI chat-completions shape.
    let openaiBody;
    try {
        openaiBody = anthropicToOpenAIRequest(parsed);
    } catch (err) {
        console.error('[proxy] Composer request translation error:', err.message);
        if (!clientRes.headersSent) clientRes.writeHead(502, { 'content-type': 'application/json' });
        return clientRes.end(JSON.stringify({ type: 'error', error: { type: 'upstream_error', message: 'composer request translation failed' } }));
    }
    const outBuf = Buffer.from(JSON.stringify(openaiBody));

    // Header hygiene: strip inbound Anthropic auth + hop-by-hop, inject Cursor bearer.
    const upstreamHeaders = {
        ...stripHopByHop(clientReq.headers),
        host: composerParsed.hostHeader,
        authorization: `Bearer ${config.cursorApiKey}`,
        'content-length': Buffer.byteLength(outBuf),
        'content-type': 'application/json',
        accept: isStream ? 'text/event-stream' : 'application/json',
        // We buffer/parse/re-frame the response to translate it, so we need it
        // uncompressed. The inbound Claude Code request advertises zstd/gzip/br,
        // which Composer honored (zstd) — and Node 20 cannot decode zstd. Override
        // to identity so both the JSON parse and the SSE translator see plain bytes.
        'accept-encoding': 'identity',
    };
    delete upstreamHeaders['x-api-key']; // strip inbound Anthropic auth (mirrors litellm)

    const requester = composerParsed.protocol === 'https:' ? https : http;
    let streamHeadersSent = false; // R10: once 200+SSE headers sent, cannot writeHead(502)

    const upstreamReq = requester.request({
        hostname: composerParsed.hostname,
        port: composerParsed.port,
        path: COMPOSER_ROUTE, // fixed route, NOT clientReq.url (inbound path is /v1/messages)
        method: 'POST',
        headers: upstreamHeaders,
        timeout: UPSTREAM_TIMEOUT_MS,
    }, (upstreamRes) => {
        // NEVER call writeUsageFile here — Composer never touches the usage file / quotaState (AC10).
        const status = upstreamRes.statusCode;

        // If the client disconnects before the upstream response completes, kill the upstream
        // to avoid orphaned sockets (mirrors forwardToAnthropic/forwardToLiteLLM). Single guard
        // covering all branches (non-2xx, streaming, non-streaming) — no double-destroy.
        let responseEnded = false;
        upstreamRes.on('end', () => { responseEnded = true; });
        clientReq.on('close', () => { if (!responseEnded) upstreamReq.destroy(); });

        // Non-2xx upstream -> translate to an Anthropic-shaped error envelope.
        if (status < 200 || status >= 300) {
            const chunks = [];
            upstreamRes.on('data', (c) => chunks.push(c));
            upstreamRes.on('end', () => {
                let message = 'composer-api error';
                let errType = 'upstream_error';
                try {
                    const body = JSON.parse(decompressBody(Buffer.concat(chunks), upstreamRes.headers['content-encoding']).toString('utf8'));
                    if (body && body.error) {
                        message = body.error.message || message;
                        errType = body.error.type || errType;
                    }
                } catch { /* keep defaults */ }
                if (!clientRes.headersSent) clientRes.writeHead(status, { 'content-type': 'application/json' });
                clientRes.end(JSON.stringify({ type: 'error', error: { type: errType, message } }));
            });
            return;
        }

        if (isStream) {
            clientRes.writeHead(200, {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache',
                connection: 'keep-alive',
            });
            streamHeadersSent = true;
            const sse = makeSSETranslator(modelName, (type, obj) => {
                clientRes.write('event: ' + type + '\ndata: ' + JSON.stringify(obj) + '\n\n');
            });
            upstreamRes.on('data', (chunk) => sse.feed(chunk.toString('utf8')));
            upstreamRes.on('end', () => {
                sse.end(); // idempotent finalize — covers streams that end without [DONE]
                clientRes.end();
            });
            return;
        }

        // Non-streaming: buffer the full body, parse, translate.
        const upstreamCT = upstreamRes.headers['content-type'] || '';
        const chunks = [];
        upstreamRes.on('data', (c) => chunks.push(c));
        upstreamRes.on('end', () => {
            const rawBody = decompressBody(Buffer.concat(chunks), upstreamRes.headers['content-encoding']).toString('utf8');
            let openai;
            try {
                openai = JSON.parse(rawBody);
            } catch {
                console.error('[proxy] Composer non-streaming parse failed: status=' + status +
                    ' content-type=' + JSON.stringify(upstreamCT) + ' bodyLen=' + rawBody.length +
                    ' bodyHead=' + JSON.stringify(rawBody.slice(0, 300)));
                if (!clientRes.headersSent) clientRes.writeHead(502, { 'content-type': 'application/json' });
                return clientRes.end(JSON.stringify({ type: 'error', error: { type: 'upstream_error', message: 'composer-api returned invalid JSON' } }));
            }
            const anthropic = openAIToAnthropicResponse(openai, modelName);
            if (!anthropic) {
                // C4: no usable choice/message -> clear 502 (Principle 4, fail safe).
                console.error('[proxy] Composer non-streaming no usable choice: status=' + status +
                    ' content-type=' + JSON.stringify(upstreamCT) + ' bodyHead=' + JSON.stringify(rawBody.slice(0, 300)));
                if (!clientRes.headersSent) clientRes.writeHead(502, { 'content-type': 'application/json' });
                return clientRes.end(JSON.stringify({ type: 'error', error: { type: 'upstream_error', message: 'composer-api returned no choices' } }));
            }
            const outJson = JSON.stringify(anthropic);
            if (!clientRes.headersSent) {
                clientRes.writeHead(status, {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(outJson),
                });
            }
            clientRes.end(outJson);
        });
    });

    upstreamReq.on('timeout', () => {
        upstreamReq.destroy(new Error('Upstream request timed out'));
    });

    upstreamReq.on('error', (err) => {
        console.error('[proxy] Composer upstream error:', err.message);
        if (streamHeadersSent) {
            // R10 / Step 4.6a: 200 already committed — emit a terminal Anthropic error SSE event.
            try {
                clientRes.write('event: error\ndata: ' + JSON.stringify({ type: 'error', error: { type: 'upstream_error', message: err.message } }) + '\n\n');
            } catch { /* ignore */ }
            return clientRes.end();
        }
        if (!clientRes.headersSent) clientRes.writeHead(502, { 'content-type': 'application/json' });
        clientRes.end(JSON.stringify({ type: 'error', error: { type: 'upstream_error', message: 'composer upstream error' } }));
    });

    clientReq.on('error', (err) => {
        console.error('[proxy] Client request error:', err.message);
        upstreamReq.destroy(err);
    });

    console.log(`[proxy] dispatch: composer model=${modelName} stream=${isStream}`);
    upstreamReq.write(outBuf);
    upstreamReq.end();
}

// ---------------------------------------------------------------------------
// Model-list aggregation (GET /v1/models) — I/O
// ---------------------------------------------------------------------------

// fetchJsonOnce(requester, options) — issue a bodyless GET and buffer the full
// response. Resolves { status, headers, bodyBuf } (decompression is the caller's
// concern). Rejects only on transport error/timeout. `options.timeout` arms the
// socket timeout; we destroy on fire so the promise rejects rather than hangs.
function fetchJsonOnce(requester, options) {
    return new Promise((resolve, reject) => {
        const req = requester.request(options, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bodyBuf: Buffer.concat(chunks) }));
            res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('models fetch timed out')));
        req.on('error', reject);
        req.end();
    });
}

// handleModelsList — intercept GET /v1/models and answer with a list merged across
// every backend the router knows. Anthropic is the source of truth (and the auth
// gate): on a non-2xx Anthropic response we pass it through verbatim so 401/403/etc.
// surface unchanged. On success we append translated LiteLLM models (when enabled)
// and synthetic Composer models (when enabled), de-duplicated by id.
async function handleModelsList(clientReq, clientRes) {
    // --- 1. Anthropic upstream (always) ---------------------------------------
    const hostHeader = config.anthropicPort === 443
        ? config.anthropicHost
        : `${config.anthropicHost}:${config.anthropicPort}`;

    // Preserve the client's `beta` flag but force a large page so we get the full
    // set in one shot (we collapse pagination by returning has_more:false below).
    let beta = false;
    try {
        const q = new URL(clientReq.url, 'http://placeholder').searchParams;
        beta = q.get('beta') === 'true';
    } catch { /* malformed query — treat as no beta */ }
    const anthPath = `/v1/models?limit=1000${beta ? '&beta=true' : ''}`;

    const anthHeaders = { ...stripHopByHop(clientReq.headers), host: hostHeader, 'accept-encoding': 'identity' };
    delete anthHeaders['content-length']; // GET carries no body

    let anth;
    try {
        anth = await fetchJsonOnce(https, {
            hostname: config.anthropicHost,
            port: config.anthropicPort,
            path: anthPath,
            method: 'GET',
            headers: anthHeaders,
            timeout: MODELS_FETCH_TIMEOUT_MS,
        });
    } catch (err) {
        console.error('[proxy] models-list: Anthropic fetch failed:', err.message);
        if (!clientRes.headersSent) clientRes.writeHead(502, { 'content-type': 'application/json' });
        return clientRes.end(JSON.stringify({ type: 'error', error: { type: 'upstream_error', message: 'models list: anthropic fetch failed' } }));
    }

    // Scrape rate-limit headers from this real Anthropic response (same as any other
    // Anthropic call) so quota visibility / mode flips keep working off model-list traffic.
    writeUsageFile(anth.headers);

    const anthBody = decompressBody(anth.bodyBuf, anth.headers['content-encoding']);

    // Non-2xx → pass through verbatim (preserve auth errors etc.).
    if (anth.status < 200 || anth.status >= 300) {
        const passHeaders = stripHopByHop(anth.headers);
        passHeaders['content-length'] = Buffer.byteLength(anthBody);
        if (!clientRes.headersSent) clientRes.writeHead(anth.status, passHeaders);
        return clientRes.end(anthBody);
    }

    let anthJson = null;
    try {
        anthJson = JSON.parse(anthBody.toString('utf8'));
    } catch {
        console.warn('[proxy] models-list: Anthropic returned 2xx with unparseable body — continuing with extra sources only');
    }
    const anthropicData = anthJson && Array.isArray(anthJson.data) ? anthJson.data : [];

    // Real ids (post-demap) that also get a [1m] 1M-context variant offered.
    const oneMSet = new Set(config.models1m.split(',').map((s) => s.trim()).filter(Boolean));

    // --- 2. LiteLLM upstream (when enabled) -----------------------------------
    let litellmData = [];
    if (FEATURE_ENABLED) {
        try {
            const requester = litellmParsed.protocol === 'https:' ? https : http;
            const ll = await fetchJsonOnce(requester, {
                hostname: litellmParsed.hostname,
                port: litellmParsed.port,
                path: '/v1/models',
                method: 'GET',
                headers: {
                    host: litellmParsed.hostHeader,
                    authorization: `Bearer ${config.litellmApiKey}`,
                    accept: 'application/json',
                    'accept-encoding': 'identity',
                },
                timeout: MODELS_FETCH_TIMEOUT_MS,
            });
            if (ll.status >= 200 && ll.status < 300) {
                const llBody = decompressBody(ll.bodyBuf, ll.headers['content-encoding']);
                const llJson = JSON.parse(llBody.toString('utf8'));
                const items = Array.isArray(llJson && llJson.data) ? llJson.data : [];
                // Translate → add opt-in [1m] variants (on real ids) → remap ids into the
                // claude-router-* namespace so the dialog filter accepts them. The real id
                // (and any [1m] suffix) is recovered on the inbound request.
                const real = addOneMVariants(items.map(openAIModelToAnthropic).filter(Boolean), oneMSet);
                litellmData = remapEntries(real);
            } else {
                console.warn(`[proxy] models-list: LiteLLM /v1/models returned ${ll.status} — skipping LiteLLM models`);
            }
        } catch (err) {
            // Non-fatal: the dialog still gets Anthropic (+ Composer) models.
            console.warn('[proxy] models-list: LiteLLM fetch failed, skipping LiteLLM models:', err.message);
        }
    }

    // --- 3. Composer (synthetic, when enabled) --------------------------------
    const composerData = COMPOSER_ENABLED
        ? remapEntries(addOneMVariants(composerModelEntries(config), oneMSet))
        : [];

    // --- 4. Merge + respond ----------------------------------------------------
    const merged = mergeModelLists(anthropicData, litellmData, composerData);
    const out = JSON.stringify({
        data: merged,
        has_more: false,
        first_id: merged.length ? merged[0].id : null,
        last_id: merged.length ? merged[merged.length - 1].id : null,
    });

    if (FEATURE_ENABLED || COMPOSER_ENABLED) {
        console.log(`[proxy] models-list: anthropic=${anthropicData.length} litellm=${litellmData.length} composer=${composerData.length} merged=${merged.length}`);
    }

    if (!clientRes.headersSent) {
        clientRes.writeHead(200, {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(out),
        });
    }
    clientRes.end(out);
}

// ---------------------------------------------------------------------------
// Body buffering + routing
// ---------------------------------------------------------------------------

function bufferRequestBody(req, maxBytes, cb) {
    const chunks = [];
    let total = 0;
    let done = false;
    function finish(err, buf) {
        if (done) return;
        done = true;
        cb(err, buf);
    }
    req.on('data', (chunk) => {
        if (done) return;
        total += chunk.length;
        if (total > maxBytes) {
            const err = new Error(`Request body exceeds MAX_BUFFER_BYTES (${maxBytes})`);
            err.code = 'BODY_TOO_LARGE';
            req.pause();
            finish(err);
            return;
        }
        chunks.push(chunk);
    });
    req.on('end', () => {
        if (done) return;
        finish(null, Buffer.concat(chunks, total));
    });
    req.on('error', (err) => finish(err));
}

function routeWithBody(clientReq, clientRes, bodyBuf) {
    let parsed = null;
    let parseFailed = false;
    try {
        parsed = JSON.parse(bodyBuf.toString('utf8'));
    } catch {
        parseFailed = true;
    }

    // B2 / Option A: parse-failure short-circuit. Send to Anthropic unchanged — do NOT
    // consult quotaState, do NOT enter the unknown-tier redirect path. An unparseable
    // body is a defective request, not a routing opportunity. (Principle 4.)
    if (parseFailed) {
        return forwardToAnthropic(clientReq, clientRes, {
            bodyBufOrStream: bodyBuf,
            captureUsage: true,
            reason: 'parse-failed-fail-safe',
        });
    }

    // Demap: if the client selected a foreign model from the dialog, its `model` carries
    // the claude-router-* wrapper (see remapModelId). Recover the real id and rewrite the
    // body so every downstream forwarder (composer / litellm) sends the underlying model.
    // No-op for normal claude requests and for real foreign ids sent directly via --model.
    if (parsed && typeof parsed.model === 'string' && parsed.model.startsWith(REMAP_PREFIX)) {
        const real = demapModelId(parsed.model); // strips prefix + any trailing [1m]
        console.log(`[proxy] demap: ${parsed.model} -> ${real}`);
        parsed.model = real;
        bodyBuf = rewriteModelInBody(bodyBuf, real); // re-serialize with the real id
        // A foreign model is never an Anthropic-1M model: drop the context-1m beta header
        // (Claude Code adds it whenever the selected name carried `[1m]`) so Composer/LiteLLM
        // don't receive a beta they don't understand. Native claude-*[1m] requests skip this
        // block entirely (no REMAP_PREFIX) and keep their header intact.
        if ('anthropic-beta' in clientReq.headers) {
            const next = withoutBeta(clientReq.headers['anthropic-beta'], ONE_M_BETA);
            if (next === null) delete clientReq.headers['anthropic-beta'];
            else clientReq.headers['anthropic-beta'] = next;
        }
    }

    const modelName = parsed && typeof parsed.model === 'string' ? parsed.model : null;
    const tier = classifyModel(modelName);

    // ROUTING-ORDER INVARIANT: this /^composer/i check MUST stay above BOTH the
    // non-claude->litellm branch (below) AND the shouldRedirect block. Composer is
    // explicit-only and must never be reached via quota redirect. Reordering this block
    // reintroduces the C1/C2-class bugs (Composer reachable via redirect / wrong upstream).
    if (COMPOSER_ENABLED && typeof modelName === 'string' && /^composer/i.test(modelName)) {
        return forwardToComposer(clientReq, clientRes, { parsed, modelName });
    }

    // C1 Fix A: guard with FEATURE_ENABLED — with litellm off (Composer-on body inspection),
    // a non-claude model must fall through to the Anthropic passthrough at the end, NOT reach
    // forwardToLiteLLM with a null litellmParsed (crash).
    if (tier === 'non-claude' && FEATURE_ENABLED) {
        return forwardToLiteLLM(clientReq, clientRes, {
            bodyBuf,
            rewrite: false,
            reason: 'non-claude-model',
            modelName,
        });
    }

    // C1 Fix B (CRITICAL): guard the redirect block with FEATURE_ENABLED. writeUsageFile
    // mutates quotaState unconditionally (L241-244) and shouldRedirect reads it directly, so
    // under composer-on/litellm-off a high-quota claude request would otherwise reach
    // forwardToLiteLLM at the calls below with litellmParsed === null -> crash.
    if (FEATURE_ENABLED && shouldRedirect(quotaState, config.thresholds, mode)) {
        if (tier === 'unknown') {
            // Spec line 44 carve-out: forward body unchanged to LiteLLM. Only applies
            // when the body PARSED but the model name is an unknown claude-* tier (or
            // missing). LiteLLM may reject; that is acceptable per spec.
            return forwardToLiteLLM(clientReq, clientRes, {
                bodyBuf,
                rewrite: false,
                reason: 'redirect-unknown-tier',
                modelName,
            });
        }
        let rewrittenBuf;
        try {
            rewrittenBuf = rewriteModelInBody(bodyBuf, pickFallbackModel(tier, config));
        } catch (err) {
            // Pre-mortem Scenario 2 / Test K — missing env var → 500 with operator-actionable message.
            console.error(`[proxy] redirect-failed: ${err.message}`);
            if (!clientRes.headersSent) {
                clientRes.writeHead(500, { 'content-type': 'text/plain' });
            }
            return clientRes.end(`Proxy: redirect failed — ${err.message}`);
        }
        return forwardToLiteLLM(clientReq, clientRes, {
            bodyBuf: rewrittenBuf,
            rewrite: true,
            reason: `redirect-${tier}`,
            modelName,
        });
    }

    return forwardToAnthropic(clientReq, clientRes, {
        bodyBufOrStream: bodyBuf,
        captureUsage: true,
        reason: 'anthropic-passthrough',
        modelName,
    });
}

function dispatchWithFeature(clientReq, clientRes) {
    const urlPath = (clientReq.url || '').split('?')[0];

    // Model-selection dialog: aggregate models across all backends. Only intercepted
    // when a feature is on (this function is unreachable in pure-passthrough mode), so
    // a feature-off router still forwards GET /v1/models straight to Anthropic.
    // handleModelsList never rejects (it try/catches internally), but guard anyway so a
    // surprise rejection can't surface as an unhandled promise.
    if (clientReq.method === 'GET' && urlPath === MODELS_LIST_PATH) {
        return handleModelsList(clientReq, clientRes).catch((err) => {
            console.error('[proxy] models-list: unexpected handler error:', err.message);
            if (!clientRes.headersSent) {
                clientRes.writeHead(502, { 'content-type': 'application/json' });
            }
            clientRes.end(JSON.stringify({ type: 'error', error: { type: 'upstream_error', message: 'models list failed' } }));
        });
    }

    const needsInspection = clientReq.method === 'POST' && BODY_BEARING_PATHS.has(urlPath);

    if (!needsInspection) {
        return forwardToAnthropic(clientReq, clientRes, {
            bodyBufOrStream: clientReq,
            captureUsage: true,
            reason: 'non-body-bearing',
        });
    }

    bufferRequestBody(clientReq, config.maxBufferBytes, (err, bodyBuf) => {
        if (err) {
            const code = err.code === 'BODY_TOO_LARGE' ? 413 : 400;
            if (!clientRes.headersSent) {
                clientRes.writeHead(code, { 'content-type': 'text/plain' });
            }
            return clientRes.end(err.message);
        }
        routeWithBody(clientReq, clientRes, bodyBuf);
    });
}

// ---------------------------------------------------------------------------
// Probe loop
// ---------------------------------------------------------------------------

function runProbe() {
    if (!FEATURE_ENABLED) return;
    if (mode !== 'litellm') return; // OQ5: probe only when redirected.

    const hostHeader = config.anthropicPort === 443
        ? config.anthropicHost
        : `${config.anthropicHost}:${config.anthropicPort}`;

    const headers = {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        host: hostHeader,
    };

    // Auth precedence: env-supplied key > cached client auth > skip tick.
    if (config.anthropicApiKeyForProbes) {
        headers['x-api-key'] = config.anthropicApiKeyForProbes;
    } else if (lastClientAuth) {
        headers[lastClientAuth.sourceHeader] = lastClientAuth.value;
    } else {
        return; // AC8: skip before first client req when no env-supplied key
    }

    // Probe target was /v1/messages/count_tokens, but empirically that endpoint does
    // not return the anthropic-ratelimit-unified-*-utilization headers. With those
    // missing, writeUsageFile early-returns and quotaState never refreshes, leaving
    // the proxy stranded in litellm mode. /v1/messages with max_tokens=1 reliably
    // returns the headers and consumes a trivial amount of quota (~1 token/probe).
    const body = JSON.stringify({
        model: config.probeModel,
        max_tokens: 1,
        messages: [{ role: 'user', content: '.' }],
    });
    headers['content-length'] = Buffer.byteLength(body);

    const req = https.request({
        hostname: config.anthropicHost,
        port: config.anthropicPort,
        path: '/v1/messages',
        method: 'POST',
        headers,
        timeout: PROBE_TIMEOUT_MS,
    }, (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
            const modeBefore = mode;
            writeUsageFile(res.headers); // also updates quotaState + may flip mode
            probeFailures = 0;
            probeIntervalMs = config.probeIntervalMs;
            console.log(`[proxy] probe: 200 5h=${quotaState.fiveHourPct}% 7d=${quotaState.sevenDayPct}% overage=${quotaState.overagePct}% mode=${modeBefore}->${mode}`);
        } else {
            probeFailures++;
            console.warn(`[proxy] probe: status ${res.statusCode} (failures=${probeFailures})`);
        }
        res.resume(); // drain
    });
    req.on('error', (err) => {
        probeFailures++;
        console.warn(`[proxy] probe: error ${err.message} (failures=${probeFailures})`);
    });
    req.on('timeout', () => req.destroy(new Error('probe timeout')));
    req.end(body);
}

function scheduleNextProbe() {
    if (!FEATURE_ENABLED) return;
    activeProbeTimer = setTimeout(() => {
        try {
            runProbe();
        } catch (err) {
            console.error('[proxy] probe scheduler error:', err.message);
        }
        // Backoff after the probe attempt (reset happens in runProbe on 2xx,
        // and in captureClientAuth on auth change).
        if (probeFailures >= 3) {
            probeIntervalMs = Math.min(probeIntervalMs * 2, PROBE_BACKOFF_CAP_MS);
        }
        scheduleNextProbe();
    }, probeIntervalMs);
    if (activeProbeTimer && typeof activeProbeTimer.unref === 'function') {
        activeProbeTimer.unref();
    }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

// Ensure the target directory exists at startup — fail loudly now rather than silently later
try {
    fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
} catch (err) {
    console.error(`[proxy] Cannot create directory for usage file: ${err.message}`);
    process.exit(1);
}

const server = http.createServer((clientReq, clientRes) => {
    captureClientAuth(clientReq.headers);

    if (!FEATURE_ENABLED && !COMPOSER_ENABLED) {
        // Both features off: byte-identical to pre-Composer behavior (Principle 1).
        return forwardToAnthropic(clientReq, clientRes, {
            bodyBufOrStream: clientReq,
            captureUsage: true,
            // No `reason` → no dispatch log line (Principle 2: feature-off log identity)
        });
    }

    return dispatchWithFeature(clientReq, clientRes);
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`[proxy] Port ${PORT} already in use. Another instance running?`);
    } else {
        console.error('[proxy] Server error:', err.message);
    }
    process.exit(1);
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

function logStartupWarnings() {
    if (!FEATURE_ENABLED) {
        // Principle 2: only one intentional new log line in feature-off mode.
        // Keep it minimal — feature-off operators should see nothing surprising.
        return;
    }
    if (!config.litellmApiKey) {
        console.warn('[proxy] WARNING: LITELLM_URL set but LITELLM_API_KEY missing — redirected requests will fail with 401 from LiteLLM until you set it.');
    }
    for (const tier of ['OPUS', 'SONNET', 'HAIKU']) {
        const key = `LITELLM_FALLBACK_${tier}`;
        const val = config[`fallback${tier.charAt(0)}${tier.slice(1).toLowerCase()}`];
        if (!val) {
            console.warn(`[proxy] WARNING: ${key} unset — claude-${tier.toLowerCase()}-* requests will return 500 when redirect engages.`);
        }
    }
    console.log('[proxy] NOTE: This proxy is single-tenant per running instance. To use multiple Anthropic credentials concurrently (e.g., personal Max + work API key), run separate proxy instances on different ports. State pollution between accounts is a known v1 limitation; per-auth-hash state is a v2 follow-up.');
}

function startServer() {
    server.listen(PORT, BIND, () => {
        console.log(`[proxy] Listening on ${BIND}:${PORT} -> ${config.anthropicHost}:${config.anthropicPort}`);
        console.log(`[proxy] Writing usage to: ${USAGE_FILE}`);
        if (FEATURE_ENABLED) {
            console.log(`[proxy] feature: litellm-fallback enabled (url=${config.litellmUrl})`);
        } else {
            console.log('[proxy] feature: litellm-fallback disabled (LITELLM_URL unset)');
        }
        // Composer line emitted ONLY when enabled (Principle 1: feature-off log identity).
        if (COMPOSER_ENABLED) {
            console.log(`[proxy] feature: composer enabled (url=${config.composerApiUrl})`);
        }
        logStartupWarnings();
        if (FEATURE_ENABLED) scheduleNextProbe();
    });

    process.on('SIGINT',  () => { if (activeProbeTimer) clearTimeout(activeProbeTimer); process.exit(0); });
    process.on('SIGTERM', () => { if (activeProbeTimer) clearTimeout(activeProbeTimer); process.exit(0); });
}

// ---------------------------------------------------------------------------
// Entry / test seam
// ---------------------------------------------------------------------------

if (require.main === module) {
    startServer();
} else {
    module.exports = {
        // Pure helpers
        classifyModel,
        shouldRedirect,
        pickFallbackModel,
        rewriteModelInBody,
        parseUtilPct,
        parseHostOverride,
        // Composer translators (pure) — test seam
        anthropicToOpenAIRequest,
        openAIToAnthropicResponse,
        makeSSETranslator,
        flattenAnthropicText,
        mapFinishReason,
        // Model-list aggregation helpers (pure) — test seam
        openAIModelToAnthropic,
        composerModelEntries,
        mergeModelLists,
        remapModelId,
        demapModelId,
        remapEntries,
        addOneMVariants,
        withoutBeta,
        // Composer config visibility (tests only)
        COMPOSER_ENABLED,
        _composerParsed: () => composerParsed,
        COMPOSER_ROUTE,
        // Internal seams (tests only)
        _state: {
            quotaState,
            lastClientAuth: () => lastClientAuth,
            getMode: () => mode,
            setMode: (m) => { mode = m; },
        },
        _config: config,
        _server: server,
        _startServer: startServer,
        _updateModeFromQuota: updateModeFromQuota,
        _captureClientAuth: captureClientAuth,
    };
}
