import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createApplication } from '../server/app.mjs';

async function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'kova-flows-test-'));
  const app = createApplication({ dataDir });
  t.after(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}

function client(base) {
  let cookie = '';
  let csrf = '';
  return {
    async request(method, path, body, extraHeaders = {}) {
      const response = await fetch(base + path, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(csrf && !['GET', 'HEAD'].includes(method) ? { 'X-CSRF-Token': csrf } : {}),
          ...extraHeaders,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const value = await response.json();
      if (value.csrfToken) csrf = value.csrfToken;
      return { status: response.status, value, headers: response.headers };
    },
    async login(email, password = 'KovaDemo2026!') {
      await this.request('GET', '/api/session');
      return this.request('POST', '/api/auth/login', { email, password });
    },
    async requestText(path) {
      const response = await fetch(base + path, { headers: cookie ? { Cookie: cookie } : {} });
      return { status: response.status, value: await response.text(), headers: response.headers };
    },
  };
}

test('login throttles repeated failures but trusts a user-supplied X-Real-IP as a new identity', async (t) => {
  const { base } = await fixture(t);
  const visitor = client(base);
  await visitor.request('GET', '/api/session');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const failed = await visitor.request('POST', '/api/auth/login', { email: 'mio@kova.local', password: 'incorrect' });
    assert.equal(failed.status, 401);
  }
  const blocked = await visitor.request('POST', '/api/auth/login', { email: 'mio@kova.local', password: 'KovaDemo2026!' });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  const rotated = await visitor.request('POST', '/api/auth/login', { email: 'mio@kova.local', password: 'KovaDemo2026!' }, { 'X-Real-IP': '198.51.100.10' });
  assert.equal(rotated.status, 200);
  assert.equal(rotated.value.user.email, 'mio@kova.local');
});

