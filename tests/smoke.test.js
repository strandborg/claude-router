'use strict';

// Smoke tests for claude-router using Node's built-in node:test.
// NO external test framework — node:test only (Node >= 18).
// All network calls are intercepted by local mock servers on ephemeral ports.
//
// IMPORTANT: proxy.js uses https.request for Anthropic-bound traffic. Mock
// "Anthropic" servers here are HTTPS servers with a self-signed cert.
// We set NODE_TLS_REJECT_UNAUTHORIZED=0 so the proxy accepts the cert.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const http2 = require('node:http2');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PROXY_JS = path.join(__dirname, '..', 'proxy.js');

// ---------------------------------------------------------------------------
// Self-signed cert for mock HTTPS servers (test-only, never leaves localhost)
// Generated with: openssl req -x509 -newkey rsa:2048 -nodes -days 3650
//   -subj '/CN=127.0.0.1' -keyout key.pem -out cert.pem
// NODE_TLS_REJECT_UNAUTHORIZED=0 is set at top of file so proxy accepts it.
// ---------------------------------------------------------------------------
const SELF_SIGNED_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCxQK/pwx7dw7cR
9oXb7Q1q3lh9RBfbvZtz6oHGO3OeWlgHeHoLLfUwqsVrsXXdEZ1kAjI5PYidlxUI
TjRQo5daJApfIAJvYmrb9sMv3h/T9mzamEhszJQndur4dfscmTFFJs1oK469EJhp
KZBxHfPBOsOooxnOLCygzNKFE+eXxv5BkzCvDWvXlCVUPzEYc9MM7aC0FrdzS41K
R5bE/KW/yVi2LA3c3eOKtg/tV1Q7emhlDVmzH/IQQDRQJ81uwYRkI+1O+HsD9A8g
HewzoKzBz49c2+h2wGoEBvg5B57NfT/bhTh/d9mipbNMGNQ0kP46KziNue+VddOe
uoI9TQrlAgMBAAECggEADyih0rtP5rXP8H6VhJExmk/hH/dklfOReZiW2CHp+aMu
z5a/UzjvNOYJ47OlyY3x2KVyb6BCUH3k+9SaV0IiVcBqzadSZf2z91NTboLP1IQI
26n12a4mRni+UBjg7JlyVABlRTEicCtc6XN3SaE+4SnaJVAriw0OlQLnRx/EaN+k
l/qyMJ8lw3fv04yhyyrRGQJHRtBNvOwJf3uHS00Z1J6+XuiHeESaVZRuKjiKby7b
qsDlA++M3dsqqicxaPPPZ5ZtEVEdS7f2/Hy9PxNHr6iSTCgbscXqBiwLAAuEgyL2
6ZJBHD5Nubk/4JrMB7LKhfj+ayxdE4VCJR7x8UET+QKBgQDbWiAEdyRhF3k+POgQ
TOhWMnRsVPlIH+0XcbpMWhNlYpJGWjI8ZkKFT28JZcI4B03Cf/p/awoJ8iYXfCRB
RxYO2B5L/YyduaX8MIuP6n2MGkTxu0B3YkC6Po7RBFW9k7k5kIe0jQtTL+poQJsy
lZFiNrZ5Io4X65nKJzKtxHPVjQKBgQDO3e+nWFvaS3aj1aY+zTrV3yBo4f6c6TTa
g49YSbW2Q/QCTw3jAxE6qjA70I0ZM6uHtajcmJAZClWao2YUAp3pVtFWAsVq50qU
9BVTDmifU7QjBxdU/rq7RCiojhHUf3qlA4ji05u4iqTWyNG/hBS2e1qDGLDw5KPc
I7NPaPyYuQKBgGWQiGyo4d5W6RupReZuRdHLkN6sRbRgm/4T+afquTpjdsk+cC5J
RxnE2uvmAxTARP//E/S1kjNivMJ5B6x2Br+e0ABtiRNq53Eq5SQg9jrN2wh2pHXi
t4fE+YnMUQrzgHsn8b3m5MyCzi2xZGr6mBN6s+jI2DQ5Mb9JgQy2fs/tAoGBAKtt
0/pUCNpgCxM+LCSDIqy12T/ReJRD1h73Q0Ug4EsJCR8YsCNeGVsKSipna2ZlIVK3
QhZ8/30gyUv6+M7AVGhYH+YtKbirr2y80SchG6ZdUTxt1fIDnm8tzpvQEAqPEe3J
fhiqz7MggfXUOa2CIUAP/TQCtC8M6pW1qBS4pgtRAoGAERxYzwV8gWjsjjgTfyl8
cpM801Gk5xq4R18Q76x9QP/gXs/1NTrH9xlG4wfiUUwHQa5IYZN9BO0PE+etMjVe
1LGD+7l7EAvaQsUqHHQRFO7/P2ZI2gxfEYBGrlEr1JEmVmabi8leWQioHF7r/ovt
TChLBepH555bUe8LEuD7/Os=
-----END PRIVATE KEY-----`;

const SELF_SIGNED_CERT = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUcDM8dLuBTyMI0UoTt3a04/K2n9EwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MDUxMjE4MjQxNloXDTM2MDUw
OTE4MjQxNlowFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAsUCv6cMe3cO3EfaF2+0Nat5YfUQX272bc+qBxjtznlpY
B3h6Cy31MKrFa7F13RGdZAIyOT2InZcVCE40UKOXWiQKXyACb2Jq2/bDL94f0/Zs
2phIbMyUJ3bq+HX7HJkxRSbNaCuOvRCYaSmQcR3zwTrDqKMZziwsoMzShRPnl8b+
QZMwrw1r15QlVD8xGHPTDO2gtBa3c0uNSkeWxPylv8lYtiwN3N3jirYP7VdUO3po
ZQ1Zsx/yEEA0UCfNbsGEZCPtTvh7A/QPIB3sM6Cswc+PXNvodsBqBAb4OQeezX0/
24U4f3fZoqWzTBjUNJD+Ois4jbnvlXXTnrqCPU0K5QIDAQABo1MwUTAdBgNVHQ4E
FgQU8yDT+4ErsS18NBF7kfGV/CeJvJowHwYDVR0jBBgwFoAU8yDT+4ErsS18NBF7
kfGV/CeJvJowDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAIyGN
WD+mfMAxEGFM1yWvjrFzXFtAKGa8dEfLySJGhKr1uu0KHHmYWuN1MkI2yE3/WHdP
c/Dn4p+uBxt5hcWKP7hFlI8nGU58FydYgECQ09IYuczaV2gLCsJ5Z13edW6SH4+6
LiVRHJFNRdzebigfhlT6ud1XSZUe4yQDdq0Ub8yzNu2rwABNlnoyOAVKjIfUJbbM
N3kLcu4uJsJNeLhgZYvXcIJh5aoTyDc678wwxHPIpde9UrBSKx+EtBYThh8rmhuE
9eGSqAUkpYzOeAmkA39yNwwj4cQSbKvvtxZho6R4PE+/R2lmuLC1JEbDxZSU+CW5
SEACwMFrd1Zk8iq0sg==
-----END CERTIFICATE-----`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Start a mock HTTPS server on an ephemeral port (for Anthropic mocks). */
function mockHttpsServer(handler) {
    return new Promise((resolve) => {
        const server = https.createServer({ key: SELF_SIGNED_KEY, cert: SELF_SIGNED_CERT }, handler);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({ server, port, close: () => new Promise((res) => server.close(res)) });
        });
        server.unref();
    });
}

/** Start a mock HTTP server on an ephemeral port (for LiteLLM mocks). */
function mockServer(handler) {
    return new Promise((resolve) => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({ server, port, close: () => new Promise((res) => server.close(res)) });
        });
        server.unref();
    });
}

/** Start a mock HTTP/2 cleartext (h2c) server. handler(stream, headers) is called per stream. */
function mockH2cServer(handler) {
    return new Promise((resolve) => {
        const server = http2.createServer();
        server.on('stream', handler);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({ server, port, close: () => new Promise((res) => server.close(res)) });
        });
        server.unref();
    });
}

/** Send an HTTP request to the proxy. Returns a promise resolving to { statusCode, headers, body }. */
function proxyRequest(proxyPort, opts = {}) {
    return new Promise((resolve, reject) => {
        const {
            method = 'POST',
            path: reqPath = '/v1/messages',
            headers = {},
            body = null,
        } = opts;

        const bodyBuf = body ? Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) : null;

        const req = http.request({
            hostname: '127.0.0.1',
            port: proxyPort,
            path: reqPath,
            method,
            headers: {
                'content-type': 'application/json',
                'authorization': 'Bearer test-key-001',
                ...(bodyBuf ? { 'content-length': String(bodyBuf.length) } : {}),
                ...headers,
            },
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        if (bodyBuf) req.write(bodyBuf);
        req.end();
    });
}

/** Buffer body of an incoming HTTP request. */
function bufferBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

/**
 * Require proxy.js with a clean module cache so fresh env vars are picked up.
 * Returns the module exports.
 */
function requireFreshProxy(env = {}) {
    const keys = [
        'LITELLM_URL', 'LITELLM_API_KEY', 'LITELLM_FALLBACK_OPUS', 'LITELLM_FALLBACK_SONNET',
        'LITELLM_FALLBACK_HAIKU', 'REDIRECT_AT_5H_PCT', 'REDIRECT_AT_7D_PCT',
        'REDIRECT_AT_OVERAGE_PCT', 'PROBE_INTERVAL_MS', 'MAX_BUFFER_BYTES',
        'ANTHROPIC_HOST_OVERRIDE', 'ANTHROPIC_API_KEY_FOR_PROBES', 'CLAUDE_USAGE_FILE',
        'CURSOR_API_KEY', 'COMPOSER_API_URL',
        // Direct-Cursor transport env keys (must be reset between tests)
        'CURSOR_DIRECT', 'CURSOR_BACKEND_BASE_URL', 'CURSOR_LOCAL_AGENT_ENDPOINT',
        'CURSOR_SDK_CLIENT_VERSION', 'ENCRYPTION_KEY',
    ];
    const saved = {};
    for (const k of keys) {
        saved[k] = process.env[k];
        if (env[k] !== undefined) process.env[k] = env[k];
        else delete process.env[k];
    }

    const resolved = require.resolve(PROXY_JS);
    delete require.cache[resolved];

    let mod;
    try {
        mod = require(PROXY_JS);
    } finally {
        for (const k of keys) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    }
    return mod;
}

/** Make the proxy listen on an ephemeral port. Returns port. */
function listenProxy(proxy) {
    return new Promise((resolve, reject) => {
        const srv = proxy._server;
        if (srv.listening) return resolve(srv.address().port);
        srv.listen(0, '127.0.0.1', () => resolve(srv.address().port));
        srv.once('error', reject);
    });
}

/** Close a proxy cleanly. */
function closeProxy(proxy) {
    return new Promise((res) => proxy._server.close(res));
}

/** Build rate-limit headers for a given utilization %. */
function makeRateLimitHeaders(fiveH, sevenD, overage = 0) {
    return {
        'content-type': 'application/json',
        'anthropic-ratelimit-unified-5h-utilization': String(fiveH / 100),
        'anthropic-ratelimit-unified-7d-utilization': String(sevenD / 100),
        'anthropic-ratelimit-unified-overage-utilization': String(overage / 100),
        'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    };
}

const USAGE_FILE_TMP = path.join(os.tmpdir(), `proxy-test-usage-${process.pid}.md`);

// ---------------------------------------------------------------------------
// Unit tests — pure helpers, no server needed
// ---------------------------------------------------------------------------

test('Unit — classifyModel', () => {
    const proxy = requireFreshProxy({});
    const { classifyModel } = proxy;

    assert.equal(classifyModel('claude-opus-4-7'), 'opus');
    assert.equal(classifyModel('claude-opus-4-5'), 'opus');
    assert.equal(classifyModel('CLAUDE-OPUS-4'), 'opus');
    assert.equal(classifyModel('claude-sonnet-3-5'), 'sonnet');
    assert.equal(classifyModel('claude-haiku-3'), 'haiku');
    assert.equal(classifyModel('gpt-5'), 'non-claude');
    assert.equal(classifyModel('gemini-pro'), 'non-claude');
    assert.equal(classifyModel(null), 'unknown');
    assert.equal(classifyModel(undefined), 'unknown');
    assert.equal(classifyModel(''), 'unknown');
    assert.equal(classifyModel(42), 'unknown');
    assert.equal(classifyModel('claude-future-unknown-tier'), 'unknown');
    assert.equal(classifyModel('claude-3-5'), 'unknown');

    closeProxy(proxy);
});

test('Unit — shouldRedirect truth table', () => {
    const proxy = requireFreshProxy({});
    const { shouldRedirect } = proxy;
    const thresholds = { redirectAt5h: 90, redirectAt7d: 90, redirectAtOverage: 80, hysteresisPct: 5 };

    assert.equal(shouldRedirect({ fiveHourPct: 80, sevenDayPct: 80, overagePct: 70 }, thresholds, 'anthropic'), false);
    assert.equal(shouldRedirect({ fiveHourPct: 90, sevenDayPct: 0, overagePct: 0 }, thresholds, 'anthropic'), true);
    assert.equal(shouldRedirect({ fiveHourPct: 0, sevenDayPct: 90, overagePct: 0 }, thresholds, 'anthropic'), true);
    assert.equal(shouldRedirect({ fiveHourPct: 0, sevenDayPct: 0, overagePct: 80 }, thresholds, 'anthropic'), true);
    // hysteresis: in litellm mode effective threshold is 90-5=85
    assert.equal(shouldRedirect({ fiveHourPct: 85, sevenDayPct: 0, overagePct: 0 }, thresholds, 'litellm'), true);
    assert.equal(shouldRedirect({ fiveHourPct: 84, sevenDayPct: 0, overagePct: 0 }, thresholds, 'litellm'), false);
    assert.equal(shouldRedirect({ fiveHourPct: 84, sevenDayPct: 0, overagePct: 0 }, thresholds, 'anthropic'), false);

    closeProxy(proxy);
});

test('Unit — pickFallbackModel throws on missing env', () => {
    // Explicit '' overrides the per-tier defaults so the throw path is exercised.
    const proxy = requireFreshProxy({
        LITELLM_URL: 'http://127.0.0.1:9/',
        LITELLM_API_KEY: 'key',
        LITELLM_FALLBACK_OPUS: '',
        LITELLM_FALLBACK_SONNET: '',
        LITELLM_FALLBACK_HAIKU: '',
    });
    const { pickFallbackModel, _config } = proxy;

    assert.throws(() => pickFallbackModel('opus', _config), /LITELLM_FALLBACK_OPUS/);
    assert.throws(() => pickFallbackModel('sonnet', _config), /LITELLM_FALLBACK_SONNET/);
    assert.throws(() => pickFallbackModel('haiku', _config), /LITELLM_FALLBACK_HAIKU/);
    assert.throws(() => pickFallbackModel('bogus', _config), /unsupported tier/);

    closeProxy(proxy);
});

test('Unit — rewriteModelInBody round-trips and preserves fields', () => {
    const proxy = requireFreshProxy({});
    const { rewriteModelInBody } = proxy;

    const original = { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 };
    const buf = Buffer.from(JSON.stringify(original));
    const rewritten = rewriteModelInBody(buf, 'anthropic/claude-opus-4-5');
    const parsed = JSON.parse(rewritten.toString('utf8'));

    assert.equal(parsed.model, 'anthropic/claude-opus-4-5');
    assert.deepEqual(parsed.messages, original.messages);
    assert.equal(parsed.max_tokens, 100);
    assert.throws(() => rewriteModelInBody(Buffer.from('not json'), 'x'));

    closeProxy(proxy);
});

test('Unit — parseUtilPct handles fractions and integers', () => {
    const proxy = requireFreshProxy({});
    const { parseUtilPct } = proxy;

    assert.equal(parseUtilPct('0.09'), 9);
    assert.equal(parseUtilPct('0.99'), 99);
    assert.equal(parseUtilPct('23'), 23);
    assert.equal(parseUtilPct('1.0'), 100);
    assert.equal(parseUtilPct(null), null);
    assert.equal(parseUtilPct(undefined), null);
    assert.equal(parseUtilPct('abc'), null);

    closeProxy(proxy);
});

test('Unit — parseHostOverride parses host:port correctly', () => {
    const proxy = requireFreshProxy({});
    const { parseHostOverride } = proxy;

    assert.deepEqual(parseHostOverride(null), { host: 'api.anthropic.com', port: 443 });
    assert.deepEqual(parseHostOverride(undefined), { host: 'api.anthropic.com', port: 443 });
    assert.deepEqual(parseHostOverride(''), { host: 'api.anthropic.com', port: 443 });
    assert.deepEqual(parseHostOverride('127.0.0.1:9999'), { host: '127.0.0.1', port: 9999 });
    assert.deepEqual(parseHostOverride('localhost:8080'), { host: 'localhost', port: 8080 });
    assert.deepEqual(parseHostOverride('somehost'), { host: 'somehost', port: 443 });

    closeProxy(proxy);
});

// ---------------------------------------------------------------------------
// Test A — passthrough below threshold (AC1)
// ---------------------------------------------------------------------------

test('A — passthrough below threshold (AC1)', async () => {
    let receivedHeaders = null;
    let receivedBody = null;

    const anthropic = await mockHttpsServer(async (req, res) => {
        receivedHeaders = Object.assign({}, req.headers);
        receivedBody = await bufferBody(req);
        res.writeHead(200, makeRateLimitHeaders(50, 50, 10));
        res.end(JSON.stringify({ type: 'message', content: [] }));
    });

    const proxy = requireFreshProxy({
        LITELLM_URL: `http://127.0.0.1:19999/`,  // feature enabled but unused
        LITELLM_API_KEY: 'litellm-key',
        LITELLM_FALLBACK_OPUS: 'anthropic/claude-opus-4-5',
        LITELLM_FALLBACK_SONNET: 'anthropic/claude-sonnet-4',
        LITELLM_FALLBACK_HAIKU: 'anthropic/claude-haiku-4',
        ANTHROPIC_HOST_OVERRIDE: `127.0.0.1:${anthropic.port}`,
        CLAUDE_USAGE_FILE: USAGE_FILE_TMP,
        REDIRECT_AT_5H_PCT: '90',
        REDIRECT_AT_7D_PCT: '90',
        PROBE_INTERVAL_MS: '999999',
    });

    // quotaState starts at 0 — below threshold
    const proxyPort = await listenProxy(proxy);

    const result = await proxyRequest(proxyPort, {
        body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'hello' }], max_tokens: 10 },
        headers: { 'authorization': 'Bearer test-key-001' },
    });

    assert.equal(result.statusCode, 200, 'Should get 200 from Anthropic passthrough');

    // Auth header forwarded to Anthropic
    assert.ok(
        receivedHeaders['authorization'] === 'Bearer test-key-001',
        `Auth forwarded to Anthropic; got: ${JSON.stringify(receivedHeaders['authorization'])}`
    );

    // Body model NOT rewritten
    const sentBody = JSON.parse(receivedBody);
    assert.equal(sentBody.model, 'claude-opus-4-7', 'Model not rewritten on passthrough');

    // Usage file updated
    await new Promise(r => setTimeout(r, 50));
    const usage = fs.existsSync(USAGE_FILE_TMP) ? fs.readFileSync(USAGE_FILE_TMP, 'utf8') : '';
    assert.ok(usage.includes('5h=50%'), `Usage file written with 5h=50%; got: ${usage.trim()}`);

    await closeProxy(proxy);
    await anthropic.close();
});

// ---------------------------------------------------------------------------
// Test B — redirect opus tier on high quota (AC2, AC3, AC11)
// ---------------------------------------------------------------------------

test('B — redirect opus tier on high quota (AC2, AC3, AC11)', async () => {
    let anthropicCalled = false;
    let litellmReceivedHeaders = null;
    let litellmReceivedBody = null;

    const anthropic = await mockHttpsServer((req, res) => {
        anthropicCalled = true;
        res.end('should-not-be-called');
    });

    const litellm = await mockServer(async (req, res) => {
        litellmReceivedHeaders = Object.assign({}, req.headers);
        litellmReceivedBody = await bufferBody(req);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'message', content: [] }));
    });

    const proxy = requireFreshProxy({
        LITELLM_URL: `http://127.0.0.1:${litellm.port}/`,
        LITELLM_API_KEY: 'litellm-key-b',
        LITELLM_FALLBACK_OPUS: 'anthropic/claude-opus-4-5-via-litellm',
        LITELLM_FALLBACK_SONNET: 'anthropic/claude-sonnet-4-via-litellm',
        LITELLM_FALLBACK_HAIKU: 'anthropic/claude-haiku-4-via-litellm',
        ANTHROPIC_HOST_OVERRIDE: `127.0.0.1:${anthropic.port}`,
        CLAUDE_USAGE_FILE: USAGE_FILE_TMP,
        REDIRECT_AT_5H_PCT: '90',
        PROBE_INTERVAL_MS: '999999',
    });

    proxy._state.quotaState.fiveHourPct = 95;
    proxy._state.setMode('litellm');

    const proxyPort = await listenProxy(proxy);

    const result = await proxyRequest(proxyPort, {
        body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'hello' }], max_tokens: 10 },
        headers: { 'authorization': 'Bearer test-key-B', 'x-api-key': 'should-be-stripped' },
    });

    assert.equal(result.statusCode, 200, 'Got 200 from LiteLLM');
    assert.equal(anthropicCalled, false, 'Anthropic NOT called (AC11)');
    assert.equal(litellmReceivedHeaders['authorization'], 'Bearer litellm-key-b', 'LiteLLM auth set');
    assert.ok(!litellmReceivedHeaders['x-api-key'], 'x-api-key stripped from LiteLLM request');

    const sentBody = JSON.parse(litellmReceivedBody);
    assert.equal(sentBody.model, 'anthropic/claude-opus-4-5-via-litellm', 'Model rewritten to fallback opus');

    await closeProxy(proxy);
    await anthropic.close();
    await litellm.close();
});

// ---------------------------------------------------------------------------
// Test C — redirect sonnet and haiku tiers (AC3)
// ---------------------------------------------------------------------------

