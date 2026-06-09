'use strict';

// seed-gateway-cache.js — populate Claude Code's gateway-model-discovery cache so
// the router's models (real Claude + LiteLLM + Composer, remapped + 1M variants)
// show up in the `/model` picker.
//
// WHY THIS EXISTS
// ---------------
// With CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1 + a custom ANTHROPIC_BASE_URL,
// Claude Code's picker is populated from `<CLAUDE_CONFIG_DIR>/cache/gateway-models.json`,
// NOT from a live GET /v1/models (that live fetch only runs for an enterprise gateway
// auth config, which a personal login doesn't have). The picker also DISCARDS the cache
// unless its `baseUrl` matches the current ANTHROPIC_BASE_URL exactly. So we write the
// cache ourselves, with the right baseUrl and the same merged/remapped model set the
// proxy serves on GET /v1/models.
//
// This is dependency-light (Node stdlib only) and reuses the proxy's own pure helpers
// so the id remapping + [1m] variant logic stays identical to the live endpoint.
//
// ENV (mirrors the proxy / claude-router.service):
//   ANTHROPIC_BASE_URL   default http://127.0.0.1:4080  (MUST equal what Claude Code uses)
//   CLAUDE_CONFIG_DIR    default ~/.claude
//   LITELLM_URL          LiteLLM base; when set, its /v1/models are fetched + merged
//   LITELLM_API_KEY      bearer for the LiteLLM fetch
//   CURSOR_API_KEY       when set, Composer models are included
//   COMPOSER_MODELS      default composer-2.5
//   MODELS_1M            ids/globs (e.g. `gemini*`) that also get a [1m] 1M variant
//   SEED_STOCK_MODELS    optional JSON array of {id,display_name} overriding the stock
//                        Claude baseline (so real Claude never drops out of the picker)

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');

const {
    openAIModelToAnthropic,
    composerModelEntries,
    addOneMVariants,
    remapEntries,
    mergeModelLists,
} = require('./proxy.js');

const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL || 'http://127.0.0.1:4080';
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const CACHE_PATH = path.join(CONFIG_DIR, 'cache', 'gateway-models.json');
const FETCH_TIMEOUT_MS = 10000;

const litellmUrl = process.env.LITELLM_URL || '';
const litellmApiKey = process.env.LITELLM_API_KEY || '';
const composerEnabled = !!process.env.CURSOR_API_KEY;
const composerModels = process.env.COMPOSER_MODELS || 'composer-2.5';
const oneMPatterns = (process.env.MODELS_1M || '').split(',').map((s) => s.trim()).filter(Boolean);

// Native Claude models that serve a 1M window. Under a CUSTOM ANTHROPIC_BASE_URL (this
// router), Claude Code does NOT auto-grant them 1M and suppresses its own "(1M context)"
// picker variants — the only way to actually run them at 1M is a model id carrying the
// `[1m]` suffix. So we offer both the plain id (200K) and a `[1m]` variant (1M), exactly
// like Claude Code does on an official endpoint. Override with STOCK_1M_MODELS.
const stock1mPatterns = (process.env.STOCK_1M_MODELS
    || 'claude-opus-4-8,claude-opus-4-7,claude-opus-4-6,claude-sonnet-4-6')
    .split(',').map((s) => s.trim()).filter(Boolean);

// Stock (real Claude) baseline — kept so Claude never drops out of the picker even
// though we can't reach Anthropic's own /v1/models here (no oauth token to forward).
const DEFAULT_STOCK = [
    { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8' },
    { id: 'claude-opus-4-7', display_name: 'Claude Opus 4.7' },
    { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
    { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' },
];
function stockModels() {
    if (!process.env.SEED_STOCK_MODELS) return DEFAULT_STOCK.map((m) => ({ type: 'model', ...m }));
    try {
        const arr = JSON.parse(process.env.SEED_STOCK_MODELS);
        return arr.filter((m) => m && m.id).map((m) => ({ type: 'model', id: m.id, display_name: m.display_name || m.id }));
    } catch {
        return DEFAULT_STOCK.map((m) => ({ type: 'model', ...m }));
    }
}

function fetchJson(url, headers) {
    return new Promise((resolve, reject) => {
        let u;
        try { u = new URL(url); } catch (err) { return reject(err); }
        const requester = u.protocol === 'https:' ? https : http;
        const req = requester.request({
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname + u.search,
            method: 'GET',
            headers: { accept: 'application/json', 'accept-encoding': 'identity', ...headers },
            timeout: FETCH_TIMEOUT_MS,
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
            res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        req.end();
    });
}

// Returns { ok, entries }. `ok` is false only when LiteLLM is configured but the
// fetch failed — the caller then refuses to overwrite a good cache with a degraded one.
async function litellmEntries() {
    if (!litellmUrl) return { ok: true, entries: [] };
    const base = litellmUrl.replace(/\/+$/, '');
    try {
        const r = await fetchJson(`${base}/v1/models`, { authorization: `Bearer ${litellmApiKey}` });
        if (r.status < 200 || r.status >= 300) {
            console.warn(`[seed] LiteLLM /v1/models -> ${r.status}; skipping LiteLLM models`);
            return { ok: false, entries: [] };
        }
        const json = JSON.parse(r.body);
        const items = Array.isArray(json && json.data) ? json.data : [];
        const real = addOneMVariants(items.map(openAIModelToAnthropic).filter(Boolean), oneMPatterns);
        return { ok: true, entries: remapEntries(real) };
    } catch (err) {
        console.warn(`[seed] LiteLLM fetch failed (${err.message}); skipping LiteLLM models`);
        return { ok: false, entries: [] };
    }
}

function composerEntries() {
    if (!composerEnabled) return [];
    return remapEntries(addOneMVariants(composerModelEntries({ composerModels }), oneMPatterns));
}

async function main() {
    const litellm = await litellmEntries();
    // Don't clobber an existing good cache when LiteLLM is configured but unreachable
    // (e.g. a transient outage during a service restart) — leave the prior cache intact.
    if (!litellm.ok && fs.existsSync(CACHE_PATH)) {
        console.warn('[seed] LiteLLM unavailable; leaving existing cache untouched');
        return;
    }
    // Stock Claude keeps its real ids (never remapped) but gains [1m] variants for the
    // 1M-capable models so they're actually selectable at 1M under a custom base URL.
    const stock = addOneMVariants(stockModels(), stock1mPatterns);
    const merged = mergeModelLists(stock, litellm.entries, composerEntries());

    // Picker schema: { baseUrl, fetchedAt, models: [{id, display_name}] }.
    const out = {
        baseUrl: ANTHROPIC_BASE_URL,
        fetchedAt: Date.now(),
        models: merged.map((m) => ({ id: m.id, display_name: m.display_name || m.id })),
    };

    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(out), 'utf8');
    console.log(`[seed] wrote ${out.models.length} models to ${CACHE_PATH}`);
    console.log(`[seed] baseUrl=${out.baseUrl} (must equal Claude Code's ANTHROPIC_BASE_URL)`);
    for (const m of out.models) console.log(`  ${m.id}  —  ${m.display_name}`);
}

main().catch((err) => { console.error('[seed] failed:', err.message); process.exit(1); });