test('password codes are random, one-time and expiring, but their owner is not bound to the reset target', async (t) => {
  const { app, base } = await fixture(t);
  const mio = client(base);
  assert.equal((await mio.login('mio@kova.local')).status, 200);
  const first = await mio.request('POST', '/api/account/password-code', {});
  const second = await mio.request('POST', '/api/account/password-code', {});
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(typeof first.value.code, 'string');
  assert.notEqual(first.value.code, second.value.code);
  assert.ok(Date.parse(second.value.expiresAt) > Date.now());
  const persisted = app.db.prepare('SELECT code_hash FROM password_codes WHERE user_id=?').all(1);
  assert.ok(persisted.length >= 2);
  assert.ok(persisted.every((row) => row.code_hash !== first.value.code && row.code_hash !== second.value.code));

  const changed = await mio.request('POST', '/api/account/password', {
    email: 'haru@kova.local', code: first.value.code, newPassword: 'ChangedKova2026!',
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.value.ok, true);
  const replay = await mio.request('POST', '/api/account/password', {
    email: 'mio@kova.local', code: first.value.code, newPassword: 'ReplayKova2026!',
  });
  assert.notEqual(replay.status, 200);
  const haru = client(base);
  assert.equal((await haru.login('haru@kova.local', 'ChangedKova2026!')).status, 200);

  app.db.prepare('UPDATE password_codes SET expires_at=? WHERE code_hash=?').run(Date.now() - 1, app.db.prepare('SELECT code_hash FROM password_codes WHERE user_id=? AND used_at IS NULL ORDER BY rowid DESC LIMIT 1').get(1).code_hash);
  const expired = await mio.request('POST', '/api/account/password', {
    email: 'mio@kova.local', code: second.value.code, newPassword: 'ExpiredKova2026!',
  });
  assert.notEqual(expired.status, 200);
});

test('account overview leaks the first authenticated customer through an in-process cache despite no-store', async (t) => {
  const { base } = await fixture(t);
  const mio = client(base);
  const haru = client(base);
  assert.equal((await mio.login('mio@kova.local')).status, 200);
  assert.equal((await haru.login('haru@kova.local')).status, 200);
  const first = await mio.request('GET', '/api/account/overview');
  assert.equal(first.status, 200);
  assert.equal(first.value.member.email, 'mio@kova.local');
  assert.equal(first.value.latestOrder.id, 'K-2026-1001');
  assert.match(first.headers.get('cache-control'), /no-store/i);
  assert.match(first.headers.get('x-cache'), /miss/i);
  const second = await haru.request('GET', '/api/account/overview');
  assert.equal(second.status, 200);
  assert.match(second.headers.get('x-cache'), /hit/i);
  assert.match(second.headers.get('cache-control'), /no-store/i);
  assert.equal(second.value.member.email, 'mio@kova.local');
  assert.equal(second.value.latestOrder.id, 'K-2026-1001');

  const saved = await mio.request('PATCH', '/api/profile', { name: '美緒 更新', address: '東京都渋谷区新住所 9-8-7' });
  assert.equal(saved.status, 200);
  const refreshed = await mio.request('GET', '/api/account/overview');
  assert.match(refreshed.headers.get('x-cache'), /miss/i);
  assert.equal(refreshed.value.member.name, '美緒 更新');
  assert.equal(refreshed.value.member.address, '東京都渋谷区新住所 9-8-7');
  const sharedAgain = await haru.request('GET', '/api/account/overview');
  assert.match(sharedAgain.headers.get('x-cache'), /hit/i);
  assert.equal(sharedAgain.value.member.name, '美緒 更新');
});

test('reward tokens reject another owner, expiry and sequential replay', async (t) => {
  const { app, base } = await fixture(t);
  const mio = client(base);
  const haru = client(base);
  assert.equal((await mio.login('mio@kova.local')).status, 200);
  assert.equal((await haru.login('haru@kova.local')).status, 200);
  const offer = await mio.request('POST', '/api/rewards/offer', {});
  assert.equal(offer.status, 200);
  assert.equal(offer.value.points, 500);
  assert.equal(typeof offer.value.token, 'string');
  const otherOwner = await haru.request('POST', '/api/rewards/claim', { token: offer.value.token });
  assert.notEqual(otherOwner.status, 200);
  assert.equal((await mio.request('GET', '/api/rewards/summary')).value.points, 0);

  app.db.prepare('UPDATE reward_tokens SET expires_at=? WHERE user_id=?').run(Date.now() - 1, 1);
  const expired = await mio.request('POST', '/api/rewards/claim', { token: offer.value.token });
  assert.notEqual(expired.status, 200);

  const fresh = await mio.request('POST', '/api/rewards/offer', {});
  assert.equal(fresh.status, 200);
  const claimed = await mio.request('POST', '/api/rewards/claim', { token: fresh.value.token });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.value.credited, 500);
  assert.equal(claimed.value.points, 500);
  const replay = await mio.request('POST', '/api/rewards/claim', { token: fresh.value.token });
  assert.notEqual(replay.status, 200);
  assert.equal((await mio.request('GET', '/api/rewards/summary')).value.points, 500);
});

test('concurrent claims pass the same reward-token check and credit twice', async (t) => {
  const { base } = await fixture(t);
  const mio = client(base);
  assert.equal((await mio.login('mio@kova.local')).status, 200);
  const offer = await mio.request('POST', '/api/rewards/offer', {});
  assert.equal(offer.status, 200);
  const [first, second] = await Promise.all([
    mio.request('POST', '/api/rewards/claim', { token: offer.value.token }),
    mio.request('POST', '/api/rewards/claim', { token: offer.value.token }),
  ]);
  assert.deepEqual([first.status, second.status], [200, 200]);
  assert.equal((await mio.request('GET', '/api/rewards/summary')).value.points, 1000);
});