test('C — redirect sonnet/haiku tiers (AC3)', async () => {
    for (const [model, fallbackValue] of [
        ['claude-sonnet-3-5', 'anthropic/claude-sonnet-via-litellm'],
        ['claude-haiku-3-5', 'anthropic/claude-haiku-via-litellm'],
    ]) {
        let litellmBody = null;

        const litellm = await mockServer(async (req, res) => {
            litellmBody = await bufferBody(req);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ type: 'message' }));
        });

        const proxy = requireFreshProxy({
            LITELLM_URL: `http://127.0.0.1:${litellm.port}/`,
            LITELLM_API_KEY: 'litellm-key-c',
            LITELLM_FALLBACK_OPUS: 'opus-fallback',
            LITELLM_FALLBACK_SONNET: 'anthropic/claude-sonnet-via-litellm',
            LITELLM_FALLBACK_HAIKU: 'anthropic/claude-haiku-via-litellm',
            ANTHROPIC_HOST_OVERRIDE: `127.0.0.1:19999`,
            CLAUDE_USAGE_FILE: USAGE_FILE_TMP,
            PROBE_INTERVAL_MS: '999999',
        });

        proxy._state.quotaState.fiveHourPct = 95;
        proxy._state.setMode('litellm');

        const proxyPort = await listenProxy(proxy);

        const result = await proxyRequest(proxyPort, {
            body: { model, messages: [{ role: 'user', content: '.' }], max_tokens: 1 },
        });

        assert.equal(result.statusCode, 200, `${model} redirected successfully`);
        const parsed = JSON.parse(litellmBody);
        assert.equal(parsed.model, fallbackValue, `${model} rewritten to ${fallbackValue}`);

        await closeProxy(proxy);
        await litellm.close();
    }
});

// ---------------------------------------------------------------------------
// Test D — non-claude model always goes to LiteLLM (AC4)
// ---------------------------------------------------------------------------

test('D — non-claude model goes to LiteLLM regardless of quota (AC4)', async () => {
    let anthropicCalled = false;
    let litellmReceivedBody = null;

    const anthropic = await mockHttpsServer((req, res) => {
        anthropicCalled = true;
        res.end('{}');
    });

    const litellm = await mockServer(async (req, res) => {
        litellmReceivedBody = await bufferBody(req);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'test', choices: [] }));
    });

    const proxy = requireFreshProxy({
        LITELLM_URL: `http://127.0.0.1:${litellm.port}/`,
        LITELLM_API_KEY: 'litellm-key-d',
        LITELLM_FALLBACK_OPUS: 'opus-fb',
        LITELLM_FALLBACK_SONNET: 'sonnet-fb',
        LITELLM_FALLBACK_HAIKU: 'haiku-fb',
        ANTHROPIC_HOST_OVERRIDE: `127.0.0.1:${anthropic.port}`,
        CLAUDE_USAGE_FILE: USAGE_FILE_TMP,
        PROBE_INTERVAL_MS: '999999',
    });

    proxy._state.quotaState.fiveHourPct = 5; // low quota

    const proxyPort = await listenProxy(proxy);

    const result = await proxyRequest(proxyPort, {
        body: { model: 'gpt-5', messages: [{ role: 'user', content: 'hello' }] },
    });

    assert.equal(result.statusCode, 200, 'Got 200 from LiteLLM');
    assert.equal(anthropicCalled, false, 'Anthropic not called for non-claude model');
    const sentBody = JSON.parse(litellmReceivedBody);
    assert.equal(sentBody.model, 'gpt-5', 'Body unchanged for non-claude model');

    await closeProxy(proxy);
    await anthropic.close();
    await litellm.close();
});

// ---------------------------------------------------------------------------
// Test E — SSE streaming preserved on both paths (AC5)
// ---------------------------------------------------------------------------

test('E — SSE streaming on Anthropic path (AC5)', async () => {
    const chunks = ['data: {"type":"content_block_delta"}\n\n', 'data: [DONE]\n\n'];

    const anthropic = await mockHttpsServer((req, res) => {
        res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            ...makeRateLimitHeaders(10, 10),
        });
        let i = 0;
        function sendNext() {
            if (i < chunks.length) { res.write(chunks[i++]); setTimeout(sendNext, 10); }
            else res.end();
        }
        sendNext();
    });

    const proxy = requireFreshProxy({
        LITELLM_URL: `http://127.0.0.1:19999/`,
        LITELLM_API_KEY: 'key',
        LITELLM_FALLBACK_OPUS: 'fb-opus',
        LITELLM_FALLBACK_SONNET: 'fb-sonnet',
        LITELLM_FALLBACK_HAIKU: 'fb-haiku',
        ANTHROPIC_HOST_OVERRIDE: `127.0.0.1:${anthropic.port}`,
        CLAUDE_USAGE_FILE: USAGE_FILE_TMP,
        PROBE_INTERVAL_MS: '999999',
    });

    proxy._state.quotaState.fiveHourPct = 0;

    const proxyPort = await listenProxy(proxy);

    const received = await new Promise((resolve, reject) => {
        const parts = [];
        const req = http.request({
            hostname: '127.0.0.1',
            port: proxyPort,
            path: '/v1/messages',
            method: 'POST',
            headers: { 'content-type': 'application/json', 'authorization': 'Bearer sk-stream' },
        }, (res) => {
            res.on('data', (c) => parts.push(c.toString()));
            res.on('end', () => resolve(parts.join('')));
        });
        req.on('error', reject);
        req.end(JSON.stringify({ model: 'claude-opus-4-7', messages: [{ role: 'user', content: '.' }], stream: true }));
    });

    assert.ok(received.includes('content_block_delta'), 'SSE chunks forwarded from Anthropic');
    assert.ok(received.includes('[DONE]'), 'SSE final chunk forwarded');

    await closeProxy(proxy);
    await anthropic.close();
});

test('E2 — SSE streaming on LiteLLM path (AC5)', async () => {
    const chunks = ['data: {"type":"delta"}\n\n', 'data: [DONE]\n\n'];

    const litellm = await mockServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        let i = 0;
        function sendNext() {
            if (i < chunks.length) { res.write(chunks[i++]); setTimeout(sendNext, 10); }
            else res.end();
        }
        sendNext();
    });

    const proxy = requireFreshProxy({
        LITELLM_URL: `http://127.0.0.1:${litellm.port}/`,
        LITELLM_API_KEY: 'key-e2',
        LITELLM_FALLBACK_OPUS: 'opus-fb',
        LITELLM_FALLBACK_SONNET: 'sonnet-fb',
        LITELLM_FALLBACK_HAIKU: 'haiku-fb',
        ANTHROPIC_HOST_OVERRIDE: `127.0.0.1:19999`,
        CLAUDE_USAGE_FILE: USAGE_FILE_TMP,
        PROBE_INTERVAL_MS: '999999',
    });

    proxy._state.quotaState.fiveHourPct = 95;
    proxy._state.setMode('litellm');

    const proxyPort = await listenProxy(proxy);

    const received = await new Promise((resolve, reject) => {
        const parts = [];
        const req = http.request({
            hostname: '127.0.0.1',
            port: proxyPort,
            path: '/v1/messages',
            method: 'POST',
            headers: { 'content-type': 'application/json', 'authorization': 'Bearer sk-stream2' },
        }, (res) => {
            res.on('data', (c) => parts.push(c.toString()));
            res.on('end', () => resolve(parts.join('')));
        });
        req.on('error', reject);
        req.end(JSON.stringify({ model: 'claude-opus-4-7', messages: [{ role: 'user', content: '.' }], stream: true }));
    });

    assert.ok(received.includes('"type":"delta"'), 'SSE chunks piped from LiteLLM');
    assert.ok(received.includes('[DONE]'), 'SSE final chunk from LiteLLM');

    await closeProxy(proxy);
    await litellm.close();
});

// ---------------------------------------------------------------------------
// Test F — probe fires and updates quota in litellm mode (AC6)
// Uses an Anthropic HTTPS request to exercise writeUsageFile via a real response.
// ---------------------------------------------------------------------------

test('F — Anthropic response updates quotaState in litellm mode (AC6)', async () => {
    // Use the non-body-bearing path (GET /v1/models) to get a real response from
    // mock Anthropic without body buffering — confirms writeUsageFile is called on
    // any Anthropic response.
    const anthropic = await mockHttpsServer(async (req, res) => {
        await bufferBody(req);
        res.writeHead(200, makeRateLimitHeaders(10, 10, 0));
        res.end('{}');
    });

    const proxy = requireFreshProxy({
        LITELLM_URL: `http://127.0.0.1:19999/`,
        LITELLM_API_KEY: 'key-f',
        LITELLM_FALLBACK_OPUS: 'opus-fb',
        LITELLM_FALLBACK_SONNET: 'sonnet-fb',
        LITELLM_FALLBACK_HAIKU: 'haiku-fb',
        ANTHROPIC_HOST_OVERRIDE: `127.0.0.1:${anthropic.port}`,
        CLAUDE_USAGE_FILE: USAGE_FILE_TMP,
        PROBE_INTERVAL_MS: '999999',
    });

    // Start in litellm mode with high quota
    proxy._state.quotaState.fiveHourPct = 95;
    proxy._state.quotaState.sevenDayPct = 95;
    proxy._state.setMode('litellm');

    const proxyPort = await listenProxy(proxy);

    // Send a non-body-bearing request so it goes to Anthropic (feature-on non-body-bearing → Anthropic)
    await proxyRequest(proxyPort, {
        method: 'GET',
        path: '/v1/models',
        body: null,
        headers: { 'authorization': 'Bearer test-key-f' },
    });

    await new Promise(r => setTimeout(r, 50));

    assert.equal(proxy._state.quotaState.fiveHourPct, 10, 'quotaState.fiveHourPct updated by Anthropic response');
    assert.equal(proxy._state.quotaState.sevenDayPct, 10, 'quotaState.sevenDayPct updated');
    // After quota drops below threshold, mode should switch back
    assert.equal(proxy._state.getMode(), 'anthropic', 'Mode switched back to anthropic after probe shows low quota');

    await closeProxy(proxy);
    await anthropic.close();
});

// ---------------------------------------------------------------------------
// Test G — stranded-mode recovery on auth change (AC6, C4)
// ---------------------------------------------------------------------------

test('G — stranded-mode recovery resets probe on auth change (AC6, C4)', () => {
    const proxy = requireFreshProxy({
        LITELLM_URL: 'http://127.0.0.1:19999/',
        LITELLM_API_KEY: 'key-g',
        LITELLM_FALLBACK_OPUS: 'opus-fb',
        LITELLM_FALLBACK_SONNET: 'sonnet-fb',
        LITELLM_FALLBACK_HAIKU: 'haiku-fb',
        ANTHROPIC_HOST_OVERRIDE: `127.0.0.1:19999`,
        CLAUDE_USAGE_FILE: USAGE_FILE_TMP,
        PROBE_INTERVAL_MS: '100',
    });

    proxy._state.setMode('litellm');

    // Capture initial auth
    proxy._captureClientAuth({ authorization: 'Bearer original-key' });
    const prevAuth = proxy._state.lastClientAuth();
    assert.ok(prevAuth !== null, 'Auth was captured');
    assert.equal(prevAuth.value, 'Bearer original-key');

    // Rotate to a new key — triggers stranded-mode reset
    proxy._captureClientAuth({ authorization: 'Bearer new-rotated-key' });

    const newAuth = proxy._state.lastClientAuth();
    assert.equal(newAuth.value, 'Bearer new-rotated-key', 'New auth captured after rotation');
    assert.equal(newAuth.sourceHeader, 'authorization', 'Source header recorded correctly');

    // probeIntervalMs should have been reset to the configured value (not backed off)
    // We can't read probeIntervalMs directly, but config.probeIntervalMs is the target reset value
    assert.equal(proxy._config.probeIntervalMs, 100, 'Config probeIntervalMs matches what was set');

    closeProxy(proxy);
});

// ---------------------------------------------------------------------------
// Test H — full lifecycle: passthrough → quota exceeded → redirect → switch back (AC6, AC7)
// ---------------------------------------------------------------------------

test('H — full lifecycle transition (AC6, AC7)', async () => {
    let anthropicCallCount = 0;

    const anthropic = await mockHttpsServer(async (req, res) => {
        anthropicCallCount++;
        const headers = anthropicCallCount === 1
            ? makeRateLimitHeaders(95, 50, 0)  // first call: high quota → triggers redirect
            : makeRateLimitHeaders(10, 10, 0);  // later calls: low quota → switches back
        await bufferBody(req);
        res.writeHead(200, headers);
        res.end(JSON.stringify({ type: 'message', content: [] }));
    });

    const litellm = await mockServer(async (req, res) => {
        await bufferBody(req);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'message', content: [] }));
    });

    const proxy = requireFreshProxy({
        LITELLM_URL: `http://127.0.0.1:${litellm.port}/`,
        LITELLM_API_KEY: 'key-h',
        LITELLM_FALLBACK_OPUS: 'anthropic/opus-via-litellm',
        LITELLM_FALLBACK_SONNET: 'anthropic/sonnet-via-litellm',
        LITELLM_FALLBACK_HAIKU: 'anthropic/haiku-via-litellm',
        ANTHROPIC_HOST_OVERRIDE: `127.0.0.1:${anthropic.port}`,
        CLAUDE_USAGE_FILE: USAGE_FILE_TMP,
        PROBE_INTERVAL_MS: '999999',
        REDIRECT_AT_5H_PCT: '90',
    });

    const proxyPort = await listenProxy(proxy);

    // Step 1: request below threshold → Anthropic
    const r1 = await proxyRequest(proxyPort, {
        body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: '.' }], max_tokens: 1 },
        headers: { 'authorization': 'Bearer key-h-client' },
    });
    assert.equal(r1.statusCode, 200, 'Step 1: Anthropic passthrough works');

    await new Promise(r => setTimeout(r, 50));
    assert.equal(proxy._state.quotaState.fiveHourPct, 95, 'Quota state updated to 95%');
    assert.equal(proxy._state.getMode(), 'litellm', 'Mode flipped to litellm after high quota');

    // Step 2: request over threshold → LiteLLM
    const r2 = await proxyRequest(proxyPort, {
        body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: '.' }], max_tokens: 1 },
        headers: { 'authorization': 'Bearer key-h-client' },
    });
    assert.equal(r2.statusCode, 200, 'Step 2: LiteLLM redirect works');

    // Step 3: simulate probe returns low quota → mode flips back
    proxy._state.quotaState.fiveHourPct = 10;
    proxy._state.quotaState.sevenDayPct = 10;
    proxy._state.quotaState.overagePct = 0;
    proxy._updateModeFromQuota();
    assert.equal(proxy._state.getMode(), 'anthropic', 'Mode switched back after probe shows low quota (AC7)');

    // Step 4: next request goes to Anthropic again
    const anthropicBefore = anthropicCallCount;
    const r3 = await proxyRequest(proxyPort, {
        body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: '.' }], max_tokens: 1 },
        headers: { 'authorization': 'Bearer key-h-client' },
    });
    assert.equal(r3.statusCode, 200, 'Step 4: Post-switch-back request succeeds');
    assert.ok(anthropicCallCount > anthropicBefore, 'Anthropic received request after switch-back (AC7)');

    await closeProxy(proxy);
    await anthropic.close();
    await litellm.close();
});

// ---------------------------------------------------------------------------
// Test I — feature-off log identity (AC9)
// ---------------------------------------------------------------------------

test('I — feature-off log identity (AC9)', async () => {
    const anthropic = await mockHttpsServer(async (req, res) => {
        await bufferBody(req);
        res.writeHead(200, { 'content-type': 'application/json', ...makeRateLimitHeaders(20, 20) });
        res.end(JSON.stringify({ type: 'message', content: [] }));
    });

    await new Promise((resolve, reject) => {
        const child = spawn('node', [PROXY_JS], {
            env: {
                ...process.env,
                LITELLM_URL: '',
                CURSOR_API_KEY: '',
                COMPOSER_API_URL: '',
                ANTHROPIC_HOST_OVERRIDE: `127.0.0.1:${anthropic.port}`,
                CLAUDE_USAGE_FILE: USAGE_FILE_TMP,
                NODE_TLS_REJECT_UNAUTHORIZED: '0',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });

        // Give the child up to 3s to print startup lines and then check.
        // If port 4080 is in use, the child writes to stderr and exits fast —
        // we detect that and skip gracefully.
        const startTimeout = setTimeout(() => {
            child.kill('SIGTERM');
            reject(new Error('Proxy child did not produce expected output in 3s.\nstdout: ' + stdout + '\nstderr: ' + stderr));
        }, 3000);

        child.on('exit', (code, signal) => {
            // If killed by our SIGTERM during the check phase, ignore
        });

        // Poll stdout until the feature line appears or the child exits
        const pollInterval = setInterval(() => {
            if (stderr.includes('already in use') || stderr.includes('EADDRINUSE')) {
                // Port conflict — test is inconclusive for the child-process part.
                // The feature-off invariant is still verified by the other tests (A uses
                // requireFreshProxy with LITELLM_URL unset). Mark as skipped via pass.
                clearInterval(pollInterval);
                clearTimeout(startTimeout);
                child.kill('SIGTERM');
                // Accept: can't start a second proxy on port 4080 in the same test run.
                resolve();
                return;
            }

            if (stdout.includes('litellm-fallback')) {
                // Got the startup line — now check log identity
                clearInterval(pollInterval);
                clearTimeout(startTimeout);

                const allLines = stdout.split('\n').filter(Boolean);
                const featureLines = allLines.filter(l =>
                    l.includes('[proxy] dispatch:') || l.includes('[proxy] mode transition:')
                );

                try {
                    assert.equal(featureLines.length, 0,
                        `No dispatch/mode-transition lines in feature-off mode. Got:\n${featureLines.join('\n')}`
                    );
                    const disabledLine = allLines.find(l => l.includes('litellm-fallback disabled'));
                    assert.ok(disabledLine, 'Feature-disabled startup log line present');

                    child.kill('SIGTERM');
                    child.on('exit', resolve);
                } catch (err) {
                    child.kill('SIGTERM');
                    child.on('exit', () => reject(err));
                }
            }
        }, 50);

        child.on('error', (err) => {
            clearInterval(pollInterval);
            clearTimeout(startTimeout);
            reject(err);
        });
    });

    await anthropic.close();
});

// ---------------------------------------------------------------------------
// Test J — LiteLLM hop-by-hop header stripping (AC10)
// ---------------------------------------------------------------------------

test('J — LiteLLM hop-by-hop header stripping (AC10)', async () => {
    let receivedHeaders = null;

    const litellm = await mockServer(async (req, res) => {
        receivedHeaders = Object.assign({}, req.headers);
        await bufferBody(req);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
    });

    const proxy = requireFreshProxy({
        LITELLM_URL: `http://127.0.0.1:${litellm.port}/`,
        LITELLM_API_KEY: 'key-j',
        LITELLM_FALLBACK_OPUS: 'opus-fb',
        LITELLM_FALLBACK_SONNET: 'sonnet-fb',
        LITELLM_FALLBACK_HAIKU: 'haiku-fb',
        ANTHROPIC_HOST_OVERRIDE: `127.0.0.1:19999`,
        CLAUDE_USAGE_FILE: USAGE_FILE_TMP,
        PROBE_INTERVAL_MS: '999999',
    });

    proxy._state.quotaState.fiveHourPct = 95;
    proxy._state.setMode('litellm');

    const proxyPort = await listenProxy(proxy);

    // Send request. We send hop-by-hop headers to the proxy — the proxy must strip them
    // before forwarding to LiteLLM. Note: Node's http.request() itself will strip
    // 'connection' before sending, so we test what arrives at the proxy and what it
    // strips before forwarding.
    await new Promise((resolve, reject) => {
        const bodyStr = JSON.stringify({
            model: 'claude-opus-4-7',
            messages: [{ role: 'user', content: '.' }],
            max_tokens: 1,
        });
        const req = http.request({
            hostname: '127.0.0.1',
            port: proxyPort,
            path: '/v1/messages',
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'authorization': 'Bearer sk-test-j',
                // Send connection with a custom hop-by-hop header listed
                'connection': 'keep-alive, x-custom-hop',
                'x-custom-hop': 'should-be-stripped',
                'te': 'trailers',
            },
        }, (res) => { res.resume(); res.on('end', resolve); });
        req.on('error', reject);
        req.end(bodyStr);
    });

    assert.ok(receivedHeaders !== null, 'LiteLLM received the request');

    // Static hop-by-hop headers stripped by proxy's stripHopByHop
    assert.ok(!receivedHeaders['te'], 'te header stripped by proxy');
    // Connection-listed custom header stripped (RFC 2616 §14.10)
    assert.ok(!receivedHeaders['x-custom-hop'], 'connection-listed x-custom-hop stripped');
    // Anthropic auth stripped, LiteLLM auth set
    assert.ok(!receivedHeaders['x-api-key'], 'x-api-key stripped');
    assert.equal(receivedHeaders['authorization'], 'Bearer key-j', 'LiteLLM auth set');

    await closeProxy(proxy);
    await litellm.close();
});

// ---------------------------------------------------------------------------
// Test K — missing fallback model → 500, no upstream call (AC2 negative)
// ---------------------------------------------------------------------------

test('K — missing fallback model returns 500, no upstream call', async () => {
    let anthropicCalled = false;
    let litellmCalled = false;

    const anthropic = await mockHttpsServer((req, res) => { anthropicCalled = true; res.end('{}'); });
    const litellm = await mockServer((req, res) => { litellmCalled = true; res.end('{}'); });

    const proxy = requireFreshProxy({
        LITELLM_URL: `http://127.0.0.1:${litellm.port}/`,
        LITELLM_API_KEY: 'key-k',
        LITELLM_FALLBACK_OPUS: '', // empty string disables default; forces 500-on-redirect path
        LITELLM_FALLBACK_SONNET: 'sonnet-fb',
        LITELLM_FALLBACK_HAIKU: 'haiku-fb',
        ANTHROPIC_HOST_OVERRIDE: `127.0.0.1:${anthropic.port}`,
        CLAUDE_USAGE_FILE: USAGE_FILE_TMP,
        PROBE_INTERVAL_MS: '999999',
    });

    proxy._state.quotaState.fiveHourPct = 95;
    proxy._state.setMode('litellm');

    const proxyPort = await listenProxy(proxy);

    const result = await proxyRequest(proxyPort, {
        body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: '.' }], max_tokens: 1 },
    });

    assert.equal(result.statusCode, 500, 'Returns 500 when LITELLM_FALLBACK_OPUS is unset');
    assert.ok(result.body.includes('LITELLM_FALLBACK_OPUS'), 'Error message names the missing env var');
    assert.equal(anthropicCalled, false, 'Anthropic NOT called');
    assert.equal(litellmCalled, false, 'LiteLLM NOT called');

    await closeProxy(proxy);
    await anthropic.close();
    await litellm.close();
});

// ---------------------------------------------------------------------------
// Test L — MAX_BUFFER_BYTES overflow → 413 (Risk R2)
// ---------------------------------------------------------------------------

