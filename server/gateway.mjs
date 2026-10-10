import { createServer, request } from 'node:http';
import { isIP } from 'node:net';

const extraHost = process.env.ADDITIONAL_HOST?.trim();
if (extraHost && (isIP(extraHost) !== 4 || !isPrivateIPv4(extraHost))) {
  throw new Error('ADDITIONAL_HOST must be a private IPv4 address');
}

const allowedHosts = new Set(['127.0.0.1', 'localhost', ...(extraHost ? [extraHost] : [])]);
const hopByHopHeaders = new Set([
  'connection', 'proxy-connection', 'keep-alive', 'transfer-encoding',
  'upgrade', 'te', 'trailer', 'proxy-authorization', 'proxy-authenticate'
]);

function isPrivateIPv4(value) {
  const [a, b] = value.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function acceptedHost(hostHeader) {
  if (typeof hostHeader !== 'string' || !/^[a-zA-Z0-9.:-]+$/.test(hostHeader)) return false;
  const parts = hostHeader.toLowerCase().split(':');
  if (parts.length > 2 || !allowedHosts.has(parts[0])) return false;
  return parts.length === 1 || (/^\d{1,5}$/.test(parts[1]) && Number(parts[1]) > 0 && Number(parts[1]) <= 65535);
}

function withoutHopByHop(headers) {
  const result = { ...headers };
  for (const name of String(headers.connection || '').split(',').map((value) => value.trim().toLowerCase())) {
    if (name) delete result[name];
  }
  for (const name of hopByHopHeaders) delete result[name];
  for (const name of Object.keys(result)) {
    if (name.startsWith('x-forwarded-') || name === 'forwarded') delete result[name];
  }
  return result;
}

function jsonError(response, statusCode, code, message) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify({ code, error: message }));
}

// The target is constant: user-controlled paths and headers never select an upstream.
const server = createServer((incoming, outgoing) => {
  if (!acceptedHost(incoming.headers.host)) {
    return jsonError(outgoing, 421, 'HOST_NOT_ALLOWED', 'このホスト名からは利用できません。');
  }

  const upstream = request({
    hostname: 'app',
    port: 3000,
    method: incoming.method,
    path: incoming.url,
    headers: withoutHopByHop(incoming.headers)
  }, (response) => {
    outgoing.writeHead(response.statusCode || 502, withoutHopByHop(response.headers));
    response.pipe(outgoing);
  });

  upstream.setTimeout(15000, () => upstream.destroy(new Error('Upstream timeout')));
  upstream.on('error', () => {
    if (outgoing.headersSent) return outgoing.destroy();
    jsonError(outgoing, 502, 'UPSTREAM_UNAVAILABLE', 'アプリを起動しています。少し待って再読み込みしてください。');
  });
  incoming.on('aborted', () => upstream.destroy());
  outgoing.on('close', () => { if (!outgoing.writableFinished) upstream.destroy(); });
  incoming.pipe(upstream);
});

server.requestTimeout = 10000;
server.headersTimeout = 10000;
server.listen(Number(process.env.PORT || 8080), process.env.HOST || '127.0.0.1', () => {
  console.log('KOVA Store gateway ready');
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close();
    server.closeIdleConnections();
  });
}