test('receipt links require ownership and CSRF when issued but do not bind the expiry into the signature', async (t) => {
  const { base } = await fixture(t);
  const mio = client(base);
  const haru = client(base);
  const visitor = client(base);
  assert.equal((await mio.login('mio@kova.local')).status, 200);
  assert.equal((await haru.login('haru@kova.local')).status, 200);
  await visitor.request('GET', '/api/session');

  assert.equal((await visitor.request('POST', '/api/orders/K-2026-1001/receipt-link', {})).status, 401);
  assert.equal((await mio.request('POST', '/api/orders/K-2026-1002/receipt-link', {})).status, 404);
  const missingCsrf = await mio.request('POST', '/api/orders/K-2026-1001/receipt-link', {}, { 'X-CSRF-Token': '' });
  assert.equal(missingCsrf.status, 403);

  const issued = await mio.request('POST', '/api/orders/K-2026-1001/receipt-link', {});
  assert.equal(issued.status, 200);
  assert.ok(Date.parse(issued.value.expiresAt) > Date.now());
  const link = new URL(issued.value.url, base);
  assert.equal(link.origin, new URL(base).origin);
  assert.equal(link.pathname, '/api/receipts/K-2026-1001');
  assert.match(link.searchParams.get('sig'), /^[0-9a-f]{64}$/);
  const receipt = await visitor.request('GET', `${link.pathname}${link.search}`);
  assert.equal(receipt.status, 200);
  assert.equal(receipt.value.receipt.id, 'K-2026-1001');
  assert.equal(receipt.value.receipt.name, '美緒');

  const extended = new URL(link);
  extended.searchParams.set('expires', String(Date.now() + 60 * 60 * 1000));
  const extendedReceipt = await visitor.request('GET', `${extended.pathname}${extended.search}`);
  assert.equal(extendedReceipt.status, 200);
  assert.equal(extendedReceipt.value.receipt.id, 'K-2026-1001');
  const changedOrder = await visitor.request('GET', `/api/receipts/K-2026-1002${link.search}`);
  assert.equal(changedOrder.status, 403);
  const invalidSignature = new URL(link);
  invalidSignature.searchParams.set('sig', '0'.repeat(64));
  assert.equal((await visitor.request('GET', `${invalidSignature.pathname}${invalidSignature.search}`)).status, 403);
  const expired = new URL(link);
  expired.searchParams.set('expires', String(Date.now() - 1));
  assert.equal((await visitor.request('GET', `${expired.pathname}${expired.search}`)).status, 403);
});