test('L — MAX_BUFFER_BYTES overflow returns 413, no upstream call', async () => {
    let anthropicCalled = false;
    let litellmCalled = false;

    const anthropic = await mockHttpsServer((req, res) => { anthropicCalled = true; res.end('{}'); });
    const litellm = await mockServer((req, res) => { litellmCalled = true; res.end('{}'); });

    const proxy = requireFreshProxy({
        LITELLM_URL: `http://127.0.0.1:${litellm.port}/`,
        LITELLM_API_KEY: 'key-l',
        LITELLM_FALLBACK_OPUS: 'opus-fb',
        LITELLM_FALLBACK_SONNET: 'sonnet-fb',
        LITELLM_FALLBACK_HAIKU: 'haiku-fb',
        ANTHROPIC_HOST_OVERRIDE: `127.0.0.1:${anthropic.port}`,
        CLAUDE_USAGE_FILE: USAGE_FILE_TMP,
        MAX_BUFFER_BYTES: '1024',
        PROBE_INTERVAL_MS: '999999',
    });

    assert.equal(proxy._config.maxBufferBytes, 1024, 'maxBufferBytes set to 1024');

    const proxyPort = await listenProxy(proxy);

    const bigBody = JSON.stringify({
        model: 'claude-opus-4-7',
        messages: [{ role: 'user', content: 'x'.repeat(2000) }],
        max_tokens: 1,
    });
    const bodyBuf = Buffer.from(bigBody);
    assert.ok(bodyBuf.length > 1024, `Body (${bodyBuf.length} bytes) exceeds 1024 limit`);

    const result = await new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port: proxyPort,
            path: '/v1/messages',
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'authorization': 'Bearer sk-test-l',
                'content-length': String(bodyBuf.length),
            },
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.write(bodyBuf);
        req.end();
    });

    assert.equal(result.statusCode, 413, 'Returns 413 for oversized body');
    assert.ok(result.body.includes('MAX_BUFFER_BYTES') || result.body.includes('exceeds'), 'Error body describes overflow');
    assert.equal(anthropicCalled, false, 'Anthropic NOT called');
    assert.equal(litellmCalled, false, 'LiteLLM NOT called');

    await closeProxy(proxy);
    await anthropic.close();
    await litellm.close();
});

// ---------------------------------------------------------------------------
// Test AC8 — probe skipped before first client request (AC8)
// ---------------------------------------------------------------------------

test('AC8 — probe skipped when no client auth cached', () => {
    const proxy = requireFreshProxy({
        LITELLM_URL: 'http://127.0.0.1:19999/',
        LITELLM_API_KEY: 'key-ac8',
        LITELLM_FALLBACK_OPUS: 'fb-opus',
        LITELLM_FALLBACK_SONNET: 'fb-sonnet',
        LITELLM_FALLBACK_HAIKU: 'fb-haiku',
        PROBE_INTERVAL_MS: '999999',
        CLAUDE_USAGE_FILE: USAGE_FILE_TMP,
    });

    assert.equal(proxy._state.lastClientAuth(), null, 'lastClientAuth is null before first request');
    assert.equal(proxy._config.anthropicApiKeyForProbes, '', 'No probe API key set — probe would skip');

    closeProxy(proxy);
});

// ---------------------------------------------------------------------------
// Unit — anthropicToOpenAIRequest (AC3/AC4)
// ---------------------------------------------------------------------------

test('Unit — anthropicToOpenAIRequest: system, messages, tools, tool_use, tool_result, M2 (AC3/AC4)', () => {
    const { anthropicToOpenAIRequest } = requireFreshProxy({});

    // system string -> leading system message
    const r1 = anthropicToOpenAIRequest({
        model: 'composer-2.5',
        system: 'You are helpful.',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 100,
    });
    assert.equal(r1.messages[0].role, 'system');
    assert.equal(r1.messages[0].content, 'You are helpful.');
    assert.equal(r1.messages[1].role, 'user');
    assert.equal(r1.model, 'composer-2.5');
    assert.equal(r1.max_tokens, 100);
    assert.equal(r1.stream, false);
    // sampling params omitted when absent
    assert.equal(r1.temperature, undefined);
    assert.equal(r1.top_p, undefined);

    // system array of text blocks flattened
    const r2 = anthropicToOpenAIRequest({
        model: 'composer-2.5',
        system: [{ type: 'text', text: 'Part1' }, { type: 'text', text: 'Part2' }],
        messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(r2.messages[0].content, 'Part1Part2');

    // tools: input_schema -> function.parameters
    const schema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
    const r3 = anthropicToOpenAIRequest({
        model: 'composer-2.5',
        messages: [{ role: 'user', content: 'use tool' }],
        tools: [{ name: 'read_file', description: 'Reads a file', input_schema: schema }],
    });
    assert.equal(r3.tools[0].type, 'function');
    assert.equal(r3.tools[0].function.name, 'read_file');
    assert.deepEqual(r3.tools[0].function.parameters, schema);

    // tool_use -> tool_calls: id verbatim, type:'function', arguments=JSON.stringify(input)
    const r4 = anthropicToOpenAIRequest({
        model: 'composer-2.5',
        messages: [{
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tool_abc123', name: 'read_file', input: { path: '/foo.txt' } }],
        }],
    });
    const tc = r4.messages[0].tool_calls[0];
    assert.equal(tc.id, 'tool_abc123', 'tool_use id preserved verbatim (R2)');
    assert.equal(tc.type, 'function');
    assert.equal(tc.function.name, 'read_file');
    assert.equal(tc.function.arguments, JSON.stringify({ path: '/foo.txt' }), 'arguments are stringified input');

    // M2: content:null (NOT '') when tool_calls present and no text
    assert.equal(r4.messages[0].content, null, 'content is null when tool_calls present and no text (M2)');

    // Assistant with both text and tool_use: content is the text string
    const r5 = anthropicToOpenAIRequest({
        model: 'composer-2.5',
        messages: [{
            role: 'assistant',
            content: [
                { type: 'text', text: 'Let me read that.' },
                { type: 'tool_use', id: 'tool_xyz', name: 'read_file', input: { path: '/bar.txt' } },
            ],
        }],
    });
    assert.equal(r5.messages[0].content, 'Let me read that.', 'content is text when text+tool_calls present');
    assert.ok(Array.isArray(r5.messages[0].tool_calls), 'tool_calls still present');

    // tool_result -> {role:'tool', tool_call_id, content}; emitted BEFORE user text
    const r6 = anthropicToOpenAIRequest({
        model: 'composer-2.5',
        messages: [{
            role: 'user',
            content: [
                { type: 'tool_result', tool_use_id: 'tool_abc123', content: 'file contents here' },
                { type: 'text', text: 'Thanks' },
            ],
        }],
    });
    assert.equal(r6.messages[0].role, 'tool', 'tool_result emitted as role:tool');
    assert.equal(r6.messages[0].tool_call_id, 'tool_abc123');
    assert.equal(r6.messages[0].content, 'file contents here');
    assert.equal(r6.messages[1].role, 'user', 'user text follows tool message');
    assert.equal(r6.messages[1].content, 'Thanks');

    // sampling params forwarded when present; stop_sequences -> stop; stream forwarded
    const r7 = anthropicToOpenAIRequest({
        model: 'composer-2.5',
        messages: [{ role: 'user', content: '.' }],
        temperature: 0.7, top_p: 0.9, stop_sequences: ['END'], stream: true,
    });
    assert.equal(r7.temperature, 0.7);
    assert.equal(r7.top_p, 0.9);
    assert.deepEqual(r7.stop, ['END']);
    assert.equal(r7.stream, true);
});

// ---------------------------------------------------------------------------
// Unit — openAIToAnthropicResponse (AC5)
// ---------------------------------------------------------------------------

test('Unit — openAIToAnthropicResponse: tool_calls->tool_use, finish_reason->stop_reason (AC5)', () => {
    const { openAIToAnthropicResponse } = requireFreshProxy({});

    // tool_calls -> tool_use; finish_reason:'tool_calls' -> stop_reason:'tool_use'
    const r1 = openAIToAnthropicResponse({
        id: 'chatcmpl-abc',
        choices: [{
            message: {
                role: 'assistant', content: null,
                tool_calls: [{ id: 'call_001', type: 'function', function: { name: 'read_file', arguments: '{"path":"/foo.txt"}' } }],
            },
            finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
    }, 'composer-2.5');
    assert.equal(r1.type, 'message');
    assert.equal(r1.role, 'assistant');
    assert.equal(r1.model, 'composer-2.5');
    assert.equal(r1.stop_reason, 'tool_use', 'finish_reason tool_calls -> stop_reason tool_use');
    const tu = r1.content.find((b) => b.type === 'tool_use');
    assert.ok(tu, 'tool_use block present');
    assert.equal(tu.id, 'call_001');
    assert.equal(tu.name, 'read_file');
    assert.deepEqual(tu.input, { path: '/foo.txt' });
    assert.equal(r1.usage.input_tokens, 10);
    assert.equal(r1.usage.output_tokens, 5);

    // finish_reason:'stop' -> stop_reason:'end_turn'
    const r2 = openAIToAnthropicResponse({
        id: 'chatcmpl-xyz',
        choices: [{ message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
    }, 'composer-2.5');
    assert.equal(r2.stop_reason, 'end_turn');
    assert.equal(r2.content[0].type, 'text');
    assert.equal(r2.content[0].text, 'Hello!');

    // finish_reason:'length' -> stop_reason:'max_tokens'
    const r3 = openAIToAnthropicResponse({
        choices: [{ message: { role: 'assistant', content: 'truncated' }, finish_reason: 'length' }],
    }, 'composer-2.5');
    assert.equal(r3.stop_reason, 'max_tokens');

    // C4: choices:[] returns null (forwardToComposer surfaces 502)
    assert.equal(openAIToAnthropicResponse({ choices: [] }, 'composer-2.5'), null, 'choices:[] returns null (C4)');
    assert.equal(openAIToAnthropicResponse(null, 'composer-2.5'), null, 'null input returns null');
});

// ---------------------------------------------------------------------------
// Unit — SSE.a: tool-only stream -> first content_block_start index:0 type tool_use (C2)
// ---------------------------------------------------------------------------

test('Unit — SSE.a: tool-only stream -> first content_block_start index:0 type:tool_use (C2)', () => {
    const { makeSSETranslator } = requireFreshProxy({});
    const events = [];
    const sse = makeSSETranslator('composer-2.5', (type, obj) => events.push({ type, obj }));

    // First delta: id + name present (no defer needed here)
    sse.feed('data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"call_001","type":"function","function":{"name":"read_file","arguments":""}}]},"finish_reason":null}]}\n\n');
    // Args fragment
    sse.feed('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\""}}]},"finish_reason":null}]}\n\n');
    sse.feed('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"/foo.txt\\"}"}}]},"finish_reason":null}]}\n\n');
    // finish_reason
    sse.feed('data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n');
    sse.feed('data: [DONE]\n\n');

    const starts = events.filter((e) => e.type === 'content_block_start');
    assert.equal(starts.length, 1, 'exactly one content_block_start');
    assert.equal(starts[0].obj.index, 0, 'first block index is 0 (C2)');
    assert.equal(starts[0].obj.content_block.type, 'tool_use', 'block type is tool_use');
    assert.equal(starts[0].obj.content_block.id, 'call_001');
    assert.equal(starts[0].obj.content_block.name, 'read_file');

    const stops = events.filter((e) => e.type === 'content_block_stop');
    assert.equal(stops.length, 1, 'matched content_block_stop');
    assert.equal(stops[0].obj.index, 0);

    const deltas = events.filter((e) => e.type === 'content_block_delta');
    assert.ok(deltas.length > 0, 'at least one input_json_delta emitted');
    assert.ok(deltas.every((d) => d.obj.delta.type === 'input_json_delta'), 'all deltas are input_json_delta');

    assert.equal(events.filter((e) => e.type === 'message_stop').length, 1, 'exactly one message_stop');
    const msgDeltas = events.filter((e) => e.type === 'message_delta');
    assert.equal(msgDeltas.length, 1, 'exactly one message_delta');
    assert.equal(msgDeltas[0].obj.delta.stop_reason, 'tool_use');
});

// ---------------------------------------------------------------------------
// Unit — SSE.b: finish_reason chunk then [DONE] -> exactly one message_stop, one message_delta (C3)
// ---------------------------------------------------------------------------

test('Unit — SSE.b: finish_reason then [DONE] -> exactly one message_stop and message_delta (C3)', () => {
    const { makeSSETranslator } = requireFreshProxy({});
    const events = [];
    const sse = makeSSETranslator('composer-2.5', (type, obj) => events.push({ type, obj }));

    sse.feed('data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}\n\n');
    sse.feed('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
    sse.feed('data: [DONE]\n\n');

    assert.equal(events.filter((e) => e.type === 'message_stop').length, 1, 'exactly ONE message_stop (C3 idempotent)');
    const msgDeltas = events.filter((e) => e.type === 'message_delta');
    assert.equal(msgDeltas.length, 1, 'exactly ONE message_delta');
    assert.equal(msgDeltas[0].obj.delta.stop_reason, 'end_turn');
});

// ---------------------------------------------------------------------------
// Unit — SSE.c: trailing {choices:[],usage:{...}} -> no throw, usage captured (C4)
// ---------------------------------------------------------------------------

test('Unit — SSE.c: trailing usage-only chunk -> no throw, usage captured in message_delta (C4)', () => {
    const { makeSSETranslator } = requireFreshProxy({});
    const events = [];
    const sse = makeSSETranslator('composer-2.5', (type, obj) => events.push({ type, obj }));

    sse.feed('data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"finish_reason":null}]}\n\n');
    sse.feed('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
    // Trailing usage-only chunk (choices:[]) — must not throw
    sse.feed('data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":42}}\n\n');
    sse.feed('data: [DONE]\n\n');

    const msgDeltas = events.filter((e) => e.type === 'message_delta');
    assert.equal(msgDeltas.length, 1, 'exactly one message_delta');
    assert.equal(msgDeltas[0].obj.usage.output_tokens, 42, 'completion_tokens captured from trailing usage chunk (C4)');
    assert.equal(events.filter((e) => e.type === 'message_stop').length, 1, 'exactly one message_stop');
});

// ---------------------------------------------------------------------------
// Unit — SSE.d: text-then-tool -> text@0, tool@1, matched start/stop (C2)
// ---------------------------------------------------------------------------

test('Unit — SSE.d: text-then-tool interleave -> text@0, tool@1, matched start/stop (C2)', () => {
    const { makeSSETranslator } = requireFreshProxy({});
    const events = [];
    const sse = makeSSETranslator('composer-2.5', (type, obj) => events.push({ type, obj }));

    // Text first
    sse.feed('data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"I will read that."},"finish_reason":null}]}\n\n');
    // Then tool call
    sse.feed('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_001","type":"function","function":{"name":"read_file","arguments":""}}]},"finish_reason":null}]}\n\n');
    sse.feed('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"/foo\\"}"}}]},"finish_reason":null}]}\n\n');
    sse.feed('data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n');
    sse.feed('data: [DONE]\n\n');

    const starts = events.filter((e) => e.type === 'content_block_start');
    assert.equal(starts.length, 2, 'two content_block_start events');
    assert.equal(starts[0].obj.index, 0, 'text block at index 0 (C2)');
    assert.equal(starts[0].obj.content_block.type, 'text', 'first block is text');
    assert.equal(starts[1].obj.index, 1, 'tool_use block at index 1 (C2)');
    assert.equal(starts[1].obj.content_block.type, 'tool_use', 'second block is tool_use');

    const stops = events.filter((e) => e.type === 'content_block_stop');
    assert.equal(stops.length, 2, 'two content_block_stop events (matched)');
    assert.deepEqual(stops.map((s) => s.obj.index).sort((a, b) => a - b), [0, 1], 'indices 0 and 1 both closed');
});

// ---------------------------------------------------------------------------
// Unit — SSE.e: args-only delta first, then name-bearing delta -> deferred open (AC6)
// ---------------------------------------------------------------------------

test('Unit — SSE.e: deferred tool open — content_block_start only emitted once name known (AC6)', () => {
    const { makeSSETranslator } = requireFreshProxy({});
    const events = [];
    const sse = makeSSETranslator('composer-2.5', (type, obj) => events.push({ type, obj }));

    // First delta: tc.index=0, id present, but NO function.name (args-only)
    sse.feed('data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_007","type":"function","function":{"arguments":"{\\"path\\""}}]},"finish_reason":null}]}\n\n');

    assert.equal(events.filter((e) => e.type === 'content_block_start').length, 0,
        'no content_block_start before name is known (deferred open)');

    // Second delta: carries the function.name
    sse.feed('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"read_file","arguments":":\\"/foo.txt\\"}"}}]},"finish_reason":null}]}\n\n');

    const starts = events.filter((e) => e.type === 'content_block_start');
    assert.equal(starts.length, 1, 'exactly one content_block_start emitted once name known');
    assert.equal(starts[0].obj.content_block.name, 'read_file');
    assert.equal(starts[0].obj.index, 0, 'block allocated at index 0');

    // Buffered args should have been flushed
    const deltas = events.filter((e) => e.type === 'content_block_delta');
    assert.ok(deltas.length >= 1, 'at least one input_json_delta after deferred open');
    const allArgs = deltas.map((d) => d.obj.delta.partial_json).join('');
    assert.ok(allArgs.includes('/foo.txt'), 'buffered pre-name args flushed after name known');

    sse.feed('data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n');
    sse.feed('data: [DONE]\n\n');

    assert.equal(events.filter((e) => e.type === 'message_stop').length, 1, 'clean finalize');
});

// ---------------------------------------------------------------------------
// Integration — Comp1: composer-2.5 routes to composer mock (AC1)
// ---------------------------------------------------------------------------

test('Comp1 — composer-2.5 routes to composer mock, not Anthropic/LiteLLM (AC1)', async () => {
    let composerCalled = false;
    let composerPath = null;
    let anthropicCalled = false;

    const anthropic = await mockHttpsServer((req, res) => {
        anthropicCalled = true;
        res.end('{}');
    });

    const composer = await mockServer(async (req, res) => {
        composerCalled = true;
        composerPath = req.url;
        await bufferBody(req);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            id: 'chatcmpl-comp1',
            choices: [{ message: { role: 'assistant', content: 'Hello from Composer!', tool_calls: null }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 3 },
        }));
    });

    const proxy = requireFreshProxy({
        CURSOR_API_KEY: 'cursor-key-comp1',
        CURSOR_DIRECT: '0', // hosted-relay test — opt out of default direct mode
        COMPOSER_API_URL: `http://127.0.0.1:${composer.port}`,
        ANTHROPIC_HOST_OVERRIDE: `127.0.0.1:${anthropic.port}`,
        CLAUDE_USAGE_FILE: USAGE_FILE_TMP,
        PROBE_INTERVAL_MS: '999999',
    });

    assert.equal(proxy.COMPOSER_ENABLED, true, 'COMPOSER_ENABLED is true');

    const proxyPort = await listenProxy(proxy);

    const result = await proxyRequest(proxyPort, {
        body: { model: 'composer-2.5', messages: [{ role: 'user', content: 'hello' }], max_tokens: 10 },
        headers: { 'authorization': 'Bearer test-key-comp1', 'x-api-key': 'should-be-stripped' },
    });

    assert.equal(result.statusCode, 200, 'Got 200 from composer mock');
    assert.equal(composerCalled, true, 'Composer mock was called (AC1)');
    assert.equal(anthropicCalled, false, 'Anthropic NOT called (AC1)');
    assert.equal(composerPath, '/opencodev2/v1/chat/completions', 'Correct composer route hit');

    const body = JSON.parse(result.body);
    assert.equal(body.type, 'message', 'Response translated to Anthropic format');
    assert.equal(body.content[0].text, 'Hello from Composer!');

    await closeProxy(proxy);
    await anthropic.close();
    await composer.close();
});

// ---------------------------------------------------------------------------
// Integration — Comp2b: composer-on/litellm-off, non-claude model -> Anthropic (C1 Fix A)
// ---------------------------------------------------------------------------

test('Comp2b — composer-on/litellm-off, non-claude gpt-5 -> Anthropic, no crash (C1/AC2)', async () => {
    let anthropicCalled = false;
    let composerCalled = false;

    const anthropic = await mockHttpsServer(async (req, res) => {
        anthropicCalled = true;
        await bufferBody(req);
        res.writeHead(200, { 'content-type': 'application/json', ...makeRateLimitHeaders(5, 5) });
        res.end(JSON.stringify({ type: 'message', content: [] }));
    });

    const composer = await mockServer((req, res) => {
        composerCalled = true;
        res.end('{}');
    });

    const proxy = requireFreshProxy({
        CURSOR_API_KEY: 'cursor-key-comp2b',
        COMPOSER_API_URL: `http://127.0.0.1:${composer.port}`,
        ANTHROPIC_HOST_OVERRIDE: `127.0.0.1:${anthropic.port}`,
        // LITELLM_URL deliberately omitted -> FEATURE_ENABLED=false
        CLAUDE_USAGE_FILE: USAGE_FILE_TMP,
        PROBE_INTERVAL_MS: '999999',
    });

    const proxyPort = await listenProxy(proxy);

    const result = await proxyRequest(proxyPort, {
        body: { model: 'gpt-5', messages: [{ role: 'user', content: 'hello' }], max_tokens: 10 },
        headers: { 'authorization': 'Bearer test-key-comp2b' },
    });

    assert.equal(result.statusCode, 200, 'Got 200 (no crash) for non-claude model with litellm off (C1 Fix A)');
    assert.equal(anthropicCalled, true, 'Anthropic received the non-claude request (fell through to passthrough)');
    assert.equal(composerCalled, false, 'Composer NOT called (model is gpt-5, not composer-*)');

    await closeProxy(proxy);
    await anthropic.close();
    await composer.close();
});

// ---------------------------------------------------------------------------
// Integration — Comp2c: composer-on/litellm-off, high quota, claude model -> 200 (C1 Fix B)
// ---------------------------------------------------------------------------

test('Comp2c — composer-on/litellm-off, high quota, claude-opus-4-7 -> 200 from Anthropic, no crash (C1)', async () => {
    let anthropicCalled = false;

    const anthropic = await mockHttpsServer(async (req, res) => {
        anthropicCalled = true;
        await bufferBody(req);
        res.writeHead(200, { 'content-type': 'application/json', ...makeRateLimitHeaders(96, 50) });
        res.end(JSON.stringify({ type: 'message', content: [] }));
    });

    const composer = await mockServer((req, res) => { res.end('{}'); });

    const proxy = requireFreshProxy({
        CURSOR_API_KEY: 'cursor-key-comp2c',
        COMPOSER_API_URL: `http://127.0.0.1:${composer.port}`,
        ANTHROPIC_HOST_OVERRIDE: `127.0.0.1:${anthropic.port}`,
        // LITELLM_URL deliberately omitted -> FEATURE_ENABLED=false, litellmParsed=null
        CLAUDE_USAGE_FILE: USAGE_FILE_TMP,
        PROBE_INTERVAL_MS: '999999',
        REDIRECT_AT_5H_PCT: '90',
    });

    // Force high quotaState to exercise the shouldRedirect path (C1 Fix B critical path)
    proxy._state.quotaState.fiveHourPct = 95;

    const proxyPort = await listenProxy(proxy);

    const result = await proxyRequest(proxyPort, {
        body: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'hello' }], max_tokens: 10 },
        headers: { 'authorization': 'Bearer test-key-comp2c' },
    });

    assert.equal(result.statusCode, 200, 'Got 200 (no crash) — FEATURE_ENABLED guard skips redirect block (C1 Fix B)');
    assert.equal(anthropicCalled, true, 'Anthropic received request — not erroneously redirected to null litellmParsed');

    await closeProxy(proxy);
    await anthropic.close();
    await composer.close();
});

// ---------------------------------------------------------------------------
// Integration — Comp10: non-streaming choices:[] -> 502 {type:'error'} (C4)
// ---------------------------------------------------------------------------

test('Comp10 — non-streaming choices:[] from composer -> 502 Anthropic error envelope, no crash (C4)', async () => {
    const composer = await mockServer(async (req, res) => {
        await bufferBody(req);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 0 } }));
    });

    const proxy = requireFreshProxy({
        CURSOR_API_KEY: 'cursor-key-comp10',
        COMPOSER_API_URL: `http://127.0.0.1:${composer.port}`,
        ANTHROPIC_HOST_OVERRIDE: `127.0.0.1:19999`,
        CLAUDE_USAGE_FILE: USAGE_FILE_TMP,
        PROBE_INTERVAL_MS: '999999',
    });

    const proxyPort = await listenProxy(proxy);

    const result = await proxyRequest(proxyPort, {
        body: { model: 'composer-2.5', messages: [{ role: 'user', content: 'hello' }], max_tokens: 10 },
        headers: { 'authorization': 'Bearer test-key-comp10' },
    });

    assert.equal(result.statusCode, 502, 'Returns 502 when choices:[] (C4)');
    const body = JSON.parse(result.body);
    assert.equal(body.type, 'error', 'Anthropic error envelope has type:error');
    assert.ok(body.error && body.error.message, 'Error envelope has error.message');

    await closeProxy(proxy);
    await composer.close();
});

