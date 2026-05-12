'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

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
};

const FEATURE_ENABLED = !!config.litellmUrl;

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

    if (fiveH === null && sevenD === null) return;

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

    const modelName = parsed && typeof parsed.model === 'string' ? parsed.model : null;
    const tier = classifyModel(modelName);

    if (tier === 'non-claude') {
        return forwardToLiteLLM(clientReq, clientRes, {
            bodyBuf,
            rewrite: false,
            reason: 'non-claude-model',
            modelName,
        });
    }

    if (shouldRedirect(quotaState, config.thresholds, mode)) {
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

    const body = JSON.stringify({
        model: config.probeModel,
        messages: [{ role: 'user', content: '.' }],
    });
    headers['content-length'] = Buffer.byteLength(body);

    const req = https.request({
        hostname: config.anthropicHost,
        port: config.anthropicPort,
        path: '/v1/messages/count_tokens',
        method: 'POST',
        headers,
        timeout: PROBE_TIMEOUT_MS,
    }, (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
            writeUsageFile(res.headers); // also updates quotaState + may flip mode
            probeFailures = 0;
            probeIntervalMs = config.probeIntervalMs;
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

    if (!FEATURE_ENABLED) {
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