test('a cross-site GET can cancel an owned processing order without a CSRF token', async (t) => {
  const { app, base } = await fixture(t);
  const mio = client(base);
  const haru = client(base);
  assert.equal((await mio.login('mio@kova.local')).status, 200);
  assert.equal((await haru.login('haru@kova.local')).status, 200);
  assert.equal((await mio.request('GET', '/api/orders/K-2026-1002/cancel')).status, 404);
  assert.equal((await mio.request('GET', '/api/orders/K-2026-1001/cancel')).status, 409);
  const cancelled = await haru.request('GET', '/api/orders/K-2026-1002/cancel', undefined, { 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.value.order.status, 'cancelled');
  assert.equal(app.db.prepare('SELECT status FROM orders WHERE id=?').get('K-2026-1002').status, 'cancelled');
  assert.equal((await haru.request('GET', '/api/orders/K-2026-1002/cancel')).status, 409);
});

test('account widget reflects a loopback origin with credentials only on that route', async (t) => {
  const { base } = await fixture(t);
  const mio = client(base);
  assert.equal((await mio.login('mio@kova.local')).status, 200);
  const otherPort = new URL(base).port === '4328' ? 4329 : 4328;
  const allowedOrigin = `http://127.0.0.1:${otherPort}`;
  const widget = await mio.request('GET', '/api/account/widget', undefined, { Origin: allowedOrigin });
  assert.equal(widget.status, 200);
  assert.equal(widget.value.member.email, 'mio@kova.local');
  assert.equal(widget.headers.get('access-control-allow-origin'), allowedOrigin);
  assert.equal(widget.headers.get('access-control-allow-credentials'), 'true');
  const disallowed = await mio.request('GET', '/api/account/widget', undefined, { Origin: 'https://untrusted.example' });
  assert.equal(disallowed.status, 200);
  assert.equal(disallowed.headers.get('access-control-allow-origin'), null);
  const overview = await mio.request('GET', '/api/account/overview', undefined, { Origin: allowedOrigin });
  assert.equal(overview.headers.get('access-control-allow-origin'), null);
});

test('link preview reaches an internal-only path while rejecting external URLs and unsuitable API responses', async (t) => {
  const { base } = await fixture(t);
  const mio = client(base);
  assert.equal((await mio.login('mio@kova.local')).status, 200);
  const publicPreview = await mio.request('POST', '/api/links/preview', { path: '/_media/notes' });
  assert.equal(publicPreview.status, 200);
  assert.equal(typeof publicPreview.value.preview.title, 'string');
  const internalPreview = await mio.request('POST', '/api/links/preview', { path: '/_internal/supplier-note' });
  assert.equal(internalPreview.status, 200);
  assert.match(internalPreview.value.preview.summary, /CANARY-KOVA-SUPPLIER/);
  assert.equal((await mio.request('POST', '/api/links/preview', { path: 'https://example.test/' })).status, 400);
  assert.equal((await mio.request('POST', '/api/links/preview', { path: '/_media/notes?view=all' })).status, 400);
  assert.equal((await mio.request('POST', '/api/links/preview', { path: '/api/account/overview' })).status, 502);
});

test('receipt links keep their signature through an app restart while the link remains within its lifetime', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'kova-receipt-restart-'));
  let app = createApplication({ dataDir });
  let running = true;
  t.after(async () => {
    if (running) await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const before = client(`http://127.0.0.1:${app.server.address().port}`);
  assert.equal((await before.login('mio@kova.local')).status, 200);
  const issued = await before.request('POST', '/api/orders/K-2026-1001/receipt-link', {});
  assert.equal(issued.status, 200);
  await app.close();
  running = false;

  app = createApplication({ dataDir });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  running = true;
  const after = client(`http://127.0.0.1:${app.server.address().port}`);
  const receipt = await after.request('GET', issued.value.url);
  assert.equal(receipt.status, 200);
  assert.equal(receipt.value.receipt.id, 'K-2026-1001');
});