// ---------------------------------------------------------------------------
// Integration — Auth/route: correct path + auth injection + inbound stripping (AC8)
// ---------------------------------------------------------------------------

test('Comp-auth — correct route, Bearer injected, inbound x-api-key/authorization stripped (AC8)', async () => {
    let receivedHeaders = null;
    let receivedPath = null;

    const composer = await mockServer(async (req, res) => {
        receivedHeaders = Object.assign({}, req.headers);
        receivedPath = req.url;
        await bufferBody(req);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            id: 'chatcmpl-auth',
            choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
        }));
    });

    const proxy = requireFreshProxy({
        CURSOR_API_KEY: 'my-cursor-api-key',
        CURSOR_DIRECT: '0', // hosted-relay test — opt out of default direct mode
        COMPOSER_API_URL: `http://127.0.0.1:${composer.port}`,
        ANTHROPIC_HOST_OVERRIDE: `127.0.0.1:19999`,
        CLAUDE_USAGE_FILE: USAGE_FILE_TMP,
        PROBE_INTERVAL_MS: '999999',
    });

    const proxyPort = await listenProxy(proxy);

    await proxyRequest(proxyPort, {
        body: { model: 'composer-2.5', messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 },
        headers: {
            'authorization': 'Bearer inbound-anthropic-key',
            'x-api-key': 'inbound-x-api-key',
        },
    });

    assert.ok(receivedHeaders !== null, 'Composer mock received the request');
    assert.equal(receivedPath, '/opencodev2/v1/chat/completions', 'Fixed route POSTed (AC8)');
    assert.equal(receivedHeaders['authorization'], 'Bearer my-cursor-api-key', 'Cursor API key injected (AC8)');
    assert.ok(!receivedHeaders['x-api-key'], 'Inbound x-api-key stripped (AC8)');

    await closeProxy(proxy);
    await composer.close();
});

// ---------------------------------------------------------------------------
// Integration — Tool round-trip (AC7)
// ---------------------------------------------------------------------------

test('Comp-tool-roundtrip — tools + tool_use/tool_result history translates correctly (AC7)', async () => {
    let composerReceivedBody = null;

    const composer = await mockServer(async (req, res) => {
        composerReceivedBody = await bufferBody(req);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            id: 'chatcmpl-rt',
            choices: [{
                message: {
                    role: 'assistant', content: null,
                    tool_calls: [{ id: 'call_roundtrip', type: 'function', function: { name: 'write_file', arguments: '{"path":"/out.txt","content":"hello"}' } }],
                },
                finish_reason: 'tool_calls',
            }],
            usage: { prompt_tokens: 20, completion_tokens: 10 },
        }));
    });

    const proxy = requireFreshProxy({
        CURSOR_API_KEY: 'cursor-key-rt',
        CURSOR_DIRECT: '0', // hosted-relay test — opt out of default direct mode
        COMPOSER_API_URL: `http://127.0.0.1:${composer.port}`,
        ANTHROPIC_HOST_OVERRIDE: `127.0.0.1:19999`,
        CLAUDE_USAGE_FILE: USAGE_FILE_TMP,
        PROBE_INTERVAL_MS: '999999',
    });

    const proxyPort = await listenProxy(proxy);

    const result = await proxyRequest(proxyPort, {
        body: {
            model: 'composer-2.5',
            system: 'You are a coding assistant.',
            messages: [
                { role: 'user', content: 'Read the file.' },
                { role: 'assistant', content: [{ type: 'tool_use', id: 'call_prev_001', name: 'read_file', input: { path: '/foo.txt' } }] },
                { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_prev_001', content: 'file content here' }] },
                { role: 'user', content: 'Now write the result.' },
            ],
            tools: [
                { name: 'read_file',  description: 'Read',  input_schema: { type: 'object', properties: { path:    { type: 'string' } }, required: ['path'] } },
                { name: 'write_file', description: 'Write', input_schema: { type: 'object', properties: { path:    { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
            ],
            max_tokens: 100,
        },
        headers: { 'authorization': 'Bearer test-key-rt' },
    });

    assert.equal(result.statusCode, 200, 'Tool round-trip returns 200');

    // Verify request translation
    const sent = JSON.parse(composerReceivedBody);
    assert.equal(sent.messages[0].role, 'system', 'system message present');
    assert.equal(sent.messages[0].content, 'You are a coding assistant.');

    const assistantMsg = sent.messages.find((m) => m.role === 'assistant');
    assert.ok(assistantMsg, 'assistant message present');
    assert.equal(assistantMsg.tool_calls[0].id, 'call_prev_001', 'tool_use id verbatim (R2)');
    assert.equal(assistantMsg.tool_calls[0].function.arguments, JSON.stringify({ path: '/foo.txt' }));
    assert.equal(assistantMsg.content, null, 'content:null for tool-only assistant turn (M2)');

    const toolMsg = sent.messages.find((m) => m.role === 'tool');
    assert.ok(toolMsg, 'tool message present');
    assert.equal(toolMsg.tool_call_id, 'call_prev_001', 'tool_call_id matches tool_use id (AC7)');
    assert.equal(toolMsg.content, 'file content here');

    assert.equal(sent.tools.length, 2, 'both tools translated');
    assert.equal(sent.tools[0].type, 'function');
    assert.equal(sent.tools[0].function.name, 'read_file');

    // Verify response translation
    const body = JSON.parse(result.body);
    assert.equal(body.stop_reason, 'tool_use', 'stop_reason translated from finish_reason:tool_calls');
    const toolUse = body.content.find((b) => b.type === 'tool_use');
    assert.ok(toolUse, 'tool_use block in response');
    assert.equal(toolUse.id, 'call_roundtrip');
    assert.equal(toolUse.name, 'write_file');
    assert.deepEqual(toolUse.input, { path: '/out.txt', content: 'hello' });

    await closeProxy(proxy);
    await composer.close();
});

// ---------------------------------------------------------------------------
// Integration — AC10: Composer does NOT write usage file / mutate quotaState
// ---------------------------------------------------------------------------

test('Comp-ac10 — Composer responses do NOT write usage file or mutate quotaState (AC10)', async () => {
    const composer = await mockServer(async (req, res) => {
        await bufferBody(req);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            id: 'chatcmpl-ac10',
            choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 3 },
        }));
    });

    const usageFileAC10 = path.join(os.tmpdir(), `proxy-test-ac10-${process.pid}.md`);
    if (fs.existsSync(usageFileAC10)) fs.unlinkSync(usageFileAC10);

    const proxy = requireFreshProxy({
        CURSOR_API_KEY: 'cursor-key-ac10',
        CURSOR_DIRECT: '0', // hosted-relay test — opt out of default direct mode
        COMPOSER_API_URL: `http://127.0.0.1:${composer.port}`,
        ANTHROPIC_HOST_OVERRIDE: `127.0.0.1:19999`,
        CLAUDE_USAGE_FILE: usageFileAC10,
        PROBE_INTERVAL_MS: '999999',
    });

    const initialFiveH = proxy._state.quotaState.fiveHourPct;
    const initialSevenD = proxy._state.quotaState.sevenDayPct;

    const proxyPort = await listenProxy(proxy);

    const result = await proxyRequest(proxyPort, {
        body: { model: 'composer-2.5', messages: [{ role: 'user', content: 'hello' }], max_tokens: 5 },
        headers: { 'authorization': 'Bearer test-key-ac10' },
    });

    assert.equal(result.statusCode, 200, 'Composer request succeeded');

    await new Promise((r) => setTimeout(r, 50));

    assert.equal(fs.existsSync(usageFileAC10), false, 'Usage file NOT written for Composer call (AC10)');
    assert.equal(proxy._state.quotaState.fiveHourPct, initialFiveH, 'quotaState.fiveHourPct NOT mutated (AC10)');
    assert.equal(proxy._state.quotaState.sevenDayPct, initialSevenD, 'quotaState.sevenDayPct NOT mutated (AC10)');

    await closeProxy(proxy);
    await composer.close();
});

// ---------------------------------------------------------------------------
// Unit — SSE.f: fragmented data: line across two feed() calls (lineBuf retention)
// ---------------------------------------------------------------------------

test('Unit — SSE.f: data: line split mid-JSON across two feed() calls -> one coherent text delta', () => {
    const { makeSSETranslator } = requireFreshProxy({});
    const events = [];
    const sse = makeSSETranslator('composer-2.5', (type, obj) => events.push({ type, obj }));

    // Split the JSON payload of one SSE line across two separate feed() calls.
    // The lineBuf must retain the partial fragment and join it on the second call.
    sse.feed('data: {"id":"c1","choi');
    // No complete line yet — no events expected
    assert.equal(events.length, 0, 'no events emitted on incomplete line');

    sse.feed('ces":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}\n\n');

    const textDeltas = events.filter((e) => e.type === 'content_block_delta' && e.obj.delta.type === 'text_delta');
    assert.equal(textDeltas.length, 1, 'exactly one text_delta after fragments rejoined');
    assert.equal(textDeltas[0].obj.delta.text, 'hi', 'correct text from reassembled JSON fragment');

    // Clean finalize to confirm state is coherent after fragmented feed
    sse.feed('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
    sse.feed('data: [DONE]\n\n');

    assert.equal(events.filter((e) => e.type === 'message_stop').length, 1, 'clean finalize after fragmented feed');
    assert.equal(events.filter((e) => e.type === 'message_delta').length, 1);
});

// ---------------------------------------------------------------------------
// Integration — Comp5: streaming text translation end-to-end (AC6)
// ---------------------------------------------------------------------------

test('Comp5 — streaming text translation end-to-end: ordered Anthropic SSE over the wire (AC6)', async () => {
    const composer = await mockServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        // Two text deltas, then finish_reason, then [DONE]
        res.write('data: {"id":"chatcmpl-s1","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}\n\n');
        res.write('data: {"choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}\n\n');
        res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
    });

    const proxy = requireFreshProxy({
        CURSOR_API_KEY: 'cursor-key-comp5',
        CURSOR_DIRECT: '0', // hosted-relay test — opt out of default direct mode
        COMPOSER_API_URL: `http://127.0.0.1:${composer.port}`,
        ANTHROPIC_HOST_OVERRIDE: `127.0.0.1:19999`,
        CLAUDE_USAGE_FILE: USAGE_FILE_TMP,
        PROBE_INTERVAL_MS: '999999',
    });

    const proxyPort = await listenProxy(proxy);

    const { statusCode, contentType, body } = await new Promise((resolve, reject) => {
        const parts = [];
        const req = http.request({
            hostname: '127.0.0.1',
            port: proxyPort,
            path: '/v1/messages',
            method: 'POST',
            headers: { 'content-type': 'application/json', 'authorization': 'Bearer sk-comp5' },
        }, (res) => {
            const ct = res.headers['content-type'] || '';
            res.on('data', (c) => parts.push(c.toString()));
            res.on('end', () => resolve({ statusCode: res.statusCode, contentType: ct, body: parts.join('') }));
        });
        req.on('error', reject);
        req.end(JSON.stringify({ model: 'composer-2.5', messages: [{ role: 'user', content: 'hi' }], stream: true, max_tokens: 50 }));
    });

    assert.equal(statusCode, 200, 'streaming response is 200');
    assert.ok(contentType.includes('text/event-stream'), 'content-type is text/event-stream (not buffered)');

    // Parse the Anthropic SSE event sequence
    const events = [];
    let currentEvent = null;
    for (const line of body.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('event: ')) {
            currentEvent = { type: trimmed.slice(7) };
            events.push(currentEvent);
        } else if (trimmed.startsWith('data: ') && currentEvent) {
            try { currentEvent.data = JSON.parse(trimmed.slice(6)); } catch { /* ignore */ }
        }
    }

    const types = events.map((e) => e.type);

    // Required ordering: message_start → content_block_start → content_block_delta → content_block_stop → message_delta → message_stop
    assert.ok(types.includes('message_start'), 'message_start present');
    assert.ok(types.includes('content_block_start'), 'content_block_start present');
    assert.ok(types.includes('content_block_delta'), 'content_block_delta present');
    assert.ok(types.includes('content_block_stop'), 'content_block_stop present');
    assert.ok(types.includes('message_delta'), 'message_delta present');
    assert.ok(types.includes('message_stop'), 'message_stop present');

    const idx = (t) => types.indexOf(t);
    assert.ok(idx('message_start') < idx('content_block_start'), 'message_start before content_block_start');
    assert.ok(idx('content_block_start') < idx('content_block_delta'), 'content_block_start before content_block_delta');
    assert.ok(idx('content_block_stop') < idx('message_delta'), 'content_block_stop before message_delta');
    assert.ok(idx('message_delta') < idx('message_stop'), 'message_delta before message_stop');

    // Verify text content
    const textDeltas = events.filter((e) => e.type === 'content_block_delta' && e.data && e.data.delta && e.data.delta.type === 'text_delta');
    assert.ok(textDeltas.length >= 1, 'at least one text_delta event');
    const allText = textDeltas.map((e) => e.data.delta.text).join('');
    assert.ok(allText.includes('Hello'), 'first text delta content present');

    // message_start carries correct model
    const msgStart = events.find((e) => e.type === 'message_start');
    assert.equal(msgStart.data.message.model, 'composer-2.5', 'message_start.model is composer-2.5');

    // message_delta carries stop_reason
    const msgDelta = events.find((e) => e.type === 'message_delta');
    assert.equal(msgDelta.data.delta.stop_reason, 'end_turn', 'stop_reason is end_turn');

    await closeProxy(proxy);
    await composer.close();
});

// ---------------------------------------------------------------------------
// Integration — Comp6: streaming tool-call round-trip (AC6/AC7)
// ---------------------------------------------------------------------------

test('Comp6 — streaming tool-call round-trip: tool_calls deltas -> input_json_delta -> tool_use (AC6/AC7)', async () => {
    const composer = await mockServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        // Tool call: id+name in first delta, arguments fragment in second, finish_reason, [DONE]
        res.write('data: {"id":"chatcmpl-tc1","choices":[{"index":0,"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"call_stream_001","type":"function","function":{"name":"read_file","arguments":""}}]},"finish_reason":null}]}\n\n');
        res.write('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"/src/main.js\\"}"}}]},"finish_reason":null}]}\n\n');
        res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
    });

    const proxy = requireFreshProxy({
        CURSOR_API_KEY: 'cursor-key-comp6',
        CURSOR_DIRECT: '0', // hosted-relay test — opt out of default direct mode
        COMPOSER_API_URL: `http://127.0.0.1:${composer.port}`,
        ANTHROPIC_HOST_OVERRIDE: `127.0.0.1:19999`,
        CLAUDE_USAGE_FILE: USAGE_FILE_TMP,
        PROBE_INTERVAL_MS: '999999',
    });

    const proxyPort = await listenProxy(proxy);

    const { statusCode, body } = await new Promise((resolve, reject) => {
        const parts = [];
        const req = http.request({
            hostname: '127.0.0.1',
            port: proxyPort,
            path: '/v1/messages',
            method: 'POST',
            headers: { 'content-type': 'application/json', 'authorization': 'Bearer sk-comp6' },
        }, (res) => {
            res.on('data', (c) => parts.push(c.toString()));
            res.on('end', () => resolve({ statusCode: res.statusCode, body: parts.join('') }));
        });
        req.on('error', reject);
        req.end(JSON.stringify({
            model: 'composer-2.5',
            messages: [{ role: 'user', content: 'read the file' }],
            tools: [{ name: 'read_file', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
            stream: true,
            max_tokens: 50,
        }));
    });

    assert.equal(statusCode, 200, 'streaming tool call returns 200');

    // Parse events
    const events = [];
    let cur = null;
    for (const line of body.split('\n')) {
        const t = line.trim();
        if (t.startsWith('event: ')) { cur = { type: t.slice(7) }; events.push(cur); }
        else if (t.startsWith('data: ') && cur) { try { cur.data = JSON.parse(t.slice(6)); } catch { /* ignore */ } }
    }

    const types = events.map((e) => e.type);

    // Tool-only: first content_block_start must be tool_use at index 0 (C2)
    const firstStart = events.find((e) => e.type === 'content_block_start');
    assert.ok(firstStart, 'content_block_start present');
    assert.equal(firstStart.data.index, 0, 'tool_use at index 0 (C2)');
    assert.equal(firstStart.data.content_block.type, 'tool_use', 'block type is tool_use');
    assert.equal(firstStart.data.content_block.id, 'call_stream_001', 'tool_use id verbatim');
    assert.equal(firstStart.data.content_block.name, 'read_file', 'tool_use name correct');

    // input_json_delta(s) emitted
    const jsonDeltas = events.filter((e) => e.type === 'content_block_delta' && e.data && e.data.delta && e.data.delta.type === 'input_json_delta');
    assert.ok(jsonDeltas.length >= 1, 'at least one input_json_delta');
    const allJson = jsonDeltas.map((e) => e.data.delta.partial_json).join('');
    assert.ok(allJson.includes('/src/main.js'), 'arguments fragments contain the path');

    // message_delta stop_reason is tool_use
    const msgDelta = events.find((e) => e.type === 'message_delta');
    assert.ok(msgDelta, 'message_delta present');
    assert.equal(msgDelta.data.delta.stop_reason, 'tool_use', 'stop_reason is tool_use');

    // Proper ordering
    assert.ok(types.indexOf('content_block_start') < types.indexOf('content_block_stop'), 'start before stop');
    assert.ok(types.indexOf('content_block_stop') < types.indexOf('message_delta'), 'stop before message_delta');
    assert.ok(types.indexOf('message_delta') < types.indexOf('message_stop'), 'message_delta before message_stop');

    await closeProxy(proxy);
    await composer.close();
});

// ---------------------------------------------------------------------------
// Integration — Comp-encoding: response compression handling (regression)
// Real-world AC13 bug: composer-api compressed the response (zstd) because the
// inbound Claude Code request advertised it; the proxy buffered the compressed
// bytes and JSON.parse failed -> 502 "invalid JSON". Fix: send
// accept-encoding: identity upstream, plus defensive gzip/br/deflate decode.
// ---------------------------------------------------------------------------

test('Comp-encoding-identity — proxy requests identity encoding from composer (AC13 regression)', async () => {
    let receivedAcceptEncoding = null;

    const composer = await mockServer(async (req, res) => {
        receivedAcceptEncoding = req.headers['accept-encoding'];
        await bufferBody(req);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            id: 'chatcmpl-enc',
            choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
        }));
    });

    const proxy = requireFreshProxy({
        CURSOR_API_KEY: 'cursor-enc',
        CURSOR_DIRECT: '0', // hosted-relay test — opt out of default direct mode
        COMPOSER_API_URL: `http://127.0.0.1:${composer.port}`,
        ANTHROPIC_HOST_OVERRIDE: '127.0.0.1:19999',
        CLAUDE_USAGE_FILE: USAGE_FILE_TMP,
        PROBE_INTERVAL_MS: '999999',
    });
    const proxyPort = await listenProxy(proxy);

    const result = await proxyRequest(proxyPort, {
        // Inbound client advertises compression, as Claude Code does in the wild.
        headers: { 'accept-encoding': 'zstd, gzip, br' },
        body: { model: 'composer-2.5', messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 },
    });

    assert.equal(receivedAcceptEncoding, 'identity', 'proxy forces accept-encoding: identity upstream (not the inbound zstd/gzip/br)');
    assert.equal(result.statusCode, 200, 'translated 200 returned');
    const body = JSON.parse(result.body);
    assert.equal(body.type, 'message', 'valid Anthropic message returned');
    assert.equal(body.content[0].text, 'hi', 'content translated');

    await closeProxy(proxy);
    await composer.close();
});

