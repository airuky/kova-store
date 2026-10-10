import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get } from 'node:http';
import { createApplication } from '../server/app.mjs';

async function fixture(t, additionalHost = '') {
  const dataDir = mkdtempSync(join(tmpdir(), 'kova-test-'));
  const app = createApplication({ dataDir, additionalHost });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, base };
}

function client(base) {
  let cookie = '';
  let csrf = '';
  return {
    async request(method, path, body, extra = {}) {
      const response = await fetch(base + path, {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(csrf && !['GET', 'HEAD'].includes(method) ? { 'X-CSRF-Token': csrf } : {}),
          ...extra,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const value = await response.json();
      if (value.csrfToken) csrf = value.csrfToken;
      return { status: response.status, value, headers: response.headers };
    },
    async login(email = 'mio@kova.local', password = 'KovaDemo2026!') {
      await this.request('GET', '/api/session');
      return this.request('POST', '/api/auth/login', { email, password });
    },
  };
}

test('public catalog works and the isolated search SQL injection reveals only a hidden product', async (t) => {
  const { app, base } = await fixture(t);
  const visitor = client(base);
  const normal = await visitor.request('GET', '/api/products');
  assert.equal(normal.status, 200);
  assert.equal(normal.value.products.length, 6);
  assert.equal(normal.value.products.some((p) => p.id === 7), false);
  const injected = await visitor.request('GET', `/api/products?q=${encodeURIComponent("%') OR 1=1 -- ")}`);
  assert.equal(injected.status, 200);
  assert.equal(injected.value.products.length, 7);
  assert.match(injected.value.products.find((p) => p.id === 7).description, /CANARY-KOVA-PRODUCT-7/);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2);
  const detail = await visitor.request('GET', '/api/products/7');
  assert.equal(detail.status, 404);
});

test('accounts use hashed passwords, HttpOnly session cookies and CSRF on mutations', async (t) => {
  const { app, base } = await fixture(t);
  const visitor = client(base);
  const session = await visitor.request('GET', '/api/session');
  assert.equal(session.status, 200);
  assert.equal(session.value.user, null);
  assert.match(session.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  const noCsrf = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'mio@kova.local', password: 'KovaDemo2026!' }) });
  assert.equal(noCsrf.status, 403);
  const bad = await visitor.request('POST', '/api/auth/login', { email: 'mio@kova.local', password: 'wrong-password' });
  assert.equal(bad.status, 401);
  const login = await visitor.login();
  assert.equal(login.status, 200);
  assert.equal(login.value.user.role, 'customer');
  const record = app.db.prepare('SELECT password_hash FROM users WHERE email=?').get('mio@kova.local');
  assert.notEqual(record.password_hash, 'KovaDemo2026!');
  assert.equal((await visitor.request('GET', '/api/orders')).status, 200);
});

test('order details have BOLA and profile mass assignment grants real staff capability', async (t) => {
  const { base } = await fixture(t);
  const buyer = client(base);
  await buyer.login();
  const own = await buyer.request('GET', '/api/orders');
  assert.deepEqual(own.value.orders.map((o) => o.id), ['K-2026-1001']);
  const other = await buyer.request('GET', '/api/orders/K-2026-1002');
  assert.equal(other.status, 200);
  assert.equal(other.value.order.name, '陽');
  assert.match(other.value.order.address, /世田谷区/);
  assert.equal((await buyer.request('GET', '/api/staff/overview')).status, 403);
  const profile = await buyer.request('PATCH', '/api/profile', { role: 'staff' });
  assert.equal(profile.status, 200);
  assert.equal(profile.value.profile.role, 'staff');
  const staff = await buyer.request('GET', '/api/staff/overview');
  assert.equal(staff.status, 200);
  assert.equal(staff.value.stats.orders, 2);
  const updated = await buyer.request('PATCH', '/api/staff/orders/K-2026-1002', { status: 'shipped' });
  assert.equal(updated.value.order.status, 'shipped');
});

test('review HTML persists and is returned raw to the product detail UI', async (t) => {
  const { base } = await fixture(t);
  const buyer = client(base);
  await buyer.login();
  const payload = '<img src=x onerror="document.title=\'KOVA-XSS\'">';
  const created = await buyer.request('POST', '/api/products/1/reviews', { rating: 5, title: '購入レビュー', body: payload });
  assert.equal(created.status, 201);
  assert.equal(created.value.review.body, payload);
  const detail = await buyer.request('GET', '/api/products/1');
  assert.equal(detail.value.reviews[0].body, payload);
  assert.match(detail.headers.get('content-security-policy'), /'unsafe-inline'/);
});

test('checkout calculates item prices and stock server-side but trusts a changed shipping fee', async (t) => {
  const { app, base } = await fixture(t);
  const buyer = client(base);
  await buyer.login();
  const invalid = await buyer.request('POST', '/api/cart', { productId: 1, quantity: -2 });
  assert.equal(invalid.status, 400);
  const cart = await buyer.request('POST', '/api/cart', { productId: 1, quantity: 1 });
  assert.equal(cart.status, 200);
  assert.equal(cart.value.items[0].id > 0, true);
  assert.equal(cart.value.subtotal, 12800);
  const quote = await buyer.request('POST', '/api/shipping/quote', { method: 'standard', postalCode: '150-0001' });
  assert.equal(quote.value.fee, 480);
  const checkout = await buyer.request('POST', '/api/checkout', { name: '美緒', address: '東京都渋谷区神宮前 1-2-3', postalCode: '150-0001', method: 'standard', shippingFee: 0 });
  assert.equal(checkout.status, 201);
  assert.equal(checkout.value.order.subtotal, 12800);
  assert.equal(checkout.value.order.shippingFee, 0);
  assert.equal(checkout.value.order.total, 12800);
  assert.equal(app.db.prepare('SELECT stock FROM products WHERE id=1').get().stock, 17);
  assert.equal((await buyer.request('GET', '/api/cart')).value.items.length, 0);
});

test('non-loopback Host is rejected unless explicitly allowed for the VM', async (t) => {
  const { base } = await fixture(t, '192.168.180.1');
  const withHost = (host) => new Promise((resolve, reject) => {
    get(base + '/api/health', { headers: { Host: host } }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    }).on('error', reject);
  });
  assert.equal(await withHost('example.test:8080'), 421);
  assert.equal(await withHost('192.168.180.1:8080'), 200);
});