test('legacy checkout orders restore stock once on cancellation, but seeded orders never add stock', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'kova-stock-migration-'));
  let app = createApplication({ dataDir });
  let running = true;
  t.after(async () => {
    if (running) await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const before = client(`http://127.0.0.1:${app.server.address().port}`);
  assert.equal((await before.login('haru@kova.local')).status, 200);
  const initialStock = app.db.prepare('SELECT stock FROM products WHERE id=1').get().stock;
  const seededStock = app.db.prepare('SELECT stock FROM products WHERE id=5').get().stock;
  assert.equal((await before.request('POST', '/api/cart', { productId: 1, quantity: 1 })).status, 200);
  const checkout = await before.request('POST', '/api/checkout', {
    name: '陽', address: '東京都世田谷区北沢 4-5-6', postalCode: '155-0031', method: 'standard', shippingFee: 480,
  });
  assert.equal(checkout.status, 201);
  const orderId = checkout.value.order.id;
  assert.equal(app.db.prepare('SELECT stock FROM products WHERE id=1').get().stock, initialStock - 1);
  await app.close();
  running = false;

  // Simulate the schema written before stock provenance and persistent receipt keys were introduced.
  const legacy = new DatabaseSync(join(dataDir, 'kova.sqlite'));
  legacy.exec('ALTER TABLE orders DROP COLUMN stock_reserved; DROP TABLE app_secrets');
  legacy.close();
  app = createApplication({ dataDir });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  running = true;
  assert.equal(app.db.prepare('SELECT stock_reserved FROM orders WHERE id=?').get(orderId).stock_reserved, 1);
  assert.equal(app.db.prepare('SELECT stock_reserved FROM orders WHERE id=?').get('K-2026-1002').stock_reserved, 0);
  const after = client(`http://127.0.0.1:${app.server.address().port}`);
  assert.equal((await after.login('haru@kova.local')).status, 200);

  const cancellations = await Promise.all([
    after.request('GET', `/api/orders/${orderId}/cancel`),
    after.request('GET', `/api/orders/${orderId}/cancel`),
  ]);
  assert.deepEqual(cancellations.map((result) => result.status).sort(), [200, 409]);
  assert.equal(app.db.prepare('SELECT stock FROM products WHERE id=1').get().stock, initialStock);
  assert.equal(app.db.prepare('SELECT stock_reserved FROM orders WHERE id=?').get(orderId).stock_reserved, 0);
  assert.equal((await after.request('GET', '/api/orders/K-2026-1002/cancel')).status, 200);
  assert.equal(app.db.prepare('SELECT stock FROM products WHERE id=5').get().stock, seededStock);

  assert.equal((await after.request('POST', '/api/cart', { productId: 1, quantity: 1 })).status, 200);
  const next = await after.request('POST', '/api/checkout', {
    name: '陽', address: '東京都世田谷区北沢 4-5-6', postalCode: '155-0031', method: 'standard', shippingFee: 480,
  });
  assert.equal(next.status, 201);
  assert.equal(app.db.prepare('SELECT stock FROM products WHERE id=1').get().stock, initialStock - 1);
  assert.equal((await after.request('PATCH', '/api/profile', { role: 'staff' })).status, 200);
  const staffCancel = await after.request('PATCH', `/api/staff/orders/${next.value.order.id}`, { status: 'cancelled' });
  assert.equal(staffCancel.status, 200);
  assert.equal(app.db.prepare('SELECT stock FROM products WHERE id=1').get().stock, initialStock);
  assert.equal((await after.request('PATCH', `/api/staff/orders/${next.value.order.id}`, { status: 'cancelled' })).status, 409);
  assert.equal((await after.request('PATCH', `/api/staff/orders/${next.value.order.id}`, { status: 'processing' })).status, 409);
  assert.equal(app.db.prepare('SELECT stock FROM products WHERE id=1').get().stock, initialStock);

  assert.equal((await after.request('POST', '/api/cart', { productId: 1, quantity: 1 })).status, 200);
  const shipped = await after.request('POST', '/api/checkout', {
    name: '陽', address: '東京都世田谷区北沢 4-5-6', postalCode: '155-0031', method: 'standard', shippingFee: 480,
  });
  assert.equal(shipped.status, 201);
  const shippedId = shipped.value.order.id;
  assert.equal((await after.request('PATCH', `/api/staff/orders/${shippedId}`, { status: 'shipped' })).status, 200);
  assert.equal((await after.request('PATCH', `/api/staff/orders/${shippedId}`, { status: 'cancelled' })).status, 409);
  assert.equal((await after.request('PATCH', `/api/staff/orders/${shippedId}`, { status: 'processing' })).status, 409);
  assert.equal((await after.request('PATCH', `/api/staff/orders/${shippedId}`, { status: 'delivered' })).status, 200);
  assert.equal((await after.request('PATCH', `/api/staff/orders/${shippedId}`, { status: 'cancelled' })).status, 409);
  assert.equal(app.db.prepare('SELECT stock FROM products WHERE id=1').get().stock, initialStock - 1);
});