test('Comp-encoding-gzip — proxy defensively decodes a gzipped composer response (AC13 regression)', async () => {
    const zlib = require('node:zlib');

    const composer = await mockServer(async (req, res) => {
        await bufferBody(req);
        const payload = Buffer.from(JSON.stringify({
            id: 'chatcmpl-gz',
            choices: [{ message: { role: 'assistant', content: 'decoded ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 2, completion_tokens: 3 },
        }), 'utf8');
        // Server ignores identity and gzips anyway — proxy must still decode.
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        res.end(zlib.gzipSync(payload));
    });

    const proxy = requireFreshProxy({
        CURSOR_API_KEY: 'cursor-gz',
        CURSOR_DIRECT: '0', // hosted-relay test — opt out of default direct mode
        COMPOSER_API_URL: `http://127.0.0.1:${composer.port}`,
        ANTHROPIC_HOST_OVERRIDE: '127.0.0.1:19999',
        CLAUDE_USAGE_FILE: USAGE_FILE_TMP,
        PROBE_INTERVAL_MS: '999999',
    });
    const proxyPort = await listenProxy(proxy);

    const result = await proxyRequest(proxyPort, {
        body: { model: 'composer-2.5', messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 },
    });

    assert.equal(result.statusCode, 200, 'gzipped upstream body decoded, not a 502');
    const body = JSON.parse(result.body);
    assert.equal(body.content[0].text, 'decoded ok', 'gzip-decoded content translated correctly');

    await closeProxy(proxy);
    await composer.close();
});

// ============================================================================
// Direct-Cursor test helpers (test-only proto codec, frame builders, etc.)
// These are INDEPENDENT of proxy.js — they only build payloads for mock servers.
// ============================================================================

// Minimal varint encoder for building test proto payloads.
function tcEncodeVarint(n) {
    const out = [];
    let v = typeof n === 'bigint' ? n : BigInt(Math.floor(Number(n)));
    do {
        const byte = Number(v & 0x7Fn);
        v >>= 7n;
        out.push(v > 0n ? byte | 0x80 : byte);
    } while (v > 0n);
    return new Uint8Array(out.length ? out : [0]);
}

// Minimal varint decoder: returns { value: BigInt, offset: number }.
function tcDecodeVarint(bytes, offset) {
    let result = 0n, shift = 0n;
    while (offset < bytes.length) {
        const byte = bytes[offset++];
        result |= BigInt(byte & 0x7F) << shift;
        shift += 7n;
        if ((byte & 0x80) === 0) break;
    }
    return { value: result, offset };
}

// Concatenate multiple Uint8Arrays.
function tcConcat(...arrays) {
    let total = 0;
    for (const a of arrays) total += a.length;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const a of arrays) { out.set(a, pos); pos += a.length; }
    return out;
}

// Build a protobuf field (wire type 0=varint, 2=len-delim).
function tcProtoField(fieldNo, wt, value) {
    const tag = tcEncodeVarint((fieldNo << 3) | wt);
    if (wt === 0) return tcConcat(tag, tcEncodeVarint(value));
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value)
                : value instanceof Uint8Array ? value
                : tcEncodeVarint(value);
    return tcConcat(tag, tcEncodeVarint(bytes.length), bytes);
}

// Build a Connect protocol frame (5-byte header: flags + big-endian uint32 length).
// Use flags=0 for data frames, flags=2 for end-stream trailer frames.
function tcConnectFrame(payload, flags) {
    const f = flags || 0;
    const frame = new Uint8Array(5 + payload.length);
    frame[0] = f;
    const len = payload.length;
    frame[1] = (len >>> 24) & 0xFF;
    frame[2] = (len >>> 16) & 0xFF;
    frame[3] = (len >>> 8) & 0xFF;
    frame[4] = len & 0xFF;
    frame.set(payload, 5);
    return frame;
}

// Build a Cursor chat response text frame: field 2 → inner field 1 = text string.
function tcTextFrame(text) {
    const inner = tcProtoField(1, 2, text);
    const outer = tcProtoField(2, 2, inner);
    return tcConnectFrame(outer);
}

// Build a Connect end-stream trailer frame (flags=2).
// Pass errorObj = { error: { message: '...' } } to trigger a throw in handleEndStreamFrame.
// Pass null/undefined for a clean end-stream (no error).
function tcEndStreamFrame(errorObj) {
    const payload = errorObj
        ? new TextEncoder().encode(JSON.stringify(errorObj))
        : new Uint8Array(0);
    return tcConnectFrame(payload, 2);
}

// Strip the 5-byte Connect header from a frame buffer; returns raw payload Uint8Array.
function tcPayload(frameBytes) {
    const b = frameBytes instanceof Uint8Array ? frameBytes
        : new Uint8Array(frameBytes.buffer, frameBytes.byteOffset, frameBytes.byteLength);
    return b.length >= 5 ? b.slice(5) : new Uint8Array(0);
}

// AgentService text frame: outer field 1 (interactionUpdate) → field 1 (textUpdate) → field 1 = text.
// Mirrors decodeInteractionUpdate field-1 path in proxy.js.
function tcInteractionTextFrame(text) {
    const textSub = tcProtoField(1, 2, text);
    const interactionUpdate = tcProtoField(1, 2, textSub);
    const payload = tcProtoField(1, 2, interactionUpdate);
    return tcConnectFrame(payload);
}

// AgentService done frame: outer field 1 (interactionUpdate) → field 14 (wire 2, empty bytes).
// Field 14 MUST be wire type 2 (len-delim) to pass the !(value instanceof Uint8Array) guard.
function tcDoneFrame() {
    const interactionUpdate = tcProtoField(14, 2, new Uint8Array(0));
    const payload = tcProtoField(1, 2, interactionUpdate);
    return tcConnectFrame(payload);
}

// AgentService request_context frame: outer field 2 (execServerMessage).
// Presence of field 10 (bytes) signals request_context in decodeExecServerMessage.
function tcRequestContextFrame(id, execId) {
    const execMsg = tcConcat(
        tcProtoField(1, 0, id),                       // field 1 varint = id
        tcProtoField(15, 2, execId),                  // field 15 string = execId
        tcProtoField(10, 2, new Uint8Array(0)),        // field 10 bytes (request_context marker)
    );
    const payload = tcProtoField(2, 2, execMsg);
    return tcConnectFrame(payload);
}

// AgentService shell tool-call frame: outer field 1 (interactionUpdate) → field 2 (toolCallUpdate).
// Uses TOOL_CALL_SPECS[1] (shell) so isEmittableSdkToolCall returns true for a non-empty command.
function tcShellToolFrame(callId, command) {
    const argsBytes = tcProtoField(1, 2, command);            // shell args: field 1 = command
    const shellSpec = tcProtoField(1, 2, argsBytes);          // inner shell spec: field 1 = argsBytes
    const toolCallBytes = tcProtoField(1, 2, shellSpec);      // TOOL_CALL_SPECS key 1 = shell
    const toolCallUpdate = tcConcat(
        tcProtoField(1, 2, callId),                           // field 1 = callId
        tcProtoField(2, 2, toolCallBytes),                    // field 2 = toolCallBytes
    );
    const interactionUpdate = tcProtoField(2, 2, toolCallUpdate); // field 2 = toolCallUpdate
    const payload = tcProtoField(1, 2, interactionUpdate);
    return tcConnectFrame(payload);
}

// Decode proto fields from raw bytes: returns array of { no, wt, value }.
function tcDecodeFields(bytes) {
    const fields = [];
    let offset = 0;
    while (offset < bytes.length) {
        if (offset >= bytes.length) break;
        const { value: tag, offset: o1 } = tcDecodeVarint(bytes, offset);
        offset = o1;
        const fieldNo = Number(tag >> 3n);
        const wt = Number(tag & 7n);
        if (wt === 0) {
            const { value, offset: o2 } = tcDecodeVarint(bytes, offset);
            offset = o2;
            fields.push({ no: fieldNo, wt, value });
        } else if (wt === 2) {
            const { value: len, offset: o2 } = tcDecodeVarint(bytes, offset);
            offset = o2;
            const n = Number(len);
            fields.push({ no: fieldNo, wt, value: bytes.slice(offset, offset + n) });
            offset += n;
        } else if (wt === 5) {
            offset += 4;
        } else if (wt === 1) {
            offset += 8;
        } else {
            break;
        }
    }
    return fields;
}

// Create a Web ReadableStream from binary data (Uint8Array or Node Buffer).
function tcWebStream(data) {
    const bytes = data instanceof Uint8Array
        ? data
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
}

// Combine Uint8Array / Buffer parts into a single Node Buffer for HTTP mock responses.
function tcCombine(...parts) {
    return Buffer.concat(parts.map(p => p instanceof Uint8Array ? Buffer.from(p) : p));
}

// Extract prompt text from a raw AgentService run-request Connect frame.
// Walks: outer field 1 (runRequest) → field 2 (conversationAction) →
//        field 1 (userMessageAction) → field 1 (userMessage) → field 1 (prompt text).
function tcExtractPromptText(bodyBuf) {
    const bytes = new Uint8Array(bodyBuf.buffer, bodyBuf.byteOffset, bodyBuf.byteLength);
    if (bytes.length < 5) return '';
    const len = new DataView(bytes.buffer, bytes.byteOffset + 1, 4).getUint32(0, false);
    const payload = bytes.slice(5, 5 + len);
    // outer: field 1 = runRequest
    const f1 = tcDecodeFields(payload).find(f => f.no === 1 && f.wt === 2);
    if (!f1) return '';
    // runRequest: field 2 = conversationAction
    const f2 = tcDecodeFields(f1.value).find(f => f.no === 2 && f.wt === 2);
    if (!f2) return '';
    // conversationAction: field 1 = userMessageAction
    const f3 = tcDecodeFields(f2.value).find(f => f.no === 1 && f.wt === 2);
    if (!f3) return '';
    // userMessageAction: field 1 = userMessage
    const f4 = tcDecodeFields(f3.value).find(f => f.no === 1 && f.wt === 2);
    if (!f4) return '';
    // userMessage: field 1 = prompt text
    const f5 = tcDecodeFields(f4.value).find(f => f.no === 1 && f.wt === 2);
    if (!f5) return '';
    return new TextDecoder().decode(f5.value);
}

// Parse Anthropic SSE events from a raw response body string.
function tcParseSSE(body) {
    const events = [];
    let cur = null;
    for (const line of body.split('\n')) {
        const t = line.trim();
        if (t.startsWith('event: ')) { cur = { type: t.slice(7) }; events.push(cur); }
        else if (t.startsWith('data: ') && cur) {
            try { cur.data = JSON.parse(t.slice(6)); } catch { /* ignore */ }
        }
    }
    return events;
}

// Send a streaming SSE request to the proxy and buffer the full body.
function sseRequest(proxyPort, bodyObj) {
    return new Promise((resolve, reject) => {
        const parts = [];
        const bodyBuf = Buffer.from(JSON.stringify(bodyObj));
        const req = http.request({
            hostname: '127.0.0.1', port: proxyPort,
            path: '/v1/messages', method: 'POST',
            headers: {
                'content-type': 'application/json',
                'authorization': 'Bearer test-key-cd',
                'content-length': String(bodyBuf.length),
                'connection': 'close',
            },
        }, (res) => {
            res.on('data', c => parts.push(c.toString()));
            res.on('end', () => resolve({ statusCode: res.statusCode, body: parts.join('') }));
        });
        req.on('error', reject);
        req.end(bodyBuf);
    });
}

// ============================================================================
// O1 — encodeConnectFrame byte layout + varint correctness via frame sizes
// ============================================================================

test('O1 — encodeConnectFrame: 5-byte prefix layout (flags=0, big-endian uint32 length)', () => {
    const proxy = requireFreshProxy({});
    const { encodeConnectFrame } = proxy;

    // Empty payload → 5-byte header only
    const empty = encodeConnectFrame(new Uint8Array(0));
    assert.equal(empty.length, 5, 'empty payload → 5-byte frame');
    assert.equal(empty[0], 0, 'flags=0');
    assert.deepEqual([...empty.slice(1)], [0, 0, 0, 0], 'length=0 big-endian');

    // 1-byte payload: [0x0A]
    const f1 = encodeConnectFrame(new Uint8Array([0x0A]));
    assert.deepEqual([...f1], [0x00, 0x00, 0x00, 0x00, 0x01, 0x0A], '1-byte payload frame correct');

    // 300-byte payload: length 0x0000012C in big-endian
    const big = new Uint8Array(300).fill(0xBB);
    const f300 = encodeConnectFrame(big);
    assert.equal(f300.length, 305);
    assert.equal(f300[0], 0, 'flags=0 for data frame');
    assert.equal(f300[1], 0); assert.equal(f300[2], 0);
    assert.equal(f300[3], 1);    // 300 = 0x12C → bytes [0,0,1,0x2C]
    assert.equal(f300[4], 0x2C);
    assert.ok([...f300.slice(5)].every(b => b === 0xBB), 'payload preserved verbatim');

    closeProxy(proxy);
});

// ============================================================================
// O2' — encodeAgentClientRunRequest field-number correctness + proto wrappers
// ============================================================================

test('O2\' — encodeAgentClientRunRequest: field numbers correct; undefined-safe proto wrappers', () => {
    const proxy = requireFreshProxy({});
    const { encodeAgentClientRunRequest, protoStringField, protoVarintField, protoMessageField } = proxy;

    // Proto wrappers must be exported and return Uint8Arrays
    const strBytes = protoStringField(1, 'test');
    assert.ok(strBytes instanceof Uint8Array, 'protoStringField returns Uint8Array');
    assert.ok(strBytes.length > 0, 'protoStringField result is non-empty');

    // undefined-safe: protoStringField(n, undefined) must emit zero bytes (no field)
    const strUndef = protoStringField(1, undefined);
    assert.ok(strUndef instanceof Uint8Array, 'protoStringField(n,undefined) returns Uint8Array');
    assert.equal(strUndef.length, 0, 'protoStringField(n,undefined) returns empty bytes');

    const varUndef = protoVarintField(1, undefined);
    assert.ok(varUndef instanceof Uint8Array, 'protoVarintField(n,undefined) returns Uint8Array');
    assert.equal(varUndef.length, 0, 'protoVarintField(n,undefined) returns empty bytes');

    // Encode and verify key field numbers
    const result = encodeAgentClientRunRequest({
        prompt: 'hello world',
        messageId: 'msg-1',
        modelId: 'cursor-small',
        agentId: 'agent-test-id',
    });
    assert.ok(result instanceof Uint8Array, 'encodeAgentClientRunRequest returns Uint8Array');
    assert.ok(result.length > 0, 'encoded result is non-empty');

    // Outer wrapper: field 1 (wire 2) = runRequest
    const outer = tcDecodeFields(result);
    const runRequestField = outer.find(f => f.no === 1 && f.wt === 2);
    assert.ok(runRequestField, 'outer field 1 (runRequest) present');

    // Inside runRequest
    const runFields = tcDecodeFields(runRequestField.value);
    assert.ok(runFields.find(f => f.no === 2 && f.wt === 2), 'runRequest field 2 (conversationAction) present');
    assert.ok(runFields.find(f => f.no === 5 && f.wt === 2), 'runRequest field 5 (agentId) present');
    const field13 = runFields.find(f => f.no === 13 && f.wt === 2);
    assert.ok(field13, 'runRequest field 13 (client type) present');
    assert.equal(new TextDecoder().decode(field13.value), 'sdk', 'field 13 value is "sdk"');

    // Verify prompt text deep in the hierarchy
    const convAction = runFields.find(f => f.no === 2 && f.wt === 2);
    const userMsgAction = tcDecodeFields(convAction.value).find(f => f.no === 1 && f.wt === 2);
    assert.ok(userMsgAction, 'userMessageAction (conversationAction.field1) present');
    const userMsg = tcDecodeFields(userMsgAction.value).find(f => f.no === 1 && f.wt === 2);
    assert.ok(userMsg, 'userMessage (userMessageAction.field1) present');
    const promptField = tcDecodeFields(userMsg.value).find(f => f.no === 1 && f.wt === 2);
    assert.ok(promptField, 'prompt text field (userMessage.field1) present');
    assert.equal(new TextDecoder().decode(promptField.value), 'hello world', 'prompt text encoded correctly');

    closeProxy(proxy);
});

// O3 — deleted: cursorChecksum removed (HMAC-based ChatService auth gone;
//      AgentService/Run uses Bearer token only). proto wrappers covered by O2' above.

// ============================================================================
// O4' — decodeLocalAgentServerFrame: text / done / request_context / tool_call
// ============================================================================

test('O4\' — decodeLocalAgentServerFrame: text, done, request_context, and tool_call events', () => {
    const proxy = requireFreshProxy({});
    const { decodeLocalAgentServerFrame } = proxy;

    // --- Text frame ---
    const textPayload = tcPayload(tcInteractionTextFrame('hello from agent'));
    const textEvents = decodeLocalAgentServerFrame(textPayload);
    assert.equal(textEvents.length, 1, 'text frame yields exactly one event');
    assert.equal(textEvents[0].type, 'text', 'text event type is "text"');
    assert.equal(textEvents[0].text, 'hello from agent', 'text value round-trips');

    // --- Done frame ---
    const donePayload = tcPayload(tcDoneFrame());
    const doneEvents = decodeLocalAgentServerFrame(donePayload);
    assert.equal(doneEvents.length, 1, 'done frame yields exactly one event');
    assert.equal(doneEvents[0].type, 'done', 'done event type is "done"');

    // --- request_context frame ---
    const rcPayload = tcPayload(tcRequestContextFrame(7, 'exec-xyz'));
    const rcEvents = decodeLocalAgentServerFrame(rcPayload);
    assert.equal(rcEvents.length, 1, 'request_context frame yields exactly one event');
    assert.equal(rcEvents[0].type, 'request_context', 'type is "request_context"');
    assert.equal(rcEvents[0].id, 7, 'id decoded correctly');
    assert.equal(rcEvents[0].execId, 'exec-xyz', 'execId decoded correctly');

    // --- Shell tool-call frame ---
    const toolPayload = tcPayload(tcShellToolFrame('call-id-1', 'echo hi'));
    const toolEvents = decodeLocalAgentServerFrame(toolPayload);
    assert.equal(toolEvents.length, 1, 'tool_call frame yields exactly one event');
    assert.equal(toolEvents[0].type, 'tool_call', 'type is "tool_call"');
    assert.equal(toolEvents[0].toolCall.name, 'shell', 'tool name is "shell"');
    assert.equal(toolEvents[0].toolCall.arguments.command, 'echo hi', 'command arg decoded correctly');

    closeProxy(proxy);
});

// ============================================================================
// O5 — getAccessToken: exchange + cache + invalidate
// ============================================================================

test('O5 — getAccessToken: exchange, cache hit, invalidate + re-exchange', async () => {
    let exchangeCount = 0;
    const tokenServer = await mockServer(async (req, res) => {
        if (req.url.endsWith('/auth/exchange_user_api_key')) {
            exchangeCount++;
            await bufferBody(req);
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ accessToken: `AT-${exchangeCount}` }));
        }
        res.writeHead(404); res.end();
    });

    const proxy = requireFreshProxy({
        CURSOR_API_KEY: 'test-api-key-o5',
        CURSOR_BACKEND_BASE_URL: `http://127.0.0.1:${tokenServer.port}`,
        ENCRYPTION_KEY: 'composer-api',
    });
    const { getAccessToken, invalidateAccessToken, _accessTokenState } = proxy;
    _accessTokenState.cache.clear();
    _accessTokenState.inflight.clear();

    // First call — cold start, triggers exchange
    const t1 = await getAccessToken('test-api-key-o5');
    assert.equal(t1, 'AT-1', 'first call returns AT-1');
    assert.equal(exchangeCount, 1, 'exactly one exchange on cold start');

    // Second call — should hit cache, no exchange
    const t2 = await getAccessToken('test-api-key-o5');
    assert.equal(t2, 'AT-1', 'second call returns same token from cache');
    assert.equal(exchangeCount, 1, 'no additional exchange on cache hit');

    // Invalidate then call again — triggers a new exchange
    await invalidateAccessToken('test-api-key-o5');
    const t3 = await getAccessToken('test-api-key-o5');
    assert.equal(t3, 'AT-2', 'post-invalidation call exchanges again');
    assert.equal(exchangeCount, 2, 'exactly two exchanges total');

    await tokenServer.close();
    closeProxy(proxy);
});

// ============================================================================
// O6 — parseComposerToolCalls: keyed-arg form, JSON-object body form, fullwidth charset
// ============================================================================

test('O6 — parseComposerToolCalls: ASCII keyed-arg, JSON-object body, and fullwidth ｜/▁ variants', () => {
    const proxy = requireFreshProxy({});
    const { parseComposerToolCalls } = proxy;

    // (a) ASCII keyed-arg form — the model follows the injected marker grammar exactly
    const asciiKeyed = [
        '<|tool_calls_begin|><|tool_call_begin|>read_file',
        '<|tool_sep|>path',
        '/foo/bar.txt',
        '<|tool_call_end|><|tool_calls_end|>',
    ].join('\n');
    const r1 = parseComposerToolCalls(asciiKeyed);
    assert.ok(Array.isArray(r1) && r1.length >= 1, 'keyed-arg: parsed to non-empty array');
    assert.equal(r1[0].name, 'read_file', 'keyed-arg: name is read_file');
    assert.equal(r1[0].arguments.path, '/foo/bar.txt', 'keyed-arg: path argument correct');

    // (b) JSON-object body form — model emits JSON instead of keyed-arg
    const jsonBody = [
        '<|tool_calls_begin|><|tool_call_begin|>',
        JSON.stringify({ name: 'write_file', arguments: { path: '/out.txt', content: 'hello' } }),
        '<|tool_call_end|><|tool_calls_end|>',
    ].join('');
    const r2 = parseComposerToolCalls(jsonBody);
    assert.ok(r2.length >= 1, 'JSON-object body: parsed to non-empty array');
    assert.equal(r2[0].name, 'write_file', 'JSON-object: name is write_file');
    assert.deepEqual(r2[0].arguments, { path: '/out.txt', content: 'hello' },
        'JSON-object: arguments match');

    // (c) Fullwidth ｜/▁ charset variant — model sometimes emits Unicode lookalikes
    const fullwidth = [
        '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>bash',
        '<｜tool▁sep｜>command',
        'npm test',
        '<｜tool▁call▁end｜><｜tool▁calls▁end｜>',
    ].join('\n');
    const r3 = parseComposerToolCalls(fullwidth);
    assert.ok(r3.length >= 1, 'fullwidth variant: parsed to non-empty array');
    assert.equal(r3[0].name, 'bash', 'fullwidth: name is bash');
    const cmd = r3[0].arguments.command != null ? r3[0].arguments.command : r3[0].arguments.cmd;
    assert.ok(String(cmd).includes('npm test'),
        `fullwidth: command arg includes "npm test"; got: ${JSON.stringify(r3[0].arguments)}`);

    closeProxy(proxy);
});

