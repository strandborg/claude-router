'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 4080;
const BIND = '127.0.0.1';
const UPSTREAM_HOST = 'api.anthropic.com';
const UPSTREAM_TIMEOUT_MS = 300000; // 5 min — inference can be slow

// Allow override via env var for when running as LocalSystem (home dir differs)
const USAGE_FILE = process.env.CLAUDE_USAGE_FILE
    || path.join(os.homedir(), '.claude', 'usage-status.md');

// Static hop-by-hop headers that must never be forwarded end-to-end (RFC 2616 §13.5.1)
const HOP_BY_HOP_STATIC = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailers', 'transfer-encoding', 'upgrade',
]);

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

let headersLogged = false; // log all ratelimit headers once to discover per-model pools

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
}

// Ensure the target directory exists at startup — fail loudly now rather than silently later
try {
    fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
} catch (err) {
    console.error(`[proxy] Cannot create directory for usage file: ${err.message}`);
    process.exit(1);
}

const server = http.createServer((clientReq, clientRes) => {
    const upstreamHeaders = {
        ...stripHopByHop(clientReq.headers),
        host: UPSTREAM_HOST,
    };

    const options = {
        hostname: UPSTREAM_HOST,
        port: 443,
        path: clientReq.url,
        method: clientReq.method,
        headers: upstreamHeaders,
        timeout: UPSTREAM_TIMEOUT_MS,
    };

    const upstreamReq = https.request(options, (upstreamRes) => {
        writeUsageFile(upstreamRes.headers);

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

    clientReq.pipe(upstreamReq, { end: true });
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`[proxy] Port ${PORT} already in use. Another instance running?`);
    } else {
        console.error('[proxy] Server error:', err.message);
    }
    process.exit(1);
});

server.listen(PORT, BIND, () => {
    console.log(`[proxy] Listening on ${BIND}:${PORT} -> ${UPSTREAM_HOST}`);
    console.log(`[proxy] Writing usage to: ${USAGE_FILE}`);
});