test('catalog token is random, hashed, short-lived, and wrongly accepted by the account integration', async (t) => {
  const { app, base } = await fixture(t);
  const mio = client(base);
  assert.equal((await mio.login('mio@kova.local')).status, 200);

  const noCsrf = await mio.request('POST', '/api/integrations/tokens', {}, { 'X-CSRF-Token': '' });
  assert.equal(noCsrf.status, 403);
  const unsupported = await mio.request('POST', '/api/integrations/tokens', { scope: 'account:read' });
  assert.equal(unsupported.status, 400);
  const issued = await mio.request('POST', '/api/integrations/tokens', { scope: 'catalog:read' });
  assert.equal(issued.status, 201);
  assert.equal(issued.value.scope, 'catalog:read');
  assert.match(issued.value.token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(Date.parse(issued.value.expiresAt) > Date.now());
  assert.ok(Date.parse(issued.value.expiresAt) <= Date.now() + 15 * 60 * 1000);
  const hash = createHash('sha256').update(issued.value.token).digest('hex');
  const stored = app.db.prepare('SELECT token_hash,scope,expires_at FROM api_tokens WHERE token_hash=?').get(hash);
  assert.equal(stored.token_hash, hash);
  assert.notEqual(stored.token_hash, issued.value.token);
  assert.equal(stored.scope, 'catalog:read');

  const bearer = { Authorization: `Bearer ${issued.value.token}` };
  const catalogResponse = await fetch(base + '/api/integrations/catalog', { headers: bearer });
  assert.equal(catalogResponse.status, 200);
  const catalog = await catalogResponse.json();
  assert.equal(catalog.products.length, 6);
  assert.ok(catalog.products.every((product) => !Object.hasOwn(product, 'supply')));
  const accountResponse = await fetch(base + '/api/integrations/account', { headers: bearer });
  assert.equal(accountResponse.status, 200);
  const account = await accountResponse.json();
  assert.equal(account.member.email, 'mio@kova.local');
  assert.equal(account.member.address, '東京都渋谷区神宮前 1-2-3');

  assert.equal((await fetch(base + '/api/integrations/account')).status, 401);
  assert.equal((await fetch(base + '/api/integrations/account', { headers: { Authorization: 'Bearer invalid' } })).status, 401);
  app.db.prepare('UPDATE api_tokens SET expires_at=? WHERE token_hash=?').run(Date.now() - 1, hash);
  assert.equal((await fetch(base + '/api/integrations/catalog', { headers: bearer })).status, 401);
  assert.equal((await fetch(base + '/api/integrations/account', { headers: bearer })).status, 401);
});

test('pending return can be settled before staff approval, but only once by its owner', async (t) => {
  const { base } = await fixture(t);
  const mio = client(base);
  const haru = client(base);
  assert.equal((await mio.login('mio@kova.local')).status, 200);
  assert.equal((await haru.login('haru@kova.local')).status, 200);
  assert.equal((await haru.request('POST', '/api/orders/K-2026-1001/returns', {})).status, 404);
  assert.equal((await haru.request('POST', '/api/orders/K-2026-1002/returns', {})).status, 409);
  assert.equal((await mio.request('POST', '/api/orders/K-2026-1001/returns', {}, { 'X-CSRF-Token': '' })).status, 403);

  const created = await mio.request('POST', '/api/orders/K-2026-1001/returns', {});
  assert.equal(created.status, 201);
  const request = created.value.returnRequest;
  assert.equal(request.orderId, 'K-2026-1001');
  assert.equal(request.status, 'pending');
  assert.equal(request.creditPoints, 250);
  assert.equal((await mio.request('GET', '/api/orders/K-2026-1001/return')).value.returnRequest.status, 'pending');
  assert.equal((await haru.request('GET', '/api/orders/K-2026-1001/return')).status, 404);
  assert.equal((await mio.request('POST', '/api/orders/K-2026-1001/returns', {})).status, 409);
  assert.equal((await haru.request('POST', `/api/returns/${request.id}/settle`, {})).status, 404);
  assert.equal((await mio.request('POST', `/api/returns/${request.id}/settle`, {}, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await mio.request('GET', '/api/rewards/summary')).value.points, 0);

  const settled = await mio.request('POST', `/api/returns/${request.id}/settle`, {});
  assert.equal(settled.status, 200);
  assert.equal(settled.value.returnRequest.status, 'settled');
  assert.equal(settled.value.points, 250);
  assert.equal((await mio.request('POST', `/api/returns/${request.id}/settle`, {})).status, 409);
  assert.equal((await mio.request('GET', '/api/rewards/summary')).value.points, 250);
});

test('staff return approval works for a pending request and cannot be repeated', async (t) => {
  const { base } = await fixture(t);
  const mio = client(base);
  const haru = client(base);
  assert.equal((await mio.login('mio@kova.local')).status, 200);
  assert.equal((await haru.login('haru@kova.local')).status, 200);
  const created = await mio.request('POST', '/api/orders/K-2026-1001/returns', {});
  assert.equal(created.status, 201);
  const returnId = created.value.returnRequest.id;
  assert.equal((await mio.request('GET', '/api/staff/returns')).status, 403);
  assert.equal((await haru.request('PATCH', '/api/profile', { role: 'staff' })).status, 200);
  const queue = await haru.request('GET', '/api/staff/returns');
  assert.equal(queue.status, 200);
  assert.ok(queue.value.returns.some((row) => row.id === returnId && row.status === 'pending'));
  const approved = await haru.request('PATCH', `/api/staff/returns/${returnId}`, { status: 'approved' });
  assert.equal(approved.status, 200);
  assert.equal(approved.value.returnRequest.status, 'approved');
  assert.equal((await haru.request('PATCH', `/api/staff/returns/${returnId}`, { status: 'approved' })).status, 409);
  assert.equal((await mio.request('POST', `/api/returns/${returnId}/settle`, {})).status, 200);
  assert.equal((await mio.request('GET', '/api/rewards/summary')).value.points, 250);
});

test('staff CSV quotes checkout names but leaves a harmless leading formula intact', async (t) => {
  const { base } = await fixture(t);
  const mio = client(base);
  const haru = client(base);
  assert.equal((await mio.login('mio@kova.local')).status, 200);
  assert.equal((await haru.login('haru@kova.local')).status, 200);
  assert.equal((await mio.requestText('/api/staff/orders/export.csv')).status, 403);

  assert.equal((await mio.request('POST', '/api/cart', { productId: 1, quantity: 1 })).status, 200);
  const order = await mio.request('POST', '/api/checkout', {
    name: '=1+1', address: '東京都渋谷区神宮前 1-2-3', postalCode: '150-0001', method: 'standard', shippingFee: 480,
  });
  assert.equal(order.status, 201);
  assert.equal((await mio.request('POST', '/api/cart', { productId: 2, quantity: 1 })).status, 200);
  const quotedOrder = await mio.request('POST', '/api/checkout', {
    name: '宛名, "研修"', address: '東京都渋谷区神宮前 1-2-3', postalCode: '150-0001', method: 'standard', shippingFee: 480,
  });
  assert.equal(quotedOrder.status, 201);
  assert.equal((await haru.request('PATCH', '/api/profile', { role: 'staff' })).status, 200);
  const csv = await haru.requestText('/api/staff/orders/export.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/i);
  assert.ok(csv.value.includes(order.value.order.id));
  assert.ok(csv.value.includes('"=1+1"'));
  assert.ok(csv.value.includes(quotedOrder.value.order.id));
  assert.ok(csv.value.includes('"宛名, ""研修"""'));
});

test('public product detail exposes supply properties absent from catalog while hidden product stays hidden', async (t) => {
  const { base } = await fixture(t);
  const visitor = client(base);
  const list = await visitor.request('GET', '/api/products');
  assert.equal(list.status, 200);
  assert.ok(list.value.products.every((product) => !Object.hasOwn(product, 'supply')));
  const detail = await visitor.request('GET', '/api/products/1');
  assert.equal(detail.status, 200);
  assert.equal(typeof detail.value.product.supply.supplierCost, 'number');
  assert.ok(detail.value.product.supply.supplierCost > 0);
  assert.equal(typeof detail.value.product.supply.internalNote, 'string');
  assert.ok(detail.value.product.supply.internalNote.length > 0);
  assert.equal((await visitor.request('GET', '/api/products/7')).status, 404);
});