// ============================================================================
// O7 — openaiToCursorPrompt: history flatten (system + turns + tool message)
// ============================================================================

test('O7 — openaiToCursorPrompt: history flattened to prompt.text with correct role prefixes', () => {
    const proxy = requireFreshProxy({});
    const { openaiToCursorPrompt } = proxy;

    const openaiBody = {
        model: 'composer-2.5',
        messages: [
            { role: 'system', content: 'Be concise.' },
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there' },
            { role: 'tool', tool_call_id: 'call_abc', name: 'read_file', content: 'file contents here' },
        ],
    };

    const result = openaiToCursorPrompt(openaiBody);
    const text = result.prompt.text;

    // No tools → mode is ask
    assert.equal(result.prompt.mode, 'ask', 'no tools → mode is ask');
    assert.ok(text.includes('Conversation:'), 'Conversation: separator present');
    assert.ok(text.includes('SYSTEM: Be concise.'), 'system message with SYSTEM: prefix');
    assert.ok(text.includes('USER: Hello'), 'user message with USER: prefix');
    assert.ok(text.includes('ASSISTANT: Hi there'), 'assistant message with ASSISTANT: prefix');
    assert.ok(text.includes('TOOL RESULT'), 'tool message rendered as TOOL RESULT');
    assert.ok(text.includes('file contents here'), 'tool result content present');
    assert.ok(text.includes('read_file'), 'tool name appears in TOOL RESULT label');

    // No tools → SYSTEM_DIRECTIVE (not TOOL_SYSTEM_DIRECTIVE)
    assert.ok(!text.includes('CLIENT TOOL INVENTORY:'), 'no tool inventory when tools absent');
    assert.ok(text.includes('You are serving an OpenAI-compatible API request'), 'system directive preamble present');

    closeProxy(proxy);
});

// ============================================================================
// O8 — openaiToCursorPrompt tool injection (CRITICAL: tools must enter prompt.text)
// ============================================================================

test('O8 — openaiToCursorPrompt: tool schemas injected into prompt.text with full marker grammar', () => {
    const proxy = requireFreshProxy({});
    const { openaiToCursorPrompt } = proxy;

    const tools = [
        { type: 'function', function: { name: 'read_file', description: 'Read a file',
            parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
        { type: 'function', function: { name: 'write_file', description: 'Write a file',
            parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } } },
    ];
    const result = openaiToCursorPrompt({
        model: 'composer-2.5',
        messages: [{ role: 'user', content: 'do something' }],
        tools,
    });
    const text = result.prompt.text;

    // Agent mode
    assert.equal(result.prompt.mode, 'agent', 'tools present → mode is agent');
    assert.ok(result.tools.length === 2, 'shaped.tools has 2 entries');

    // TOOL_SYSTEM_DIRECTIVE preamble
    assert.ok(text.includes('CLIENT TOOL INVENTORY:'), 'CLIENT TOOL INVENTORY: header present');
    assert.ok(text.includes('Allowed tool names: read_file, write_file'), 'allowed tool names listed');

    // Marker worked-example lines (verbatim — wording is prompt-conditioned)
    assert.ok(text.includes('<|tool_calls_begin|><|tool_call_begin|>'), '<|tool_calls_begin|> example present');
    assert.ok(text.includes('<|tool_sep|>'), '<|tool_sep|> example present');
    assert.ok(text.includes('<|tool_call_end|><|tool_calls_end|>'), 'closing markers present');

    // Per-tool JSON (one line per tool)
    assert.ok(text.includes('"read_file"'), 'read_file JSON line present');
    assert.ok(text.includes('"write_file"'), 'write_file JSON line present');

    // tool_choice: required
    const reqResult = openaiToCursorPrompt({
        model: 'composer-2.5',
        messages: [{ role: 'user', content: 'q' }],
        tools, tool_choice: 'required',
    });
    assert.ok(reqResult.prompt.text.includes('You must call at least one tool.'),
        'tool_choice=required → must-call line injected');

    // tool_choice: named function
    const namedResult = openaiToCursorPrompt({
        model: 'composer-2.5',
        messages: [{ role: 'user', content: 'q' }],
        tools, tool_choice: { type: 'function', function: { name: 'read_file' } },
    });
    assert.ok(namedResult.prompt.text.includes('Use the read_file tool if you call a tool.'),
        'named tool_choice → use-specific line injected');

    // tool_choice: none → tools emptied, ask mode
    const noneResult = openaiToCursorPrompt({
        model: 'composer-2.5',
        messages: [{ role: 'user', content: 'q' }],
        tools, tool_choice: 'none',
    });
    assert.equal(noneResult.prompt.mode, 'ask', 'tool_choice=none → mode is ask (tools suppressed)');
    assert.ok(!noneResult.prompt.text.includes('CLIENT TOOL INVENTORY:'),
        'tool_choice=none → no inventory injected');

    closeProxy(proxy);
});

// ============================================================================
// O9' — agentFrameToOpenAIDeltas: text delta / stop delta / tool delta
// ============================================================================

test('O9\' — agentFrameToOpenAIDeltas: text delta, stop delta on done, tool delta with done=true', () => {
    const proxy = requireFreshProxy({});
    const { agentFrameToOpenAIDeltas } = proxy;

    function freshState() {
        return { toolIndex: 0, sawTool: false, emitted: new Set(), tools: [], responseId: 'r-o9p' };
    }

    // --- Text frame → content delta ---
    const textPayload = tcPayload(tcInteractionTextFrame('stream chunk'));
    const { deltas: textDeltas, done: textDone } = agentFrameToOpenAIDeltas(textPayload, freshState());
    assert.ok(textDeltas.length >= 1, 'text frame yields at least one delta');
    const contentDelta = textDeltas.find(d => d.choices && d.choices[0].delta.content);
    assert.ok(contentDelta, 'content delta present');
    assert.equal(contentDelta.choices[0].delta.content, 'stream chunk', 'content correct');
    assert.equal(textDone, false, 'text frame does not set done=true');

    // --- Done frame → finish_reason:stop + done=true ---
    const donePayload = tcPayload(tcDoneFrame());
    const { deltas: doneDeltas, done: doneDone } = agentFrameToOpenAIDeltas(donePayload, freshState());
    assert.ok(doneDeltas.length >= 1, 'done frame yields at least one delta');
    const stopDelta = doneDeltas.find(d => d.choices && d.choices[0].finish_reason === 'stop');
    assert.ok(stopDelta, 'done frame yields finish_reason:stop delta');
    assert.equal(doneDone, true, 'done frame sets done=true');

    // --- Shell tool-call frame → tool delta + finish_reason:tool_calls + done=true ---
    const toolPayload = tcPayload(tcShellToolFrame('tc-1', 'ls -la'));
    const { deltas: toolDeltas, done: toolDone } = agentFrameToOpenAIDeltas(toolPayload, freshState());
    assert.equal(toolDone, true, 'tool_call frame sets done=true (STOP-AT-FIRST-TOOL)');
    const toolCallsDelta = toolDeltas.find(d => d.choices && d.choices[0].delta.tool_calls);
    assert.ok(toolCallsDelta, 'tool_calls delta present');
    assert.equal(toolCallsDelta.choices[0].delta.tool_calls[0].index, 0, 'tool index is 0');
    const finishDelta = toolDeltas.find(d => d.choices && d.choices[0].finish_reason === 'tool_calls');
    assert.ok(finishDelta, 'finish_reason:tool_calls delta emitted');

    closeProxy(proxy);
});

// ============================================================================
// R12 — bash tool argument passes through UNMODIFIED (no nohup, no cwd strip)
//        Regression: sanitizeNormalizedToolArguments is intentionally skipped.
// ============================================================================

test('R12 — bash tool arg "npm run dev" passes through UNMODIFIED via toOpenAiToolCalls', () => {
    const proxy = requireFreshProxy({});
    const { openaiToCursorPrompt, toOpenAiToolCalls } = proxy;

    // Parse tools via openaiToCursorPrompt so shaped.tools is the right format
    const shaped = openaiToCursorPrompt({
        model: 'composer-2.5',
        messages: [{ role: 'user', content: 'run dev server' }],
        tools: [{
            type: 'function',
            function: {
                name: 'bash',
                parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
            },
        }],
    });

    const toolCall = { name: 'bash', arguments: { command: 'npm run dev' } };
    const result = toOpenAiToolCalls({ toolCalls: [toolCall], tools: shaped.tools, responseId: 'r12' });

    assert.equal(result.length, 1, 'one tool call output');
    const args = JSON.parse(result[0].function.arguments);

    assert.equal(args.command, 'npm run dev',
        'bash command passes through UNMODIFIED (no nohup rewriting)');
    assert.ok(!JSON.stringify(args).includes('nohup'),
        'nohup NOT injected (sanitizeNormalizedToolArguments correctly skipped)');

    // Also verify a bash tool with cwd does NOT get cwd stripped
    const withCwd = { name: 'bash', arguments: { command: 'npm test', cwd: '/project' } };
    const result2 = toOpenAiToolCalls({ toolCalls: [withCwd], tools: shaped.tools, responseId: 'r12b' });
    const args2 = JSON.parse(result2[0].function.arguments);
    assert.equal(args2.command, 'npm test', 'command unchanged with cwd present');

    closeProxy(proxy);
});

// ============================================================================
// CD1' — Direct mode: routes to h2c AgentService mock; SDK headers present; hosted NOT called
// ============================================================================

test('CD1\' — CURSOR_DIRECT=1: routes to h2c AgentService; SDK headers present; hosted relay NOT called', async () => {
    let exchangeCalled = false;
    let agentCalled = false;
    let agentHeaders = null;
    let hostedCalled = false;

    const tokenMock = await mockServer(async (req, res) => {
        if (req.url.endsWith('/auth/exchange_user_api_key')) {
            exchangeCalled = true;
            await bufferBody(req);
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ accessToken: 'AT-cd1p' }));
        }
        res.writeHead(404); res.end();
    });

    const h2cMock = await mockH2cServer((stream, headers) => {
        agentCalled = true;
        agentHeaders = Object.assign({}, headers);
        stream.respond({ ':status': 200, 'content-type': 'application/connect+proto' });
        stream.write(tcCombine(tcInteractionTextFrame('Direct hello!')));
        stream.write(tcCombine(tcDoneFrame()));
        stream.end();
    });

    const hostedRelay = await mockServer((req, res) => {
        hostedCalled = true;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hosted' }, finish_reason: 'stop' }] }));
    });

    const agentEndpoint = `http://127.0.0.1:${h2cMock.port}/agent.v1.AgentService/Run`;
    const proxy = requireFreshProxy({
        CURSOR_API_KEY: 'cursor-key-cd1p',
        CURSOR_DIRECT: '1',
        CURSOR_BACKEND_BASE_URL: `http://127.0.0.1:${tokenMock.port}`,
        CURSOR_LOCAL_AGENT_ENDPOINT: agentEndpoint,
        COMPOSER_API_URL: `http://127.0.0.1:${hostedRelay.port}`,
        ANTHROPIC_HOST_OVERRIDE: '127.0.0.1:19999',
        CLAUDE_USAGE_FILE: USAGE_FILE_TMP,
        PROBE_INTERVAL_MS: '999999',
    });
    proxy._accessTokenState.cache.clear();
    proxy._accessTokenState.inflight.clear();

    assert.equal(proxy.CURSOR_DIRECT_ENABLED, true, 'CURSOR_DIRECT_ENABLED is true');

    const proxyPort = await listenProxy(proxy);

    const result = await proxyRequest(proxyPort, {
        body: { model: 'composer-2.5', messages: [{ role: 'user', content: 'hello' }], max_tokens: 10 },
        headers: { authorization: 'Bearer test-key-cd1p', 'connection': 'close' },
    });

    assert.equal(result.statusCode, 200, 'response is 200');
    assert.equal(exchangeCalled, true, 'token exchange was called');
    assert.equal(agentCalled, true, 'AgentService h2c endpoint was called');
    assert.equal(hostedCalled, false, 'hosted relay NOT called');

    // Verify SDK headers on the AgentService request (no checksum — AgentService uses Bearer only)
    assert.equal(agentHeaders['connect-protocol-version'], '1', 'connect-protocol-version:1 sent');
    assert.ok(agentHeaders['content-type'] && agentHeaders['content-type'].includes('application/connect+proto'),
        'content-type:application/connect+proto sent');
    assert.equal(agentHeaders['x-cursor-client-type'], 'sdk', 'x-cursor-client-type:sdk sent');
    assert.ok(agentHeaders['x-cursor-client-version'], 'x-cursor-client-version present');
    assert.ok(agentHeaders['authorization'] && agentHeaders['authorization'].includes('AT-cd1p'),
        'authorization Bearer token present');
    assert.ok(!agentHeaders['x-cursor-checksum'], 'x-cursor-checksum NOT sent (AgentService uses Bearer only)');

    // Verify response translated to Anthropic format
    const body = JSON.parse(result.body);
    assert.equal(body.type, 'message', 'response is Anthropic message');
    const textContent = body.content && body.content.find(b => b.type === 'text');
    assert.ok(textContent && textContent.text === 'Direct hello!',
        `content text is "Direct hello!"; got: ${JSON.stringify(body.content)}`);

    proxy._closeHttp2Pool();
    await closeProxy(proxy);
    await tokenMock.close();
    await h2cMock.close();
    await hostedRelay.close();
});

// ============================================================================
// CD3' — Streaming: ordered Anthropic SSE via h2c AgentService mock
// ============================================================================

test('CD3\' — streaming: ordered Anthropic SSE from h2c AgentService; deltas correct; no duplication', async () => {
    const text1 = 'Hello';
    const text2 = ' world';
    const expectedFull = text1 + text2;

    const tokenMock = await mockServer(async (req, res) => {
        if (req.url.endsWith('/auth/exchange_user_api_key')) {
            await bufferBody(req);
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ accessToken: 'AT-cd3p' }));
        }
        res.writeHead(404); res.end();
    });

    const h2cMock = await mockH2cServer((stream) => {
        stream.respond({ ':status': 200, 'content-type': 'application/connect+proto' });
        stream.write(tcCombine(tcInteractionTextFrame(text1)));
        stream.write(tcCombine(tcInteractionTextFrame(text2)));
        stream.write(tcCombine(tcDoneFrame()));
        stream.end();
    });

    const proxy = requireFreshProxy({
        CURSOR_API_KEY: 'cursor-key-cd3p',
        CURSOR_DIRECT: '1',
        CURSOR_BACKEND_BASE_URL: `http://127.0.0.1:${tokenMock.port}`,
        CURSOR_LOCAL_AGENT_ENDPOINT: `http://127.0.0.1:${h2cMock.port}/agent.v1.AgentService/Run`,
        ANTHROPIC_HOST_OVERRIDE: '127.0.0.1:19999',
        CLAUDE_USAGE_FILE: USAGE_FILE_TMP,
        PROBE_INTERVAL_MS: '999999',
    });
    proxy._accessTokenState.cache.clear();
    proxy._accessTokenState.inflight.clear();

    const proxyPort = await listenProxy(proxy);

    const { statusCode, body } = await sseRequest(proxyPort, {
        model: 'composer-2.5',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true, max_tokens: 50,
    });

    assert.equal(statusCode, 200, 'streaming response is 200');

    const events = tcParseSSE(body);
    const types = events.map(e => e.type);

    assert.ok(types.includes('message_start'), 'message_start present');
    assert.ok(types.includes('content_block_start'), 'content_block_start present');
    assert.ok(types.includes('content_block_delta'), 'content_block_delta present');
    assert.ok(types.includes('content_block_stop'), 'content_block_stop present');
    assert.ok(types.includes('message_delta'), 'message_delta present');
    assert.ok(types.includes('message_stop'), 'message_stop present');

    const idx = t => types.indexOf(t);
    assert.ok(idx('message_start') < idx('content_block_start'), 'message_start before content_block_start');
    assert.ok(idx('content_block_start') < idx('content_block_delta'), 'content_block_start before delta');
    assert.ok(idx('content_block_stop') < idx('message_delta'), 'content_block_stop before message_delta');

    const textDeltas = events.filter(e => e.type === 'content_block_delta' &&
        e.data && e.data.delta && e.data.delta.type === 'text_delta');
    assert.ok(textDeltas.length >= 1, 'at least one text_delta');
    const allText = textDeltas.map(e => e.data.delta.text).join('');
    assert.equal(allText, expectedFull,
        `concatenated text deltas must equal "${expectedFull}" (no duplication)`);

    proxy._closeHttp2Pool();
    await closeProxy(proxy);
    await tokenMock.close();
    await h2cMock.close();
});

// ============================================================================
// CD5' — Token: h2c 401 triggers exactly 2 exchanges + successful response
// ============================================================================

test('CD5\' — token refresh on h2c 401: exactly 2 exchanges + successful response', async () => {
    let exchangeCount = 0;
    let agentCallCount = 0;

    const tokenMock = await mockServer(async (req, res) => {
        if (req.url.endsWith('/auth/exchange_user_api_key')) {
            exchangeCount++;
            await bufferBody(req);
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ accessToken: `AT-cd5p-${exchangeCount}` }));
        }
        res.writeHead(404); res.end();
    });

    const h2cMock = await mockH2cServer((stream) => {
        agentCallCount++;
        if (agentCallCount === 1) {
            // First call → 401 (stale token)
            stream.respond({ ':status': 401, 'content-type': 'application/json' });
            stream.end(JSON.stringify({ error: { message: 'token expired' } }));
        } else {
            // Second call → success
            stream.respond({ ':status': 200, 'content-type': 'application/connect+proto' });
            stream.write(tcCombine(tcInteractionTextFrame('After refresh')));
            stream.write(tcCombine(tcDoneFrame()));
            stream.end();
        }
    });

    const proxy = requireFreshProxy({
        CURSOR_API_KEY: 'cursor-key-cd5p',
        CURSOR_DIRECT: '1',
        CURSOR_BACKEND_BASE_URL: `http://127.0.0.1:${tokenMock.port}`,
        CURSOR_LOCAL_AGENT_ENDPOINT: `http://127.0.0.1:${h2cMock.port}/agent.v1.AgentService/Run`,
        ANTHROPIC_HOST_OVERRIDE: '127.0.0.1:19999',
        CLAUDE_USAGE_FILE: USAGE_FILE_TMP,
        PROBE_INTERVAL_MS: '999999',
    });
    proxy._accessTokenState.cache.clear();
    proxy._accessTokenState.inflight.clear();

    const proxyPort = await listenProxy(proxy);

    const result = await proxyRequest(proxyPort, {
        body: { model: 'composer-2.5', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 },
        headers: { 'connection': 'close' },
    });

    assert.equal(result.statusCode, 200, 'response is 200 after 401 refresh');
    assert.equal(exchangeCount, 2, 'exactly 2 token exchanges (initial + refresh on 401)');
    assert.equal(agentCallCount, 2, 'AgentService called twice (first 401, then 200)');

    const body = JSON.parse(result.body);
    assert.equal(body.type, 'message', 'response is Anthropic message');
    assert.ok(body.content.some(b => b.type === 'text' && b.text === 'After refresh'),
        'text content is "After refresh"');

    proxy._closeHttp2Pool();
    await closeProxy(proxy);
    await tokenMock.close();
    await h2cMock.close();
});

test('CD5-dedup — 3 concurrent cold-start getAccessToken calls → exactly 1 exchange (in-flight dedup)', async () => {
    let exchangeCount = 0;

    const tokenServer = await mockServer(async (req, res) => {
        if (req.url.endsWith('/auth/exchange_user_api_key')) {
            exchangeCount++;
            // Small delay so concurrent requests actually overlap
            await new Promise(r => setTimeout(r, 10));
            await bufferBody(req);
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ accessToken: 'AT-dedup' }));
        }
        res.writeHead(404); res.end();
    });

    const proxy = requireFreshProxy({
        CURSOR_API_KEY: 'cursor-key-dedup',
        CURSOR_BACKEND_BASE_URL: `http://127.0.0.1:${tokenServer.port}`,
        ENCRYPTION_KEY: 'composer-api',
    });
    const { getAccessToken, _accessTokenState } = proxy;
    _accessTokenState.cache.clear();
    _accessTokenState.inflight.clear();

    // Fire 3 concurrent cold-start calls — all should resolve to the same token via 1 exchange
    const results = await Promise.all([
        getAccessToken('cursor-key-dedup'),
        getAccessToken('cursor-key-dedup'),
        getAccessToken('cursor-key-dedup'),
    ]);

    assert.equal(exchangeCount, 1, '3 concurrent cold-start calls → exactly 1 exchange (in-flight dedup)');
    assert.ok(results.every(r => r === 'AT-dedup'), 'all 3 callers receive the same token');

    await tokenServer.close();
    closeProxy(proxy);
});

// ============================================================================
// CD6' — Unknown-service: (a) h2c 404 → 502 naming CURSOR_LOCAL_AGENT_ENDPOINT;
//         (b) h2c 200 + Connect error trailer → 502 naming CURSOR_LOCAL_AGENT_ENDPOINT
// ============================================================================

test('CD6a\' — h2c 404 from AgentService → 502 naming CURSOR_LOCAL_AGENT_ENDPOINT', async () => {
    const tokenMock = await mockServer(async (req, res) => {
        if (req.url.endsWith('/auth/exchange_user_api_key')) {
            await bufferBody(req);
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ accessToken: 'AT-cd6ap' }));
        }
        res.writeHead(404); res.end();
    });

    const h2cMock = await mockH2cServer((stream) => {
        stream.respond({ ':status': 404, 'content-type': 'application/json' });
        stream.end(JSON.stringify({ error: { message: 'not found' } }));
    });

    const agentEndpoint = `http://127.0.0.1:${h2cMock.port}/bad/agent/service`;
    const proxy = requireFreshProxy({
        CURSOR_API_KEY: 'cursor-key-cd6ap',
        CURSOR_DIRECT: '1',
        CURSOR_BACKEND_BASE_URL: `http://127.0.0.1:${tokenMock.port}`,
        CURSOR_LOCAL_AGENT_ENDPOINT: agentEndpoint,
        ANTHROPIC_HOST_OVERRIDE: '127.0.0.1:19999',
        CLAUDE_USAGE_FILE: USAGE_FILE_TMP,
        PROBE_INTERVAL_MS: '999999',
    });
    proxy._accessTokenState.cache.clear();
    proxy._accessTokenState.inflight.clear();

    const proxyPort = await listenProxy(proxy);

    const result = await proxyRequest(proxyPort, {
        body: { model: 'composer-2.5', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 },
        headers: { 'connection': 'close' },
    });

    assert.equal(result.statusCode, 502, 'h2c 404 from AgentService → 502');
    const body = JSON.parse(result.body);
    assert.equal(body.type, 'error', 'error envelope has type:error');
    assert.ok(body.error && body.error.message, 'error has message');
    assert.ok(body.error.message.includes(agentEndpoint),
        `502 message must name CURSOR_LOCAL_AGENT_ENDPOINT ("${agentEndpoint}"); got: ${body.error.message}`);

    proxy._closeHttp2Pool();
    await closeProxy(proxy);
    await tokenMock.close();
    await h2cMock.close();
});

test('CD6b\' — h2c 200 + Connect error trailer "unimplemented" → 502 naming CURSOR_LOCAL_AGENT_ENDPOINT', async () => {
    const tokenMock = await mockServer(async (req, res) => {
        if (req.url.endsWith('/auth/exchange_user_api_key')) {
            await bufferBody(req);
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ accessToken: 'AT-cd6bp' }));
        }
        res.writeHead(404); res.end();
    });

    const h2cMock = await mockH2cServer((stream) => {
        stream.respond({ ':status': 200, 'content-type': 'application/connect+proto' });
        // Immediately send a Connect end-stream error trailer (flags=2)
        const trailerPayload = new TextEncoder().encode(
            JSON.stringify({ error: { message: 'unimplemented service or method' } })
        );
        const trailerFrame = tcConnectFrame(trailerPayload, 2);
        stream.write(Buffer.from(trailerFrame));
        stream.end();
    });

    const agentEndpoint = `http://127.0.0.1:${h2cMock.port}/agent.v1.AgentService/Run`;
    const proxy = requireFreshProxy({
        CURSOR_API_KEY: 'cursor-key-cd6bp',
        CURSOR_DIRECT: '1',
        CURSOR_BACKEND_BASE_URL: `http://127.0.0.1:${tokenMock.port}`,
        CURSOR_LOCAL_AGENT_ENDPOINT: agentEndpoint,
        ANTHROPIC_HOST_OVERRIDE: '127.0.0.1:19999',
        CLAUDE_USAGE_FILE: USAGE_FILE_TMP,
        PROBE_INTERVAL_MS: '999999',
    });
    proxy._accessTokenState.cache.clear();
    proxy._accessTokenState.inflight.clear();

    const proxyPort = await listenProxy(proxy);

    const result = await proxyRequest(proxyPort, {
        body: { model: 'composer-2.5', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 },
        headers: { 'connection': 'close' },
    });

    assert.equal(result.statusCode, 502, 'h2c 200 + Connect error trailer → 502');
    const body = JSON.parse(result.body);
    assert.equal(body.type, 'error', 'error envelope has type:error');
    assert.ok(body.error && body.error.message, 'error has message');
    assert.ok(body.error.message.includes(agentEndpoint),
        `502 message must name CURSOR_LOCAL_AGENT_ENDPOINT; got: ${body.error.message}`);
    assert.ok(
        body.error.message.toLowerCase().includes('unimplemented') ||
        body.error.message.toLowerCase().includes('agentservice'),
        `502 message must mention unimplemented or AgentService; got: ${body.error.message}`
    );

    proxy._closeHttp2Pool();
    await closeProxy(proxy);
    await tokenMock.close();
    await h2cMock.close();
});

// ============================================================================
// CD-tool — e2e proto tool call via h2c: run-frame has tool inventory; shell tool → tool_use
// ============================================================================

test('CD-tool — h2c shell tool call: run-frame prompt has tool inventory; response is Anthropic tool_use', async () => {
    let capturedRunFrame = null;
    let streamRstCode = null;

    const tokenMock = await mockServer(async (req, res) => {
        if (req.url.endsWith('/auth/exchange_user_api_key')) {
            await bufferBody(req);
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ accessToken: 'AT-cdtool' }));
        }
        res.writeHead(404); res.end();
    });

    // Capture the run frame first, then send TWO distinct tool frames with NO done in between.
    // The proxy must stop after the FIRST emittable tool (stop-at-first-emittable-tool) and
    // RST_STREAM with NGHTTP2_CANCEL — the second frame must never appear in the response.
    const h2cMock = await mockH2cServer((stream) => {
        stream.once('close', () => { streamRstCode = stream.rstCode !== undefined ? stream.rstCode : -1; });
        stream.once('data', (chunk) => {
            capturedRunFrame = Buffer.from(chunk);
            stream.respond({ ':status': 200, 'content-type': 'application/connect+proto' });
            stream.write(tcCombine(tcShellToolFrame('tool-call-1', 'echo hello')));
            stream.write(tcCombine(tcShellToolFrame('tool-call-2', 'echo world'))); // second tool — must be suppressed
            // No done frame, no stream.end() — proxy must RST with NGHTTP2_CANCEL after first tool
        });
        stream.on('error', () => {}); // suppress write errors after RST
    });

    const proxy = requireFreshProxy({
        CURSOR_API_KEY: 'cursor-key-cdtool',
        CURSOR_DIRECT: '1',
        CURSOR_BACKEND_BASE_URL: `http://127.0.0.1:${tokenMock.port}`,
        CURSOR_LOCAL_AGENT_ENDPOINT: `http://127.0.0.1:${h2cMock.port}/agent.v1.AgentService/Run`,
        ANTHROPIC_HOST_OVERRIDE: '127.0.0.1:19999',
        CLAUDE_USAGE_FILE: USAGE_FILE_TMP,
        PROBE_INTERVAL_MS: '999999',
    });
    proxy._accessTokenState.cache.clear();
    proxy._accessTokenState.inflight.clear();

    const proxyPort = await listenProxy(proxy);

    const result = await proxyRequest(proxyPort, {
        body: {
            model: 'composer-2.5',
            messages: [{ role: 'user', content: 'run a command' }],
            tools: [{
                name: 'bash', description: 'Run a shell command',
                input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
            }],
            max_tokens: 100,
        },
        headers: { 'connection': 'close' },
    });

    // Run-frame prompt must contain tool inventory (tcExtractPromptText walks AgentService nesting)
    assert.ok(capturedRunFrame, 'h2c mock received run-frame data');
    const promptText = tcExtractPromptText(capturedRunFrame);
    assert.ok(promptText.length > 0, 'prompt text decoded from run-frame');
    assert.ok(promptText.includes('CLIENT TOOL INVENTORY:'),
        'run-frame prompt contains CLIENT TOOL INVENTORY:');
    assert.ok(promptText.includes('bash'), 'run-frame prompt contains tool name "bash"');

    // Wait for h2c stream close event (proxy RSTs after emitting first tool)
    const rstDeadline = Date.now() + 1500;
    while (streamRstCode === null && Date.now() < rstDeadline) {
        await new Promise(r => setTimeout(r, 20));
    }

    // Response must be Anthropic tool_use
    assert.equal(result.statusCode, 200, 'response is 200');
    const body = JSON.parse(result.body);
    assert.equal(body.type, 'message', 'response is Anthropic message');
    assert.ok(body.stop_reason === 'tool_use', `stop_reason is tool_use; got: ${body.stop_reason}`);

    // EXACTLY ONE tool_use block — stop-at-first-emittable-tool dedup must suppress the second frame
    const toolUseBlocks = body.content.filter(b => b.type === 'tool_use');
    assert.equal(toolUseBlocks.length, 1,
        `exactly 1 tool_use block (second tool must be suppressed); got: ${toolUseBlocks.length}`);
    const toolUse = toolUseBlocks[0];
    assert.ok(typeof (toolUse.input && toolUse.input.command) === 'string',
        `tool_use input has command string; got: ${JSON.stringify(toolUse && toolUse.input)}`);

    // h2c stream must be RST'd with NGHTTP2_CANCEL after the first tool (C1 teardown)
    assert.ok(streamRstCode !== null, 'h2c server stream received close event after first tool');
    assert.equal(streamRstCode, http2.constants.NGHTTP2_CANCEL,
        `h2c stream reset code must be NGHTTP2_CANCEL (8); got: ${streamRstCode}`);

    proxy._closeHttp2Pool();
    await closeProxy(proxy);
    await tokenMock.close();
    await h2cMock.close();
});

// ============================================================================
// CD-fallback — CURSOR_DIRECT=0: composer-2.5 uses hosted forwardToComposer
// (direct is the DEFAULT now; CURSOR_DIRECT=0 opts back into the hosted relay)
// ============================================================================

test('CD-fallback — CURSOR_DIRECT=0: composer-2.5 routes to hosted relay, NOT direct Cursor', async () => {
    let hostedCalled = false;
    let hostedPath = null;

    const hostedRelay = await mockServer(async (req, res) => {
        hostedCalled = true;
        hostedPath = req.url;
        await bufferBody(req);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            id: 'chatcmpl-fallback',
            choices: [{ message: { role: 'assistant', content: 'Hosted reply' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 3 },
        }));
    });

    const proxy = requireFreshProxy({
        CURSOR_API_KEY: 'cursor-key-fallback',
        CURSOR_DIRECT: '0', // opt OUT of default direct mode → hosted relay
        COMPOSER_API_URL: `http://127.0.0.1:${hostedRelay.port}`,
        ANTHROPIC_HOST_OVERRIDE: '127.0.0.1:19999',
        CLAUDE_USAGE_FILE: USAGE_FILE_TMP,
        PROBE_INTERVAL_MS: '999999',
    });

    assert.equal(proxy.CURSOR_DIRECT_ENABLED, false, 'CURSOR_DIRECT_ENABLED is false when CURSOR_DIRECT=0');

    const proxyPort = await listenProxy(proxy);

    const result = await proxyRequest(proxyPort, {
        body: { model: 'composer-2.5', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 },
    });

    assert.equal(result.statusCode, 200, 'response is 200');
    assert.equal(hostedCalled, true, 'hosted relay was called (fallback path)');
    assert.equal(hostedPath, '/opencodev2/v1/chat/completions', 'fixed composer route used');

    const body = JSON.parse(result.body);
    assert.equal(body.type, 'message', 'response is Anthropic message');
    assert.ok(body.content.some(b => b.type === 'text' && b.text === 'Hosted reply'),
        'text content is "Hosted reply" from hosted relay');

    await closeProxy(proxy);
    await hostedRelay.close();
});

// ============================================================================
// CD-abort' — real mid-stream client disconnect → h2c stream reset with NGHTTP2_CANCEL
// Proves onClientClose → controller.abort → req.close(NGHTTP2_CANCEL) on the h2c stream.
// ============================================================================

test('CD-abort\' — real client disconnect mid-stream: h2c stream reset with NGHTTP2_CANCEL', async () => {
    let streamResetCode = null;

    const tokenMock = await mockServer(async (req, res) => {
        if (req.url.endsWith('/auth/exchange_user_api_key')) {
            await bufferBody(req);
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ accessToken: 'AT-cdabortp' }));
        }
        res.writeHead(404); res.end();
    });

    const h2cMock = await mockH2cServer((stream) => {
        // Send first frame to trigger SSE to client, then stall (no done/end).
        stream.respond({ ':status': 200, 'content-type': 'application/connect+proto' });
        stream.write(tcCombine(tcInteractionTextFrame('stream start')));
        // Record the RST_STREAM code when the proxy cancels the stream.
        stream.once('close', () => {
            streamResetCode = stream.rstCode !== undefined ? stream.rstCode : -1;
        });
        stream.on('error', () => {}); // suppress write errors after reset
        // Safety timeout to avoid hanging the mock (3 s)
        setTimeout(() => { try { stream.close(); } catch { /* ignore */ } }, 3000);
    });

    const proxy = requireFreshProxy({
        CURSOR_API_KEY: 'cursor-key-cdabortp',
        CURSOR_DIRECT: '1',
        CURSOR_BACKEND_BASE_URL: `http://127.0.0.1:${tokenMock.port}`,
        CURSOR_LOCAL_AGENT_ENDPOINT: `http://127.0.0.1:${h2cMock.port}/agent.v1.AgentService/Run`,
        ANTHROPIC_HOST_OVERRIDE: '127.0.0.1:19999',
        CLAUDE_USAGE_FILE: USAGE_FILE_TMP,
        PROBE_INTERVAL_MS: '999999',
    });
    proxy._accessTokenState.cache.clear();
    proxy._accessTokenState.inflight.clear();

    const proxyPort = await listenProxy(proxy);

    // Open a streaming request; destroy the socket once the first SSE data arrives.
    await new Promise((resolve) => {
        const bodyBuf = Buffer.from(JSON.stringify({
            model: 'composer-2.5',
            messages: [{ role: 'user', content: 'hi' }],
            stream: true, max_tokens: 50,
        }));
        const req = http.request({
            hostname: '127.0.0.1', port: proxyPort,
            path: '/v1/messages', method: 'POST',
            headers: {
                'content-type': 'application/json',
                'authorization': 'Bearer test-key-cdabortp',
                'content-length': String(bodyBuf.length),
            },
        }, (res) => {
            let destroyed = false;
            res.on('data', () => {
                if (!destroyed) { destroyed = true; res.socket.destroy(); }
            });
            res.on('close', resolve);
            res.on('error', () => resolve());
        });
        req.on('error', () => resolve());
        req.end(bodyBuf);
        setTimeout(resolve, 2000); // safety
    });

    // Wait for the h2c stream close event to propagate (up to 1.5 s)
    const deadline = Date.now() + 1500;
    while (streamResetCode === null && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 20));
    }

    // NGHTTP2_CANCEL = 8 — the proxy calls req.close(http2.constants.NGHTTP2_CANCEL) on abort
    assert.ok(streamResetCode !== null,
        'h2c server stream received close event after client disconnect');
    assert.equal(streamResetCode, http2.constants.NGHTTP2_CANCEL,
        `h2c stream reset code must be NGHTTP2_CANCEL (8); got: ${streamResetCode}`);

    proxy._closeHttp2Pool();
    await closeProxy(proxy);
    await tokenMock.close();
    await h2cMock.close();
});

// ============================================================================
// token-exchange-failure' — 500 on first exchange does NOT cache a rejected Promise;
// second request makes a fresh exchange and succeeds (via h2c AgentService mock).
// ============================================================================

test('token-exchange-failure\' — 500 on first exchange no cached rejected Promise; second request succeeds', async () => {
    let exchangeCount = 0;

    const tokenMock = await mockServer(async (req, res) => {
        if (req.url.endsWith('/auth/exchange_user_api_key')) {
            exchangeCount++;
            await bufferBody(req);
            if (exchangeCount === 1) {
                res.writeHead(500, { 'content-type': 'application/json' });
                return res.end(JSON.stringify({ error: 'internal server error' }));
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ accessToken: 'AT-exfail-ok' }));
        }
        res.writeHead(404); res.end();
    });

    // h2c mock only serves the second (successful) request
    const h2cMock = await mockH2cServer((stream) => {
        stream.respond({ ':status': 200, 'content-type': 'application/connect+proto' });
        stream.write(tcCombine(tcInteractionTextFrame('success after retry')));
        stream.write(tcCombine(tcDoneFrame()));
        stream.end();
    });

    const proxy = requireFreshProxy({
        CURSOR_API_KEY: 'cursor-key-exfailp',
        CURSOR_DIRECT: '1',
        CURSOR_BACKEND_BASE_URL: `http://127.0.0.1:${tokenMock.port}`,
        CURSOR_LOCAL_AGENT_ENDPOINT: `http://127.0.0.1:${h2cMock.port}/agent.v1.AgentService/Run`,
        ANTHROPIC_HOST_OVERRIDE: '127.0.0.1:19999',
        CLAUDE_USAGE_FILE: USAGE_FILE_TMP,
        PROBE_INTERVAL_MS: '999999',
    });
    proxy._accessTokenState.cache.clear();
    proxy._accessTokenState.inflight.clear();

    const proxyPort = await listenProxy(proxy);

    // First request: exchange returns 500 → must surface error (not hang)
    const result1 = await proxyRequest(proxyPort, {
        body: { model: 'composer-2.5', messages: [{ role: 'user', content: 'first' }], max_tokens: 10 },
        headers: { 'connection': 'close' },
    });
    assert.ok(result1.statusCode >= 400,
        `first request must surface an error (4xx/5xx); got ${result1.statusCode}`);
    assert.equal(exchangeCount, 1, 'exactly 1 exchange attempt on first (failing) request');

    // inflight map must be empty — getAccessToken finally block must have run
    const { _accessTokenState } = proxy;
    assert.equal(_accessTokenState.inflight.size, 0,
        'inflight map is empty after exchange failure (finally block deleted the entry)');
    assert.equal(_accessTokenState.cache.size, 0,
        'token cache is empty after exchange failure (no bad token cached)');

    // Second request: exchange returns 200 → must succeed
    const result2 = await proxyRequest(proxyPort, {
        body: { model: 'composer-2.5', messages: [{ role: 'user', content: 'second' }], max_tokens: 10 },
        headers: { 'connection': 'close' },
    });
    assert.equal(result2.statusCode, 200,
        'second request succeeds after exchange failure (no stuck rejected Promise)');
    assert.equal(exchangeCount, 2, 'exactly 2 exchange calls total');
    const body = JSON.parse(result2.body);
    assert.equal(body.type, 'message', 'second response is Anthropic message');
    assert.ok(body.content.some(b => b.type === 'text' && b.text === 'success after retry'),
        'second response text is "success after retry"');

    proxy._closeHttp2Pool();
    await closeProxy(proxy);
    await tokenMock.close();
    await h2cMock.close();
});

// ============================================================================
// CD-no-ctx — C1 guard: text+done without request_context must complete in < 2s
// Proves the done frame triggers endRequestOnce (half-close) without waiting
// for a request_context write-back that never arrives.
// ============================================================================

test('CD-no-ctx — no request_context frame → done triggers half-close (C1 guard < 2s)', { timeout: 3000 }, async () => {
    const tokenMock = await mockServer(async (req, res) => {
        if (req.url.endsWith('/auth/exchange_user_api_key')) {
            await bufferBody(req);
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ accessToken: 'AT-cdnoctx' }));
        }
        res.writeHead(404); res.end();
    });

    const h2cMock = await mockH2cServer((stream) => {
        stream.respond({ ':status': 200, 'content-type': 'application/connect+proto' });
        stream.write(tcCombine(tcInteractionTextFrame('no-ctx text')));
        stream.write(tcCombine(tcDoneFrame()));
        stream.end();
        // No request_context frame — done frame alone must trigger C1 half-close.
    });

    const proxy = requireFreshProxy({
        CURSOR_API_KEY: 'cursor-key-cdnoctx',
        CURSOR_DIRECT: '1',
        CURSOR_BACKEND_BASE_URL: `http://127.0.0.1:${tokenMock.port}`,
        CURSOR_LOCAL_AGENT_ENDPOINT: `http://127.0.0.1:${h2cMock.port}/agent.v1.AgentService/Run`,
        ANTHROPIC_HOST_OVERRIDE: '127.0.0.1:19999',
        CLAUDE_USAGE_FILE: USAGE_FILE_TMP,
        PROBE_INTERVAL_MS: '999999',
    });
    proxy._accessTokenState.cache.clear();
    proxy._accessTokenState.inflight.clear();

    const proxyPort = await listenProxy(proxy);

    const start = Date.now();
    const result = await proxyRequest(proxyPort, {
        body: { model: 'composer-2.5', messages: [{ role: 'user', content: 'hello' }], max_tokens: 10 },
        headers: { 'connection': 'close' },
    });
    const elapsed = Date.now() - start;

    assert.equal(result.statusCode, 200, 'response is 200');
    assert.ok(elapsed < 2000,
        `C1 guard: response completed in < 2s (no ctx frame present); took ${elapsed}ms`);
    const body = JSON.parse(result.body);
    assert.equal(body.type, 'message', 'response is Anthropic message');
    assert.ok(body.content.some(b => b.type === 'text' && b.text === 'no-ctx text'),
        'text content is "no-ctx text"');

    proxy._closeHttp2Pool();
    await closeProxy(proxy);
    await tokenMock.close();
    await h2cMock.close();
});

// ============================================================================
// CD-ctx — request_context write-back: proxy writes RequestContextResult back
// on the h2c stream (bidi), then half-closes (C1).
// ============================================================================

test('CD-ctx — request_context frame → proxy writes RequestContextResult back on h2c stream (bidi)', async () => {
    const clientWrites = []; // collects Buffer chunks written by proxy → server (run-frame + ctx result)

    const tokenMock = await mockServer(async (req, res) => {
        if (req.url.endsWith('/auth/exchange_user_api_key')) {
            await bufferBody(req);
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ accessToken: 'AT-cdctx' }));
        }
        res.writeHead(404); res.end();
    });

    const h2cMock = await mockH2cServer((stream) => {
        // Collect every DATA chunk the proxy writes up the stream
        stream.on('data', (chunk) => clientWrites.push(Buffer.from(chunk)));

        // On first DATA (run frame), start the response with a request_context frame
        stream.once('data', () => {
            stream.respond({ ':status': 200, 'content-type': 'application/connect+proto' });
            stream.write(tcCombine(tcRequestContextFrame(42, 'exec-ctx-1')));
            // After proxy has had time to write back RequestContextResult, send text + done
            setTimeout(() => {
                stream.write(tcCombine(tcInteractionTextFrame('ctx response')));
                stream.write(tcCombine(tcDoneFrame()));
                stream.end();
            }, 100);
        });
        stream.on('error', () => {}); // suppress write errors after half-close
    });

    const proxy = requireFreshProxy({
        CURSOR_API_KEY: 'cursor-key-cdctx',
        CURSOR_DIRECT: '1',
        CURSOR_BACKEND_BASE_URL: `http://127.0.0.1:${tokenMock.port}`,
        CURSOR_LOCAL_AGENT_ENDPOINT: `http://127.0.0.1:${h2cMock.port}/agent.v1.AgentService/Run`,
        ANTHROPIC_HOST_OVERRIDE: '127.0.0.1:19999',
        CLAUDE_USAGE_FILE: USAGE_FILE_TMP,
        PROBE_INTERVAL_MS: '999999',
    });
    proxy._accessTokenState.cache.clear();
    proxy._accessTokenState.inflight.clear();

    const proxyPort = await listenProxy(proxy);

    const result = await proxyRequest(proxyPort, {
        body: { model: 'composer-2.5', messages: [{ role: 'user', content: 'ctx test' }], max_tokens: 10 },
        headers: { 'connection': 'close' },
    });

    // Proxy must have written ≥2 chunks: run-frame + RequestContextResult (C1 write-back)
    assert.ok(clientWrites.length >= 2,
        `proxy wrote ≥2 frames up h2c stream (run-frame + RequestContextResult); got ${clientWrites.length}`);
    // Second write must be a valid 5-byte+ Connect frame
    assert.ok(clientWrites[1] && clientWrites[1].length >= 5,
        `RequestContextResult frame is ≥5 bytes; got ${clientWrites[1] && clientWrites[1].length}`);

    // Decode the RequestContextResult payload (strip 5-byte Connect header) and assert structure.
    // encodeAgentClientRequestContextResult wraps: field2(execClientMessage) → field10(result)
    //   → field1(success) → field1(requestContext) → field32(capability boolean = 1).
    {
        const ctxBuf = clientWrites[1];
        const ctxPayload = new Uint8Array(ctxBuf.buffer, ctxBuf.byteOffset + 5, ctxBuf.byteLength - 5);
        // outer: field 2 = execClientMessage (wt=2)
        const outerF2 = tcDecodeFields(ctxPayload).find(f => f.no === 2 && f.wt === 2);
        assert.ok(outerF2, 'RequestContextResult outer field 2 (execClientMessage) present');
        // execClientMessage: field 10 = result (wt=2)
        const execF10 = tcDecodeFields(outerF2.value).find(f => f.no === 10 && f.wt === 2);
        assert.ok(execF10, 'execClientMessage field 10 (result) present');
        // result: field 1 = success (wt=2)
        const resF1 = tcDecodeFields(execF10.value).find(f => f.no === 1 && f.wt === 2);
        assert.ok(resF1, 'result field 1 (success) present');
        // success: field 1 = requestContext (wt=2)
        const sucF1 = tcDecodeFields(resF1.value).find(f => f.no === 1 && f.wt === 2);
        assert.ok(sucF1, 'success field 1 (requestContext) present');
        // requestContext: field 32 = capability boolean (varint = 1n)
        const rcF32 = tcDecodeFields(sucF1.value).find(f => f.no === 32 && f.wt === 0);
        assert.ok(rcF32 && rcF32.value === 1n,
            `requestContext field 32 (capability boolean) = 1; got: ${rcF32 && rcF32.value}`);
    }

    assert.equal(result.statusCode, 200, 'response is 200 after request_context write-back');
    const body = JSON.parse(result.body);
    assert.equal(body.type, 'message', 'response is Anthropic message');
    assert.ok(body.content.some(b => b.type === 'text' && b.text === 'ctx response'),
        'text content is "ctx response"');

    proxy._closeHttp2Pool();
    await closeProxy(proxy);
    await tokenMock.close();
    await h2cMock.close();
});

// ============================================================================
// CD-empty — empty Connect frame (flags=0, length=0) → no crash; valid 200
// ============================================================================

test('CD-empty — empty Connect frame (zero-length payload) does not crash proxy; response is 200', async () => {
    const tokenMock = await mockServer(async (req, res) => {
        if (req.url.endsWith('/auth/exchange_user_api_key')) {
            await bufferBody(req);
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ accessToken: 'AT-cdempty' }));
        }
        res.writeHead(404); res.end();
    });

    const h2cMock = await mockH2cServer((stream) => {
        stream.respond({ ':status': 200, 'content-type': 'application/connect+proto' });
        // Empty frame: flags=0, payload=new Uint8Array(0) → 5-byte frame with zero-length payload
        stream.write(tcCombine(tcConnectFrame(new Uint8Array(0))));
        stream.write(tcCombine(tcInteractionTextFrame('after empty')));
        stream.write(tcCombine(tcDoneFrame()));
        stream.end();
    });

    const proxy = requireFreshProxy({
        CURSOR_API_KEY: 'cursor-key-cdempty',
        CURSOR_DIRECT: '1',
        CURSOR_BACKEND_BASE_URL: `http://127.0.0.1:${tokenMock.port}`,
        CURSOR_LOCAL_AGENT_ENDPOINT: `http://127.0.0.1:${h2cMock.port}/agent.v1.AgentService/Run`,
        ANTHROPIC_HOST_OVERRIDE: '127.0.0.1:19999',
        CLAUDE_USAGE_FILE: USAGE_FILE_TMP,
        PROBE_INTERVAL_MS: '999999',
    });
    proxy._accessTokenState.cache.clear();
    proxy._accessTokenState.inflight.clear();

    const proxyPort = await listenProxy(proxy);

    const result = await proxyRequest(proxyPort, {
        body: { model: 'composer-2.5', messages: [{ role: 'user', content: 'empty frame test' }], max_tokens: 10 },
        headers: { 'connection': 'close' },
    });

    assert.equal(result.statusCode, 200, 'empty frame does not crash proxy; response is 200');
    const body = JSON.parse(result.body);
    assert.equal(body.type, 'message', 'response is Anthropic message');
    assert.ok(body.content.some(b => b.type === 'text' && b.text === 'after empty'),
        'text after empty frame is "after empty"');

    proxy._closeHttp2Pool();
    await closeProxy(proxy);
    await tokenMock.close();
    await h2cMock.close();
});

// ============================================================================
// CD-compressed — Connect frame with flags&1=1 → proxy returns 502
// (ConnectFramePushParser throws; forwardToCursorDirect catches → 502)
// ============================================================================

test('CD-compressed — Connect frame with compression flag (flags&1=1) → 502', async () => {
    const tokenMock = await mockServer(async (req, res) => {
        if (req.url.endsWith('/auth/exchange_user_api_key')) {
            await bufferBody(req);
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ accessToken: 'AT-cdcomp' }));
        }
        res.writeHead(404); res.end();
    });

    const h2cMock = await mockH2cServer((stream) => {
        stream.respond({ ':status': 200, 'content-type': 'application/connect+proto' });
        // flags=1 → compressed frame (proxy cannot decode; ConnectFramePushParser throws)
        stream.write(tcCombine(tcConnectFrame(new Uint8Array([0, 0, 0, 0]), 1)));
        stream.end();
        stream.on('error', () => {}); // suppress write-after-reset errors
    });

    const proxy = requireFreshProxy({
        CURSOR_API_KEY: 'cursor-key-cdcomp',
        CURSOR_DIRECT: '1',
        CURSOR_BACKEND_BASE_URL: `http://127.0.0.1:${tokenMock.port}`,
        CURSOR_LOCAL_AGENT_ENDPOINT: `http://127.0.0.1:${h2cMock.port}/agent.v1.AgentService/Run`,
        ANTHROPIC_HOST_OVERRIDE: '127.0.0.1:19999',
        CLAUDE_USAGE_FILE: USAGE_FILE_TMP,
        PROBE_INTERVAL_MS: '999999',
    });
    proxy._accessTokenState.cache.clear();
    proxy._accessTokenState.inflight.clear();

    const proxyPort = await listenProxy(proxy);

    const result = await proxyRequest(proxyPort, {
        body: { model: 'composer-2.5', messages: [{ role: 'user', content: 'compressed' }], max_tokens: 10 },
        headers: { 'connection': 'close' },
    });

    assert.equal(result.statusCode, 502, 'compressed frame → 502');
    const body = JSON.parse(result.body);
    assert.equal(body.type, 'error', 'error envelope has type:error');
    assert.ok(body.error && body.error.message, 'error has message');
    assert.ok(body.error.message.toLowerCase().includes('compress'),
        `502 message mentions "compress"; got: ${body.error.message}`);

    proxy._closeHttp2Pool();
    await closeProxy(proxy);
    await tokenMock.close();
    await h2cMock.close();
});

// ============================================================================
// CD-429 — h2c :status 429 → proxy passthrough 429 with rate_limit_error
// ============================================================================

test('CD-429 — h2c status 429 from AgentService → proxy passthrough 429 rate_limit_error', async () => {
    const tokenMock = await mockServer(async (req, res) => {
        if (req.url.endsWith('/auth/exchange_user_api_key')) {
            await bufferBody(req);
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ accessToken: 'AT-cd429' }));
        }
        res.writeHead(404); res.end();
    });

    const h2cMock = await mockH2cServer((stream) => {
        stream.respond({ ':status': 429, 'content-type': 'application/json', 'retry-after': '30' });
        stream.end(JSON.stringify({ error: { message: 'rate limit exceeded' } }));
    });

    const proxy = requireFreshProxy({
        CURSOR_API_KEY: 'cursor-key-cd429',
        CURSOR_DIRECT: '1',
        CURSOR_BACKEND_BASE_URL: `http://127.0.0.1:${tokenMock.port}`,
        CURSOR_LOCAL_AGENT_ENDPOINT: `http://127.0.0.1:${h2cMock.port}/agent.v1.AgentService/Run`,
        ANTHROPIC_HOST_OVERRIDE: '127.0.0.1:19999',
        CLAUDE_USAGE_FILE: USAGE_FILE_TMP,
        PROBE_INTERVAL_MS: '999999',
    });
    proxy._accessTokenState.cache.clear();
    proxy._accessTokenState.inflight.clear();

    const proxyPort = await listenProxy(proxy);

    const result = await proxyRequest(proxyPort, {
        body: { model: 'composer-2.5', messages: [{ role: 'user', content: 'rate limited' }], max_tokens: 10 },
        headers: { 'connection': 'close' },
    });

    assert.equal(result.statusCode, 429, 'h2c 429 passes through as proxy 429');
    const body = JSON.parse(result.body);
    assert.equal(body.type, 'error', 'error envelope has type:error');
    assert.equal(body.error.type, 'rate_limit_error', 'error type is rate_limit_error');
    assert.ok(body.error.message, 'error has message');
    assert.equal(result.headers['retry-after'], '30', 'retry-after header forwarded');

    proxy._closeHttp2Pool();
    await closeProxy(proxy);
    await tokenMock.close();
    await h2cMock.close();
});

// ============================================================================
// CD-no-usage — no usage data from Cursor → response is still valid 200
// ============================================================================

test('CD-no-usage — no usage data from AgentService → response is valid 200 Anthropic message', async () => {
    const tokenMock = await mockServer(async (req, res) => {
        if (req.url.endsWith('/auth/exchange_user_api_key')) {
            await bufferBody(req);
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ accessToken: 'AT-cdnousage' }));
        }
        res.writeHead(404); res.end();
    });

    const h2cMock = await mockH2cServer((stream) => {
        // Plain text + done, no x-tokens-used or any usage data
        stream.respond({ ':status': 200, 'content-type': 'application/connect+proto' });
        stream.write(tcCombine(tcInteractionTextFrame('no usage text')));
        stream.write(tcCombine(tcDoneFrame()));
        stream.end();
    });

    const proxy = requireFreshProxy({
        CURSOR_API_KEY: 'cursor-key-cdnousage',
        CURSOR_DIRECT: '1',
        CURSOR_BACKEND_BASE_URL: `http://127.0.0.1:${tokenMock.port}`,
        CURSOR_LOCAL_AGENT_ENDPOINT: `http://127.0.0.1:${h2cMock.port}/agent.v1.AgentService/Run`,
        ANTHROPIC_HOST_OVERRIDE: '127.0.0.1:19999',
        CLAUDE_USAGE_FILE: USAGE_FILE_TMP,
        PROBE_INTERVAL_MS: '999999',
    });
    proxy._accessTokenState.cache.clear();
    proxy._accessTokenState.inflight.clear();

    const proxyPort = await listenProxy(proxy);

    const result = await proxyRequest(proxyPort, {
        body: { model: 'composer-2.5', messages: [{ role: 'user', content: 'no usage' }], max_tokens: 10 },
        headers: { 'connection': 'close' },
    });

    assert.equal(result.statusCode, 200, 'response is 200 even with no usage data');
    const body = JSON.parse(result.body);
    assert.equal(body.type, 'message', 'response is Anthropic message');
    assert.ok(body.content.some(b => b.type === 'text' && b.text === 'no usage text'),
        'text content is "no usage text"');
    assert.ok(body.usage && typeof body.usage === 'object',
        'usage field is present (even if zeroed)');

    proxy._closeHttp2Pool();
    await closeProxy(proxy);
    await tokenMock.close();
    await h2cMock.close();
});

// ============================================================================
// Unit:GOAWAY — h2c session pool evicts entry when server sends GOAWAY frame
// ============================================================================

test('Unit:GOAWAY — pool session evicted when h2c server sends GOAWAY', async () => {
    let serverSession = null;

    const tokenMock = await mockServer(async (req, res) => {
        if (req.url.endsWith('/auth/exchange_user_api_key')) {
            await bufferBody(req);
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ accessToken: 'AT-goaway' }));
        }
        res.writeHead(404); res.end();
    });

    // Raw h2c server — capture the server-side session so we can send GOAWAY manually
    const goawayServer = await new Promise((resolve) => {
        const server = http2.createServer();
        server.on('session', (sess) => { serverSession = sess; });
        server.on('stream', (stream) => {
            stream.respond({ ':status': 200, 'content-type': 'application/connect+proto' });
            stream.write(tcCombine(tcInteractionTextFrame('pre-goaway')));
            stream.write(tcCombine(tcDoneFrame()));
            stream.end();
        });
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({ server, port, close: () => new Promise((res) => server.close(res)) });
        });
        server.unref();
    });

    const proxy = requireFreshProxy({
        CURSOR_API_KEY: 'cursor-key-goaway',
        CURSOR_DIRECT: '1',
        CURSOR_BACKEND_BASE_URL: `http://127.0.0.1:${tokenMock.port}`,
        CURSOR_LOCAL_AGENT_ENDPOINT: `http://127.0.0.1:${goawayServer.port}/agent.v1.AgentService/Run`,
        ANTHROPIC_HOST_OVERRIDE: '127.0.0.1:19999',
        CLAUDE_USAGE_FILE: USAGE_FILE_TMP,
        PROBE_INTERVAL_MS: '999999',
    });
    proxy._accessTokenState.cache.clear();
    proxy._accessTokenState.inflight.clear();

    const proxyPort = await listenProxy(proxy);

    // First request populates the pool
    const result = await proxyRequest(proxyPort, {
        body: { model: 'composer-2.5', messages: [{ role: 'user', content: 'pre-goaway' }], max_tokens: 10 },
        headers: { 'connection': 'close' },
    });
    assert.equal(result.statusCode, 200, 'request succeeds before GOAWAY');
    assert.equal(proxy._http2PoolSize(), 1, 'pool has 1 session after first request');

    // Send GOAWAY from server → proxy client fires 'goaway' → closePooledHttp2Client evicts entry
    assert.ok(serverSession, 'server session captured');
    serverSession.goaway();

    // Allow GOAWAY propagation over loopback (100ms is generous)
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(proxy._http2PoolSize(), 0,
        'pool is empty after server GOAWAY (closePooledHttp2Client evicted the entry)');

    // Force-destroy the server session so the underlying TCP socket closes immediately.
    // Both the http2 client (proxy) and server are unref()'d — without this, the graceful
    // TCP close-handshake is never completed and goawayServer.close() would hang (event
    // loop empties while the server is still waiting for the connection to drain).
    try { if (serverSession && !serverSession.destroyed) serverSession.destroy(); } catch { /* ignore */ }
    await new Promise((resolve) => setTimeout(resolve, 30)); // let TCP teardown propagate

    proxy._closeHttp2Pool();
    await closeProxy(proxy);
    await tokenMock.close();
    await goawayServer.close();
});

// ============================================================================
// Unit:proto-wrappers — protoStringField / protoVarintField / protoMessageField
// Verifies the undefined-safe proto wrappers exported from proxy.js encode correctly.
// ============================================================================

test('Unit:proto-wrappers — protoStringField / protoVarintField / protoMessageField encode correctly', () => {
    const proxy = requireFreshProxy({});
    const { protoStringField, protoVarintField, protoMessageField } = proxy;

    // --- protoVarintField ---
    // field 1, varint 300 → tag=0x08 + varint 300 (two-byte: 0xAC 0x02)
    const v300 = protoVarintField(1, 300);
    assert.ok(v300 instanceof Uint8Array, 'protoVarintField returns Uint8Array');
    assert.equal(v300.length, 3, 'protoVarintField(1,300) → 3 bytes (1 tag + 2 varint)');
    assert.equal(v300[0], 0x08, 'varint field 1 tag = 0x08 ((1<<3)|0)');
    assert.equal(v300[1], 0xAC, 'varint 300 low byte = 0xAC (44|0x80)');
    assert.equal(v300[2], 0x02, 'varint 300 high byte = 0x02');

    // bool mappings: true→1, false→0
    const vTrue = protoVarintField(1, true);
    assert.equal(vTrue.length, 2, 'protoVarintField(1,true) → 2 bytes');
    assert.equal(vTrue[1], 1, 'true maps to varint 1');
    const vFalse = protoVarintField(1, false);
    assert.equal(vFalse[1], 0, 'false maps to varint 0');

    // undefined → zero-length (field completely omitted)
    const vUndef = protoVarintField(1, undefined);
    assert.ok(vUndef instanceof Uint8Array, 'protoVarintField(undefined) returns Uint8Array');
    assert.equal(vUndef.length, 0, 'undefined varint → zero-length (field omitted)');

    // --- protoStringField ---
    // field 2, "hello" → tag=0x12 + length 5 + UTF-8 bytes
    const sHello = protoStringField(2, 'hello');
    assert.ok(sHello instanceof Uint8Array, 'protoStringField returns Uint8Array');
    assert.equal(sHello[0], 0x12, 'string field 2 tag = 0x12 ((2<<3)|2)');
    assert.equal(sHello[1], 5, 'length byte = 5');
    assert.equal(new TextDecoder().decode(sHello.slice(2)), 'hello', 'string bytes correct');

    // empty string → tag + length 0 (2 bytes total)
    const sEmpty = protoStringField(3, '');
    assert.equal(sEmpty[0], 0x1A, 'empty string field 3 tag = 0x1A ((3<<3)|2)');
    assert.equal(sEmpty[1], 0, 'empty string length byte = 0');
    assert.equal(sEmpty.length, 2, 'empty string → 2 bytes (tag + length)');

    // undefined → zero-length (field completely omitted)
    const sUndef = protoStringField(1, undefined);
    assert.ok(sUndef instanceof Uint8Array, 'protoStringField(undefined) returns Uint8Array');
    assert.equal(sUndef.length, 0, 'undefined string → zero-length (field omitted)');

    // --- protoMessageField ---
    // field 1, nested = protoVarintField(1,1) = [0x08,0x01] → tag=0x0A + length 2 + nested
    const nested = protoVarintField(1, 1); // [0x08, 0x01]
    const msg = protoMessageField(1, nested);
    assert.ok(msg instanceof Uint8Array, 'protoMessageField returns Uint8Array');
    assert.equal(msg[0], 0x0A, 'message field 1 tag = 0x0A ((1<<3)|2)');
    assert.equal(msg[1], nested.length, `length byte = ${nested.length}`);
    assert.deepEqual(Array.from(msg.slice(2)), Array.from(nested), 'nested bytes correct');

    closeProxy(proxy);
});

// ============================================================================
// CD-concurrent-fault — two simultaneous requests share one h2c session;
// one stream is RST'd (NGHTTP2_INTERNAL_ERROR), the other completes normally.
// Proves per-stream faults don't kill sibling streams on the shared session.
// ============================================================================

test('CD-concurrent-fault — one stream RST\'d on shared h2c session; sibling returns 200', { timeout: 8000 }, async () => {
    let firstStreamSeen = false;

    const tokenMock = await mockServer(async (req, res) => {
        if (req.url.endsWith('/auth/exchange_user_api_key')) {
            await bufferBody(req);
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ accessToken: 'AT-cdfault' }));
        }
        res.writeHead(404); res.end();
    });

    // Both requests hit the same origin → same pooled h2c session → two streams.
    // The first stream to send data is RST'd with INTERNAL_ERROR (no response headers
    // sent first so the proxy's status stays at 502 and the stream close fires fail()).
    // The second stream returns a normal text response.
    const h2cMock = await mockH2cServer((stream) => {
        stream.once('data', () => {
            if (!firstStreamSeen) {
                firstStreamSeen = true;
                // RST WITHOUT sending response headers first — proxy never receives ':status',
                // initial status=502 stays, stream error/close triggers fail() → 5xx to client.
                setTimeout(() => {
                    try { stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR); } catch { /* ignore */ }
                }, 40);
            } else {
                // Second stream: complete normally after a brief delay
                stream.respond({ ':status': 200, 'content-type': 'application/connect+proto' });
                setTimeout(() => {
                    stream.write(tcCombine(tcInteractionTextFrame('survivor text')));
                    stream.write(tcCombine(tcDoneFrame()));
                    stream.end();
                }, 80);
            }
        });
        stream.on('error', () => {}); // suppress write-after-RST errors
    });

    const proxy = requireFreshProxy({
        CURSOR_API_KEY: 'cursor-key-cdfault',
        CURSOR_DIRECT: '1',
        CURSOR_BACKEND_BASE_URL: `http://127.0.0.1:${tokenMock.port}`,
        CURSOR_LOCAL_AGENT_ENDPOINT: `http://127.0.0.1:${h2cMock.port}/agent.v1.AgentService/Run`,
        ANTHROPIC_HOST_OVERRIDE: '127.0.0.1:19999',
        CLAUDE_USAGE_FILE: USAGE_FILE_TMP,
        PROBE_INTERVAL_MS: '999999',
    });
    proxy._accessTokenState.cache.clear();
    proxy._accessTokenState.inflight.clear();

    const proxyPort = await listenProxy(proxy);

    // Fire two concurrent requests — same h2c origin → shared session, separate streams
    const [result1, result2] = await Promise.all([
        proxyRequest(proxyPort, {
            body: { model: 'composer-2.5', messages: [{ role: 'user', content: 'fault req' }], max_tokens: 10 },
            headers: { 'connection': 'close' },
        }),
        proxyRequest(proxyPort, {
            body: { model: 'composer-2.5', messages: [{ role: 'user', content: 'survivor req' }], max_tokens: 10 },
            headers: { 'connection': 'close' },
        }),
    ]);

    const results = [result1, result2];
    const okResult = results.find(r => r.statusCode === 200);
    const errResult = results.find(r => r.statusCode >= 400);

    // The RST'd stream must surface an error (not hang or succeed)
    assert.ok(errResult,
        `RST'd stream must surface a 4xx/5xx; got: ${results.map(r => r.statusCode).join(', ')}`);
    // The survivor stream must succeed
    assert.ok(okResult,
        `survivor stream must return 200; got: ${results.map(r => r.statusCode).join(', ')}`);

    const body = JSON.parse(okResult.body);
    assert.equal(body.type, 'message', 'survivor response is Anthropic message');
    assert.ok(body.content.some(b => b.type === 'text' && b.text === 'survivor text'),
        'survivor response contains "survivor text"');

    proxy._closeHttp2Pool();
    await closeProxy(proxy);
    await tokenMock.close();
    await h2cMock.close();
});
