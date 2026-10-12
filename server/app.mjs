import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const sessionMaxAge = 12 * 60 * 60 * 1000;
const maxJsonBytes = 32 * 1024;
const loginWindowMs = 60 * 1000;
const loginFailureLimit = 5;
const accountCodeLifetimeMs = 10 * 60 * 1000;
const rewardTokenLifetimeMs = 10 * 60 * 1000;
const rewardOfferPoints = 500;
const integrationTokenLifetimeMs = 15 * 60 * 1000;
const returnCreditPoints = 250;
const receiptLinkLifetimeMs = 15 * 60 * 1000;
const receiptMaxAheadMs = 24 * 60 * 60 * 1000;
const previewMaxBytes = 4096;
const previewTimeoutMs = 1200;

const products = [
  { id: 1, slug: 'arc-table-lamp', name: 'ARC テーブルライト', category: '照明', price: 12800, stock: 18, image: '/images/arc-table-lamp.png', description: '曲線のアルミシェードが、デスクにやわらかな光を広げるテーブルライト。3段階の調光に対応。', featured: 1, accent: '#b39880', visible: 1 },
  { id: 2, slug: 'terra-desk-mat', name: 'TERRA デスクマット', category: 'デスク', price: 4800, stock: 32, image: '/images/terra-desk-mat.png', description: 'リサイクル素材と上質な手触りを両立した、日々の作業に寄り添うデスクマット。', featured: 1, accent: '#9d9b88', visible: 1 },
  { id: 3, slug: 'form-ceramic-mug', name: 'FORM セラミックマグ', category: 'キッチン', price: 3200, stock: 42, image: '/images/form-ceramic-mug.png', description: '飲み物の温度を手のひらで感じられる、穏やかなフォルムの磁器マグ。', featured: 1, accent: '#c5ae9b', visible: 1 },
  { id: 4, slug: 'linen-notebook', name: 'LINEN ノートブック', category: 'デスク', price: 2200, stock: 75, image: '/images/linen-notebook.png', description: 'リネン装の表紙と、書き心地のよい厚手の中性紙。毎日のアイデアを残す一冊。', featured: 0, accent: '#9fa9a0', visible: 1 },
  { id: 5, slug: 'orbit-speaker', name: 'ORBIT スピーカー', category: 'オーディオ', price: 19800, stock: 13, image: '/images/orbit-speaker.png', description: '空間になじむミニマルなワイヤレススピーカー。クリアな音をコンパクトな筐体から。', featured: 1, accent: '#6e756d', visible: 1 },
  { id: 6, slug: 'nest-storage-tray', name: 'NEST 収納トレー', category: '収納', price: 3900, stock: 27, image: '/images/nest-storage-tray.png', description: '鍵や小物の定位置になる、マットな質感のコンポジット素材のトレー。', featured: 0, accent: '#ac8d72', visible: 1 },
  { id: 7, slug: 'studio-prototype', name: 'STUDIO 試作モデル', category: '社内限定', price: 100, stock: 1, image: '', description: '社内確認用の未公開商品。CANARY-KOVA-PRODUCT-7', featured: 0, accent: '#9f776b', visible: 0 },
];

function json(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

function fail(res, status, message) {
  json(res, status, { error: message });
}

function publicUser(row) {
  if (!row) return null;
  return { id: row.id, name: row.name, email: row.email, role: row.role, address: row.address, bio: row.bio };
}

function publicProduct(row) {
  if (!row) return null;
  return { id: row.id, slug: row.slug, name: row.name, category: row.category, price: row.price, stock: row.stock, image: row.visible ? (row.image.startsWith('/images/') ? row.image : `/images/${row.slug}.png`) : '', description: row.description, featured: Boolean(row.featured), accent: row.accent };
}

function publicReview(row) {
  return { id: row.id, authorName: row.author_name, rating: row.rating, title: row.title, body: row.body, createdAt: row.created_at };
}

function publicReturnRequest(row) {
  if (!row) return null;
  return {
    id: row.id, orderId: row.order_id, status: row.status,
    creditPoints: row.credit_points, requestedAt: row.requested_at,
  };
}

function csvCell(value) {
  // CSV structure is escaped, but spreadsheet formulas remain active by design.
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

function passwordRecord(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function passwordMatches(password, row) {
  const candidate = scryptSync(password, row.password_salt, 64);
  const actual = Buffer.from(row.password_hash, 'hex');
  return actual.length === candidate.length && timingSafeEqual(actual, candidate);
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function trustedWidgetOrigin(origin, additionalHost) {
  if (typeof origin !== 'string') return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:' && parsed.origin === origin &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === additionalHost);
  } catch { return false; }
}

function initDb(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'kova.sqlite'));
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      password_salt TEXT NOT NULL, password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'customer', address TEXT NOT NULL DEFAULT '',
      bio TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      category TEXT NOT NULL, price INTEGER NOT NULL, stock INTEGER NOT NULL,
      image TEXT NOT NULL, description TEXT NOT NULL, featured INTEGER NOT NULL,
      accent TEXT NOT NULL, visible INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cart (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id),
      product_id INTEGER NOT NULL REFERENCES products(id), quantity INTEGER NOT NULL,
      UNIQUE(user_id, product_id)
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
      status TEXT NOT NULL, subtotal INTEGER NOT NULL, shipping_fee INTEGER NOT NULL,
      total INTEGER NOT NULL, created_at TEXT NOT NULL,
      name TEXT NOT NULL, address TEXT NOT NULL, postal_code TEXT NOT NULL, method TEXT NOT NULL,
      stock_reserved INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL REFERENCES orders(id),
      product_id INTEGER NOT NULL, name TEXT NOT NULL, quantity INTEGER NOT NULL, price INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id),
      product_id INTEGER NOT NULL REFERENCES products(id), rating INTEGER NOT NULL,
      title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS password_codes (
      code_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
      expires_at INTEGER NOT NULL, used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS reward_balances (
      user_id INTEGER PRIMARY KEY REFERENCES users(id), points INTEGER NOT NULL DEFAULT 0,
      campaign_redeemed INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS reward_tokens (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
      points INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS app_secrets (
      name TEXT PRIMARY KEY, value BLOB NOT NULL CHECK(length(value)=32)
    );
    CREATE TABLE IF NOT EXISTS api_tokens (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
      scope TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS api_tokens_user_expiry ON api_tokens(user_id,expires_at);
    CREATE TABLE IF NOT EXISTS return_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      status TEXT NOT NULL, credit_points INTEGER NOT NULL,
      requested_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS product_private (
      product_id INTEGER PRIMARY KEY REFERENCES products(id),
      supplier_cost INTEGER NOT NULL, internal_note TEXT NOT NULL
    );
  `);
  if (!db.prepare('PRAGMA table_info(orders)').all().some((column) => column.name === 'stock_reserved')) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('ALTER TABLE orders ADD COLUMN stock_reserved INTEGER NOT NULL DEFAULT 0');
      // Before this migration, only the two fixed demonstration orders bypassed checkout's stock decrement.
      db.prepare(`UPDATE orders SET stock_reserved=1 WHERE NOT
        ((id='K-2026-1001' AND created_at='2026-09-21T11:20:00.000Z') OR
         (id='K-2026-1002' AND created_at='2026-10-02T09:35:00.000Z'))`).run();
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  if (db.prepare('SELECT COUNT(*) AS n FROM products').get().n === 0) {
    const put = db.prepare('INSERT INTO products (id,slug,name,category,price,stock,image,description,featured,accent,visible) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    for (const product of products) put.run(product.id, product.slug, product.name, product.category, product.price, product.stock, product.image, product.description, product.featured, product.accent, product.visible);
  }
  const putPrivate = db.prepare('INSERT OR IGNORE INTO product_private (product_id,supplier_cost,internal_note) VALUES (?,?,?)');
  for (const product of products.filter((item) => item.visible)) {
    putPrivate.run(product.id, Math.floor(product.price * 0.54),
      product.id === 1 ? 'CANARY-KOVA-SUPPLY-ARC-27 / 社内仕入れメモ' : `${product.slug} / 社内仕入れメモ`);
  }
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
    const put = db.prepare('INSERT INTO users (name,email,password_salt,password_hash,role,address,bio,created_at) VALUES (?,?,?,?,?,?,?,?)');
    for (const [name, email, password, address] of [
      ['美緒', 'mio@kova.local', 'KovaDemo2026!', '東京都渋谷区神宮前 1-2-3'],
      ['陽', 'haru@kova.local', 'KovaDemo2026!', '東京都世田谷区北沢 4-5-6'],
    ]) {
      const { salt, hash } = passwordRecord(password);
      put.run(name, email, salt, hash, 'customer', address, '', new Date().toISOString());
    }
  }
  if (db.prepare('SELECT COUNT(*) AS n FROM orders').get().n === 0) {
    const mio = db.prepare('SELECT id FROM users WHERE email=?').get('mio@kova.local')?.id;
    const haru = db.prepare('SELECT id FROM users WHERE email=?').get('haru@kova.local')?.id;
    if (mio && haru) {
      const put = db.prepare('INSERT INTO orders (id,user_id,status,subtotal,shipping_fee,total,created_at,name,address,postal_code,method) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
      put.run('K-2026-1001', mio, 'delivered', 12800, 480, 13280, '2026-09-21T11:20:00.000Z', '美緒', '東京都渋谷区神宮前 1-2-3', '150-0001', 'standard');
      put.run('K-2026-1002', haru, 'processing', 19800, 980, 20780, '2026-10-02T09:35:00.000Z', '陽', '東京都世田谷区北沢 4-5-6', '155-0031', 'express');
      const item = db.prepare('INSERT INTO order_items (order_id,product_id,name,quantity,price) VALUES (?,?,?,?,?)');
      item.run('K-2026-1001', 1, 'ARC テーブルライト', 1, 12800);
      item.run('K-2026-1002', 5, 'ORBIT スピーカー', 1, 19800);
    }
  }
  return db;
}

function initCatalog(db) {
  // The deliberately vulnerable search runs only against this disposable, product-only database.
  // No users, sessions, carts, orders, or writable persistent tables are attached to it.
  const searchDb = new DatabaseSync(':memory:');
  searchDb.exec('CREATE TABLE catalog (product_id INTEGER, name TEXT, summary TEXT, visible INTEGER)');
  const put = searchDb.prepare('INSERT INTO catalog (product_id,name,summary,visible) VALUES (?,?,?,?)');
  for (const p of db.prepare('SELECT id,name,description,visible FROM products').all()) put.run(p.id, p.name, p.description, p.visible);
  return searchDb;
}

function cookieValue(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return null;
}

function secureEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function validHost(header, additionalHost) {
  if (typeof header !== 'string' || !/^[a-zA-Z0-9.:[\]-]+$/.test(header)) return false;
  let hostname;
  try { hostname = new URL(`http://${header}`).hostname.toLowerCase(); } catch { return false; }
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === additionalHost;
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxJsonBytes) {
      const error = new Error('入力が長すぎます');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    const error = new Error('JSON形式の入力が必要です');
    error.status = 400;
    throw error;
  }
}

function textField(value, max, label, { optional = false } = {}) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string') throw Object.assign(new Error(`${label}を入力してください`), { status: 400 });
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) throw Object.assign(new Error(`${label}は1〜${max}文字で入力してください`), { status: 400 });
  return trimmed;
}

function optionalText(value, max, label) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max) throw Object.assign(new Error(`${label}は${max}文字以内で入力してください`), { status: 400 });
  return value.trim();
}

function cartState(db, userId) {
  const rows = db.prepare(`SELECT c.id AS cart_id,c.product_id,c.quantity,p.* FROM cart c JOIN products p ON p.id=c.product_id WHERE c.user_id=? ORDER BY c.id`).all(userId);
  const items = rows.map((row) => ({ id: row.cart_id, productId: row.product_id, quantity: row.quantity, product: publicProduct(row) }));
  return { items, subtotal: items.reduce((sum, item) => sum + item.quantity * item.product.price, 0) };
}

function rewardSummary(db, userId) {
  const row = db.prepare('SELECT points,campaign_redeemed FROM reward_balances WHERE user_id=?').get(userId);
  return { points: row?.points ?? 0, campaignRedeemed: Boolean(row?.campaign_redeemed) };
}

function orderRecord(db, id) {
  const row = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!row) return null;
  const items = db.prepare('SELECT product_id AS productId,name,quantity,price FROM order_items WHERE order_id=? ORDER BY id').all(id);
  return { id: row.id, status: row.status, subtotal: row.subtotal, shippingFee: row.shipping_fee, total: row.total, createdAt: row.created_at, name: row.name, address: row.address, postalCode: row.postal_code, method: row.method, items };
}

function returnRequestRecord(db, id) {
  return publicReturnRequest(db.prepare('SELECT * FROM return_requests WHERE id=?').get(id));
}

function cancelOrder(db, id, { ownerId = null } = {}) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = ownerId === null
      ? db.prepare('SELECT status,stock_reserved FROM orders WHERE id=?').get(id)
      : db.prepare('SELECT status,stock_reserved FROM orders WHERE id=? AND user_id=?').get(id, ownerId);
    if (!row) throw Object.assign(new Error('注文が見つかりません'), { status: 404 });
    if (row.status !== 'processing') {
      throw Object.assign(new Error('この注文はキャンセルできません'), { status: 409 });
    }
    const changed = db.prepare("UPDATE orders SET status='cancelled',stock_reserved=0 WHERE id=? AND status='processing'")
      .run(id);
    if (changed.changes !== 1) throw Object.assign(new Error('この注文はキャンセルできません'), { status: 409 });
    if (row.stock_reserved === 1) {
      const items = db.prepare('SELECT product_id,quantity FROM order_items WHERE order_id=?').all(id);
      const restore = db.prepare('UPDATE products SET stock=stock+? WHERE id=?');
      for (const item of items) {
        if (restore.run(item.quantity, item.product_id).changes !== 1) throw new Error('在庫を更新できません');
      }
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return orderRecord(db, id);
}

function serveStatic(res, pathname) {
  if (!existsSync(webRoot)) return fail(res, 404, 'ページが見つかりません');
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return fail(res, 400, '無効なURLです'); }
  const requested = decoded === '/' ? 'index.html' : decoded.slice(1);
  const candidate = resolve(webRoot, requested);
  if (candidate !== webRoot && !candidate.startsWith(webRoot + sep)) return fail(res, 404, 'ページが見つかりません');
  let path = candidate;
  if (!existsSync(path) || !statSync(path).isFile()) path = join(webRoot, 'index.html');
  if (!existsSync(path)) return fail(res, 404, 'ページが見つかりません');
  const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon' }[extname(path)] || 'application/octet-stream';
  const body = readFileSync(path);
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': path.endsWith('index.html') ? 'no-store' : 'public, max-age=3600' });
  res.end(body);
}

export function createApplication({ dataDir = join(process.cwd(), 'data'), additionalHost = process.env.ADDITIONAL_HOST || '' } = {}) {
  if (additionalHost && !isIP(additionalHost)) throw new Error('additionalHost must be a literal IP address');
  const db = initDb(dataDir);
  db.prepare('INSERT OR IGNORE INTO app_secrets (name,value) VALUES (?,?)').run('receipt_hmac_v1', randomBytes(32));
  const storedReceiptKey = db.prepare('SELECT value FROM app_secrets WHERE name=?').get('receipt_hmac_v1')?.value;
  if (!(storedReceiptKey instanceof Uint8Array) || storedReceiptKey.length !== 32) throw new Error('Receipt signing key is invalid');
  const receiptSigningKey = Buffer.from(storedReceiptKey);
  const catalog = initCatalog(db);
  const sessions = new Map();
  const failedLogins = new Map();
  let loginChecks = 0;
  let overviewCache = null;
  let closed = false;

  function receiptSignature(id) {
    // VULNERABLE: the expiry value is left out of the signed message.
    return createHmac('sha256', receiptSigningKey).update(`receipt:${id}`).digest('hex');
  }

  function bearerPrincipal(req) {
    const authorization = req.headers.authorization;
    const match = typeof authorization === 'string' ? authorization.match(/^Bearer ([A-Za-z0-9_-]{43})$/i) : null;
    if (!match) return null;
    const row = db.prepare(`SELECT t.scope,t.expires_at,u.id,u.name,u.email,u.address
      FROM api_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=?`).get(tokenHash(match[1]));
    return row && row.expires_at > Date.now() ? row : null;
  }

  function loginKey(req, email) {
    // Deliberately trusts a syntactically valid, user-supplied proxy header.
    const header = typeof req.headers['x-real-ip'] === 'string' ? req.headers['x-real-ip'].trim() : '';
    const ip = isIP(header) ? header : (req.socket.remoteAddress || 'unknown');
    return `${email}\0${ip}`;
  }

  function recentLoginFailures(key, now) {
    const recent = (failedLogins.get(key) || []).filter((time) => now - time < loginWindowMs);
    if (recent.length) failedLogins.set(key, recent);
    else failedLogins.delete(key);
    if (++loginChecks % 64 === 0) {
      for (const [otherKey, times] of failedLogins) {
        const active = times.filter((time) => now - time < loginWindowMs);
        if (active.length) failedLogins.set(otherKey, active);
        else failedLogins.delete(otherKey);
      }
    }
    return recent;
  }

  function recordLoginFailure(key, attempts, now) {
    failedLogins.delete(key);
    failedLogins.set(key, [...attempts, now]);
    // Keep the per-process limiter bounded even when clients vary headers and emails.
    while (failedLogins.size > 2048) failedLogins.delete(failedLogins.keys().next().value);
  }

  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    // The review HTML surface intentionally remains executable for the stored-XSS exercise.
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'self'; object-src 'none'");
    if (!validHost(req.headers.host, additionalHost)) return fail(res, 421, '許可されていないホストです');
    let url;
    try { url = new URL(req.url, `http://${req.headers.host}`); } catch { return fail(res, 400, '無効なURLです'); }
    const pathname = url.pathname;
    if (req.method === 'GET' && pathname === '/api/health') return json(res, 200, { status: 'ok', service: 'kova-store' });
    if (req.method === 'GET' && pathname === '/_media/notes') {
      return json(res, 200, { title: 'KOVA 編集ノート', summary: '新着商品と季節のおすすめを紹介します。' });
    }
    if (req.method === 'GET' && pathname === '/_internal/supplier-note') {
      if (!isLoopback(req.socket.remoteAddress)) return fail(res, 403, 'この操作はできません');
      return json(res, 200, { title: '仕入れ先向けメモ', summary: 'CANARY-KOVA-SUPPLIER-Q4-PRICING' });
    }
    const receiptMatch = pathname.match(/^\/api\/receipts\/(K-\d{4}-\d+)$/);
    if (req.method === 'GET' && receiptMatch) {
      const expiresText = url.searchParams.get('expires');
      const signature = url.searchParams.get('sig');
      const expires = expiresText && /^\d{1,16}$/.test(expiresText) ? Number(expiresText) : NaN;
      const now = Date.now();
      if (!Number.isSafeInteger(expires) || expires <= now || expires > now + receiptMaxAheadMs ||
          typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature) ||
          !secureEquals(signature, receiptSignature(receiptMatch[1]))) {
        return fail(res, 403, '領収書リンクを利用できません');
      }
      const order = orderRecord(db, receiptMatch[1]);
      if (!order) return fail(res, 404, '注文が見つかりません');
      return json(res, 200, {
        receipt: {
          id: order.id, createdAt: order.createdAt, name: order.name, address: order.address,
          postalCode: order.postalCode, items: order.items, total: order.total,
        },
      });
    }
    if (!pathname.startsWith('/api/')) {
      if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(res, pathname);
      return fail(res, 405, 'この操作はできません');
    }

    let sid = cookieValue(req, 'kova_sid');
    let session = sid ? sessions.get(sid) : null;
    if (session && session.expires < Date.now()) { sessions.delete(sid); session = null; }
    if (!session && req.method === 'GET' && pathname === '/api/session') {
      sid = randomBytes(32).toString('base64url');
      session = { userId: null, csrf: randomBytes(32).toString('base64url'), expires: Date.now() + sessionMaxAge };
      sessions.set(sid, session);
      res.setHeader('Set-Cookie', `kova_sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`);
    }
    const user = session?.userId ? db.prepare('SELECT * FROM users WHERE id=?').get(session.userId) : null;
    if (req.method === 'GET' && pathname === '/api/session') return json(res, 200, { user: publicUser(user), csrfToken: session.csrf });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && (!session || !secureEquals(req.headers['x-csrf-token'], session.csrf))) return fail(res, 403, 'セッションを更新してから再度お試しください');

    try {
      if (req.method === 'POST' && pathname === '/api/auth/register') {
        const body = await readJson(req);
        const name = textField(body.name, 80, 'お名前');
        const email = textField(body.email, 160, 'メールアドレス').toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, 400, 'メールアドレスの形式を確認してください');
        const password = textField(body.password, 128, 'パスワード');
        if (password.length < 10) return fail(res, 400, 'パスワードは10文字以上にしてください');
        if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) return fail(res, 409, 'このメールアドレスは登録済みです');
        const { salt, hash } = passwordRecord(password);
        const result = db.prepare('INSERT INTO users (name,email,password_salt,password_hash,role,address,bio,created_at) VALUES (?,?,?,?,?,?,?,?)').run(name, email, salt, hash, 'customer', '', '', new Date().toISOString());
        sessions.delete(sid);
        sid = randomBytes(32).toString('base64url');
        session = { userId: Number(result.lastInsertRowid), csrf: randomBytes(32).toString('base64url'), expires: Date.now() + sessionMaxAge };
        sessions.set(sid, session);
        res.setHeader('Set-Cookie', `kova_sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`);
        return json(res, 201, { user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(session.userId)), csrfToken: session.csrf });
      }
      if (req.method === 'POST' && pathname === '/api/auth/login') {
        const body = await readJson(req);
        const email = textField(body.email, 160, 'メールアドレス').toLowerCase();
        const password = textField(body.password, 128, 'パスワード');
        const key = loginKey(req, email);
        const now = Date.now();
        const attempts = recentLoginFailures(key, now);
        if (attempts.length >= loginFailureLimit) {
          res.setHeader('Retry-After', String(Math.ceil((attempts[0] + loginWindowMs - now) / 1000)));
          return fail(res, 429, 'ログイン試行が多すぎます。時間をおいて再度お試しください');
        }
        const candidate = db.prepare('SELECT * FROM users WHERE email=?').get(email);
        if (!candidate || !passwordMatches(password, candidate)) {
          recordLoginFailure(key, attempts, now);
          return fail(res, 401, 'メールアドレスまたはパスワードが違います');
        }
        failedLogins.delete(key);
        sessions.delete(sid);
        sid = randomBytes(32).toString('base64url');
        session = { userId: candidate.id, csrf: randomBytes(32).toString('base64url'), expires: Date.now() + sessionMaxAge };
        sessions.set(sid, session);
        res.setHeader('Set-Cookie', `kova_sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`);
        return json(res, 200, { user: publicUser(candidate), csrfToken: session.csrf });
      }
      if (req.method === 'POST' && pathname === '/api/auth/logout') {
        sessions.delete(sid);
        res.setHeader('Set-Cookie', 'kova_sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
        return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && pathname === '/api/products') {
        const q = url.searchParams.get('q') ?? '';
        const category = url.searchParams.get('category') ?? '';
        if (q.length > 120 || category.length > 80) return fail(res, 400, '検索条件が長すぎます');
        let rows;
        if (q.trim()) {
          let ids;
          try {
            // VULNERABLE: q is interpolated into SQL, but only in the disposable product catalog.
            ids = catalog.prepare(`SELECT product_id FROM catalog WHERE visible=1 AND (name LIKE '%${q}%' OR summary LIKE '%${q}%') LIMIT 24`).all().map((row) => row.product_id);
          } catch { return fail(res, 400, '検索条件を解釈できませんでした'); }
          rows = ids.length ? db.prepare(`SELECT * FROM products WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) : [];
        } else {
          rows = db.prepare('SELECT * FROM products WHERE visible=1 ORDER BY id').all();
        }
        if (category) rows = rows.filter((row) => row.category === category);
        const categories = db.prepare('SELECT DISTINCT category FROM products WHERE visible=1 ORDER BY category').all().map((row) => row.category);
        return json(res, 200, { products: rows.map(publicProduct), categories });
      }
      const productMatch = pathname.match(/^\/api\/products\/(\d+)$/);
      if (req.method === 'GET' && productMatch) {
        const product = db.prepare('SELECT * FROM products WHERE id=? AND visible=1').get(Number(productMatch[1]));
        if (!product) return fail(res, 404, '商品が見つかりません');
        const reviews = db.prepare('SELECT r.*,u.name AS author_name FROM reviews r JOIN users u ON u.id=r.user_id WHERE r.product_id=? ORDER BY r.id DESC LIMIT 100').all(product.id).map(publicReview);
        const privateData = db.prepare('SELECT supplier_cost,internal_note FROM product_private WHERE product_id=?').get(product.id);
        // VULNERABLE: the public detail serializer includes internal supply properties.
        return json(res, 200, {
          product: {
            ...publicProduct(product),
            supply: privateData ? { supplierCost: privateData.supplier_cost, internalNote: privateData.internal_note } : null,
          },
          reviews,
        });
      }
      if (req.method === 'GET' && pathname === '/api/integrations/catalog') {
        const principal = bearerPrincipal(req);
        if (!principal || principal.scope !== 'catalog:read') return fail(res, 401, 'APIトークンを確認してください');
        const rows = db.prepare('SELECT id,name,category,price,stock FROM products WHERE visible=1 ORDER BY id LIMIT 50').all();
        return json(res, 200, { products: rows });
      }
      if (req.method === 'GET' && pathname === '/api/integrations/account') {
        const principal = bearerPrincipal(req);
        if (!principal) return fail(res, 401, 'APIトークンを確認してください');
        // VULNERABLE: this endpoint checks token validity and subject, but omits the catalog:read scope check.
        return json(res, 200, { member: { name: principal.name, email: principal.email, address: principal.address } });
      }
      if (!user) return fail(res, 401, 'ログインしてください');

      if (req.method === 'POST' && pathname === '/api/integrations/tokens') {
        const body = await readJson(req);
        if (body.scope !== undefined && body.scope !== 'catalog:read') return fail(res, 400, 'スコープを確認してください');
        const now = Date.now();
        db.prepare('DELETE FROM api_tokens WHERE expires_at<=?').run(now);
        const count = db.prepare('SELECT COUNT(*) AS n FROM api_tokens WHERE user_id=?').get(user.id).n;
        if (count >= 5) return fail(res, 409, '有効なAPIトークンの上限に達しています');
        const token = randomBytes(32).toString('base64url');
        const expiresAtMs = now + integrationTokenLifetimeMs;
        db.prepare('INSERT INTO api_tokens (token_hash,user_id,scope,expires_at) VALUES (?,?,?,?)')
          .run(tokenHash(token), user.id, 'catalog:read', expiresAtMs);
        return json(res, 201, { token, scope: 'catalog:read', expiresAt: new Date(expiresAtMs).toISOString() });
      }

      if (req.method === 'GET' && pathname === '/api/account/widget') {
        const origin = req.headers.origin;
        res.setHeader('Vary', 'Origin');
        if (trustedWidgetOrigin(origin, additionalHost)) {
          // VULNERABLE: every port on an approved local hostname may read this private widget with credentials.
          res.setHeader('Access-Control-Allow-Origin', origin);
          res.setHeader('Access-Control-Allow-Credentials', 'true');
        }
        const latest = db.prepare('SELECT id,status FROM orders WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 1').get(user.id);
        return json(res, 200, {
          member: { name: user.name, email: user.email, address: user.address },
          latestOrder: latest ? { id: latest.id, status: latest.status } : null,
        });
      }
      if (req.method === 'POST' && pathname === '/api/links/preview') {
        const body = await readJson(req);
        const path = textField(body.path, 120, 'プレビュー対象');
        if (!path.startsWith('/') || path.includes('//') || path.includes('\\') ||
            path.includes('?') || path.includes('#') || /[\u0000-\u001f\u007f]/.test(path)) {
          return fail(res, 400, 'プレビュー対象のパスを確認してください');
        }
        const address = server.address();
        if (!address || typeof address === 'string') return fail(res, 503, 'プレビューを利用できません');
        const base = `http://127.0.0.1:${address.port}`;
        const destination = new URL(path, base);
        if (destination.origin !== base) return fail(res, 400, 'プレビュー対象のパスを確認してください');
        try {
          // VULNERABLE: the first-party URL is constrained, but its internal path is not authorized.
          const response = await fetch(destination, {
            method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(previewTimeoutMs),
            headers: { Accept: 'application/json' },
          });
          if (!response.ok || !response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
            await response.body?.cancel();
            return fail(res, 502, 'プレビューを取得できません');
          }
          const reader = response.body?.getReader();
          if (!reader) return fail(res, 502, 'プレビューを取得できません');
          let size = 0;
          const chunks = [];
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > previewMaxBytes) {
                await reader.cancel();
                return fail(res, 502, 'プレビューの応答が長すぎます');
              }
              chunks.push(Buffer.from(value));
            }
          } finally {
            reader.releaseLock();
          }
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
              typeof parsed.title !== 'string' || typeof parsed.summary !== 'string') {
            return fail(res, 502, 'プレビューを取得できません');
          }
          return json(res, 200, { preview: { title: parsed.title, summary: parsed.summary } });
        } catch { return fail(res, 502, 'プレビューを取得できません'); }
      }
      if (req.method === 'GET' && pathname === '/api/account/overview') {
        const now = Date.now();
        const hit = overviewCache && overviewCache.expires > now;
        if (!hit) {
          const latest = db.prepare('SELECT id,status,name,address,postal_code FROM orders WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 1').get(user.id);
          // VULNERABLE: this short-lived application cache has no user-specific key.
          overviewCache = {
            expires: now + 10 * 1000,
            value: {
              member: { id: user.id, name: user.name, email: user.email, address: user.address },
              latestOrder: latest ? { id: latest.id, status: latest.status, name: latest.name, address: latest.address, postalCode: latest.postal_code } : null,
            },
          };
        }
        return json(res, 200, overviewCache.value, { 'X-Cache': hit ? 'HIT' : 'MISS' });
      }
      if (req.method === 'POST' && pathname === '/api/account/password-code') {
        const code = randomBytes(32).toString('base64url');
        const expiresAtMs = Date.now() + accountCodeLifetimeMs;
        db.prepare('DELETE FROM password_codes WHERE expires_at<=? OR used_at IS NOT NULL').run(Date.now());
        db.prepare('INSERT INTO password_codes (code_hash,user_id,expires_at,used_at) VALUES (?,?,?,NULL)').run(tokenHash(code), user.id, expiresAtMs);
        // Local training delivery: no email provider or outbound connection exists.
        return json(res, 200, { code, expiresAt: new Date(expiresAtMs).toISOString() });
      }
      if (req.method === 'POST' && pathname === '/api/account/password') {
        const body = await readJson(req);
        const email = textField(body.email, 160, 'メールアドレス').toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, 400, 'メールアドレスの形式を確認してください');
        const code = textField(body.code, 128, '確認コード');
        const newPassword = textField(body.newPassword, 128, '新しいパスワード');
        if (newPassword.length < 10) return fail(res, 400, 'パスワードは10文字以上にしてください');
        const codeRow = db.prepare('SELECT user_id,expires_at,used_at FROM password_codes WHERE code_hash=?').get(tokenHash(code));
        if (!codeRow || codeRow.user_id !== user.id || codeRow.used_at !== null || codeRow.expires_at <= Date.now()) return fail(res, 400, '確認コードを利用できません');
        const target = db.prepare('SELECT id FROM users WHERE email=?').get(email);
        if (!target) return fail(res, 400, '確認コードを利用できません');
        const { salt, hash } = passwordRecord(newPassword);
        db.exec('BEGIN IMMEDIATE');
        try {
          const used = db.prepare('UPDATE password_codes SET used_at=? WHERE code_hash=? AND used_at IS NULL AND expires_at>?').run(Date.now(), tokenHash(code), Date.now());
          if (used.changes !== 1) throw Object.assign(new Error('確認コードを利用できません'), { status: 400 });
          // VULNERABLE: the code owner is authenticated, but not bound to the target email.
          db.prepare('UPDATE users SET password_salt=?,password_hash=? WHERE id=?').run(salt, hash, target.id);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        for (const [sessionId, active] of sessions) if (active.userId === target.id) sessions.delete(sessionId);
        if (target.id === user.id) res.setHeader('Set-Cookie', 'kova_sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
        return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && pathname === '/api/rewards/summary') return json(res, 200, rewardSummary(db, user.id));
      if (req.method === 'POST' && pathname === '/api/rewards/offer') {
        if (rewardSummary(db, user.id).campaignRedeemed) return fail(res, 409, 'この特典は受け取り済みです');
        const token = randomBytes(32).toString('base64url');
        const expiresAtMs = Date.now() + rewardTokenLifetimeMs;
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('INSERT INTO reward_balances (user_id,points,campaign_redeemed) VALUES (?,0,0) ON CONFLICT(user_id) DO NOTHING').run(user.id);
          db.prepare('DELETE FROM reward_tokens WHERE user_id=? AND used_at IS NULL').run(user.id);
          db.prepare('INSERT INTO reward_tokens (token_hash,user_id,points,expires_at,used_at) VALUES (?,?,?,?,NULL)').run(tokenHash(token), user.id, rewardOfferPoints, expiresAtMs);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        return json(res, 200, { token, points: rewardOfferPoints, expiresAt: new Date(expiresAtMs).toISOString() });
      }
      if (req.method === 'POST' && pathname === '/api/rewards/claim') {
        const body = await readJson(req);
        const token = textField(body.token, 128, '特典コード');
        const hash = tokenHash(token);
        const row = db.prepare('SELECT user_id,points,expires_at,used_at FROM reward_tokens WHERE token_hash=?').get(hash);
        if (!row || row.user_id !== user.id || row.used_at !== null || row.expires_at <= Date.now() || rewardSummary(db, user.id).campaignRedeemed) return fail(res, 409, '特典コードを利用できません');
        // VULNERABLE: both requests may pass the check before either one credits the balance.
        await delay(35);
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('UPDATE reward_balances SET points=points+?,campaign_redeemed=1 WHERE user_id=?').run(row.points, user.id);
          db.prepare('UPDATE reward_tokens SET used_at=? WHERE token_hash=?').run(Date.now(), hash);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        return json(res, 200, { points: rewardSummary(db, user.id).points, credited: row.points });
      }

      if (req.method === 'GET' && pathname === '/api/cart') return json(res, 200, cartState(db, user.id));
      if (req.method === 'POST' && pathname === '/api/cart') {
        const body = await readJson(req);
        const productId = Number(body.productId);
        const quantity = Number(body.quantity);
        if (!Number.isSafeInteger(productId) || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 20) return fail(res, 400, '数量を確認してください');
        const product = db.prepare('SELECT * FROM products WHERE id=? AND visible=1').get(productId);
        if (!product) return fail(res, 404, '商品が見つかりません');
        const previous = db.prepare('SELECT quantity FROM cart WHERE user_id=? AND product_id=?').get(user.id, productId)?.quantity ?? 0;
        if (previous + quantity > product.stock || previous + quantity > 20) return fail(res, 409, '在庫数を超えています');
        db.prepare('INSERT INTO cart (user_id,product_id,quantity) VALUES (?,?,?) ON CONFLICT(user_id,product_id) DO UPDATE SET quantity=quantity+excluded.quantity').run(user.id, productId, quantity);
        return json(res, 200, cartState(db, user.id));
      }
      const cartMatch = pathname.match(/^\/api\/cart\/(\d+)$/);
      if (cartMatch && req.method === 'PATCH') {
        const body = await readJson(req);
        const quantity = Number(body.quantity);
        if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 20) return fail(res, 400, '数量を確認してください');
        const row = db.prepare('SELECT c.*,p.stock FROM cart c JOIN products p ON p.id=c.product_id WHERE c.id=? AND c.user_id=?').get(Number(cartMatch[1]), user.id);
        if (!row) return fail(res, 404, 'カートの商品が見つかりません');
        if (quantity > row.stock) return fail(res, 409, '在庫数を超えています');
        db.prepare('UPDATE cart SET quantity=? WHERE id=? AND user_id=?').run(quantity, row.id, user.id);
        return json(res, 200, cartState(db, user.id));
      }
      if (cartMatch && req.method === 'DELETE') {
        db.prepare('DELETE FROM cart WHERE id=? AND user_id=?').run(Number(cartMatch[1]), user.id);
        return json(res, 200, cartState(db, user.id));
      }
      if (req.method === 'POST' && pathname === '/api/shipping/quote') {
        const body = await readJson(req);
        if (!['standard', 'express'].includes(body.method)) return fail(res, 400, '配送方法を確認してください');
        const postalCode = textField(body.postalCode, 16, '郵便番号');
        return json(res, 200, { method: body.method, postalCode, fee: body.method === 'express' ? 980 : 480 });
      }
      if (req.method === 'POST' && pathname === '/api/checkout') {
        const body = await readJson(req);
        const name = textField(body.name, 80, 'お名前');
        const address = textField(body.address, 240, '住所');
        const postalCode = textField(body.postalCode, 16, '郵便番号');
        const method = body.method;
        if (!['standard', 'express'].includes(method)) return fail(res, 400, '配送方法を確認してください');
        const shippingFee = body.shippingFee;
        if (!Number.isSafeInteger(shippingFee) || shippingFee < 0 || shippingFee > 5000) return fail(res, 400, '送料を確認してください');
        const { items, subtotal } = cartState(db, user.id);
        if (!items.length) return fail(res, 400, 'カートに商品がありません');
        for (const item of items) if (item.quantity > item.product.stock) return fail(res, 409, '在庫数が変更されました');
        // VULNERABLE: checkout reuses the client-provided quote, not a server-calculated fee.
        const orderId = `K-${new Date().getUTCFullYear()}-${1001 + Number(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n)}`;
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('INSERT INTO orders (id,user_id,status,subtotal,shipping_fee,total,created_at,name,address,postal_code,method,stock_reserved) VALUES (?,?,?,?,?,?,?,?,?,?,?,1)').run(orderId, user.id, 'processing', subtotal, shippingFee, subtotal + shippingFee, new Date().toISOString(), name, address, postalCode, method);
          const put = db.prepare('INSERT INTO order_items (order_id,product_id,name,quantity,price) VALUES (?,?,?,?,?)');
          const stock = db.prepare('UPDATE products SET stock=stock-? WHERE id=? AND stock>=?');
          for (const item of items) {
            put.run(orderId, item.productId, item.product.name, item.quantity, item.product.price);
            if (stock.run(item.quantity, item.productId, item.quantity).changes !== 1) throw Object.assign(new Error('在庫数が変更されました'), { status: 409 });
          }
          db.prepare('DELETE FROM cart WHERE user_id=?').run(user.id);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        return json(res, 201, { order: orderRecord(db, orderId) });
      }
      const settleMatch = pathname.match(/^\/api\/returns\/(\d+)\/settle$/);
      if (req.method === 'POST' && settleMatch) {
        const returnId = Number(settleMatch[1]);
        if (!Number.isSafeInteger(returnId)) return fail(res, 404, '返品申請が見つかりません');
        db.exec('BEGIN IMMEDIATE');
        try {
          const current = db.prepare('SELECT user_id,status,credit_points FROM return_requests WHERE id=? AND user_id=?')
            .get(returnId, user.id);
          if (!current) throw Object.assign(new Error('返品申請が見つかりません'), { status: 404 });
          if (current.status === 'settled') throw Object.assign(new Error('この返品申請は処理済みです'), { status: 409 });
          // VULNERABLE: pending requests can be credited before staff approval.
          const changed = db.prepare("UPDATE return_requests SET status='settled' WHERE id=? AND user_id=? AND status IN ('pending','approved')")
            .run(returnId, user.id);
          if (changed.changes !== 1) throw Object.assign(new Error('この返品申請は処理できません'), { status: 409 });
          db.prepare('INSERT INTO reward_balances (user_id,points,campaign_redeemed) VALUES (?,0,0) ON CONFLICT(user_id) DO NOTHING')
            .run(user.id);
          db.prepare('UPDATE reward_balances SET points=points+? WHERE user_id=?').run(current.credit_points, user.id);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        return json(res, 200, { returnRequest: returnRequestRecord(db, returnId), points: rewardSummary(db, user.id).points });
      }
      if (req.method === 'GET' && pathname === '/api/orders') {
        const ids = db.prepare('SELECT id FROM orders WHERE user_id=? ORDER BY created_at DESC').all(user.id);
        return json(res, 200, { orders: ids.map((row) => orderRecord(db, row.id)) });
      }
      const returnsMatch = pathname.match(/^\/api\/orders\/(K-\d{4}-\d+)\/returns$/);
      if (req.method === 'POST' && returnsMatch) {
        const id = returnsMatch[1];
        const order = db.prepare('SELECT id,status FROM orders WHERE id=? AND user_id=?').get(id, user.id);
        if (!order) return fail(res, 404, '注文が見つかりません');
        if (order.status !== 'delivered') return fail(res, 409, 'この注文は返品申請できません');
        const result = db.prepare(`INSERT OR IGNORE INTO return_requests
          (order_id,user_id,status,credit_points,requested_at) VALUES (?,?,'pending',?,?)`)
          .run(id, user.id, returnCreditPoints, new Date().toISOString());
        if (result.changes !== 1) return fail(res, 409, 'この注文は返品申請済みです');
        return json(res, 201, { returnRequest: returnRequestRecord(db, Number(result.lastInsertRowid)) });
      }
      const orderReturnMatch = pathname.match(/^\/api\/orders\/(K-\d{4}-\d+)\/return$/);
      if (req.method === 'GET' && orderReturnMatch) {
        const id = orderReturnMatch[1];
        const owned = db.prepare('SELECT 1 FROM orders WHERE id=? AND user_id=?').get(id, user.id);
        if (!owned) return fail(res, 404, '注文が見つかりません');
        const request = db.prepare('SELECT * FROM return_requests WHERE order_id=? AND user_id=?').get(id, user.id);
        return json(res, 200, { returnRequest: publicReturnRequest(request) });
      }
      const receiptLinkMatch = pathname.match(/^\/api\/orders\/(K-\d{4}-\d+)\/receipt-link$/);
      if (req.method === 'POST' && receiptLinkMatch) {
        const id = receiptLinkMatch[1];
        const owned = db.prepare('SELECT 1 FROM orders WHERE id=? AND user_id=?').get(id, user.id);
        if (!owned) return fail(res, 404, '注文が見つかりません');
        const expires = Date.now() + receiptLinkLifetimeMs;
        const signature = receiptSignature(id);
        return json(res, 200, {
          url: `/api/receipts/${id}?expires=${expires}&sig=${signature}`,
          expiresAt: new Date(expires).toISOString(),
        });
      }
      const cancelMatch = pathname.match(/^\/api\/orders\/(K-\d{4}-\d+)\/cancel$/);
      if (req.method === 'GET' && cancelMatch) {
        // VULNERABLE: a state-changing GET passes the global CSRF gate without a token.
        return json(res, 200, { order: cancelOrder(db, cancelMatch[1], { ownerId: user.id }) });
      }
      const orderMatch = pathname.match(/^\/api\/orders\/(K-\d{4}-\d+)$/);
      if (req.method === 'GET' && orderMatch) {
        // VULNERABLE: authenticated customer may read another customer's order by ID.
        const order = orderRecord(db, orderMatch[1]);
        return order ? json(res, 200, { order }) : fail(res, 404, '注文が見つかりません');
      }
      if (req.method === 'GET' && pathname === '/api/profile') return json(res, 200, { profile: publicUser(user) });
      if (req.method === 'PATCH' && pathname === '/api/profile') {
        const body = await readJson(req);
        const updated = {
          name: body.name === undefined ? user.name : textField(body.name, 80, 'お名前'),
          address: body.address === undefined ? user.address : optionalText(body.address, 240, '住所'),
          bio: body.bio === undefined ? user.bio : optionalText(body.bio, 300, '自己紹介'),
          // VULNERABLE: role is part of a client-writable profile update.
          role: body.role === undefined ? user.role : body.role,
        };
        if (!['customer', 'staff'].includes(updated.role)) return fail(res, 400, 'プロフィールを更新できません');
        db.prepare('UPDATE users SET name=?,address=?,bio=?,role=? WHERE id=?').run(updated.name, updated.address, updated.bio, updated.role, user.id);
        overviewCache = null;
        return json(res, 200, { profile: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(user.id)) });
      }
      const reviewMatch = pathname.match(/^\/api\/products\/(\d+)\/reviews$/);
      if (req.method === 'POST' && reviewMatch) {
        const productId = Number(reviewMatch[1]);
        const product = db.prepare('SELECT id FROM products WHERE id=? AND visible=1').get(productId);
        if (!product) return fail(res, 404, '商品が見つかりません');
        const body = await readJson(req);
        const rating = Number(body.rating);
        if (!Number.isSafeInteger(rating) || rating < 1 || rating > 5) return fail(res, 400, '評価を確認してください');
        const title = textField(body.title, 80, 'タイトル');
        const reviewBody = textField(body.body, 1000, 'レビュー');
        // VULNERABLE: HTML is stored verbatim and rendered as HTML by the review UI.
        const result = db.prepare('INSERT INTO reviews (user_id,product_id,rating,title,body,created_at) VALUES (?,?,?,?,?,?)').run(user.id, productId, rating, title, reviewBody, new Date().toISOString());
        const review = db.prepare('SELECT r.*,u.name AS author_name FROM reviews r JOIN users u ON u.id=r.user_id WHERE r.id=?').get(Number(result.lastInsertRowid));
        return json(res, 201, { review: publicReview(review) });
      }
      if (pathname.startsWith('/api/staff/')) {
        if (user.role !== 'staff') return fail(res, 403, 'この操作には権限が必要です');
        if (req.method === 'GET' && pathname === '/api/staff/overview') {
          const stats = { orders: db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, revenue: db.prepare('SELECT COALESCE(SUM(total),0) AS n FROM orders').get().n, products: db.prepare('SELECT COUNT(*) AS n FROM products WHERE visible=1').get().n };
          const ids = db.prepare('SELECT id FROM orders ORDER BY created_at DESC LIMIT 20').all();
          return json(res, 200, { stats, orders: ids.map((row) => orderRecord(db, row.id)) });
        }
        if (req.method === 'GET' && pathname === '/api/staff/orders/export.csv') {
          const rows = db.prepare(`SELECT id,name,postal_code,address,status,total,created_at
            FROM orders ORDER BY created_at DESC,id DESC LIMIT 500`).all();
          const records = [
            ['id', 'recipient_name', 'postal_code', 'address', 'status', 'total', 'created_at'],
            ...rows.map((row) => [row.id, row.name, row.postal_code, row.address, row.status, row.total, row.created_at]),
          ];
          const body = records.map((record) => record.map(csvCell).join(',')).join('\r\n') + '\r\n';
          res.writeHead(200, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': 'attachment; filename="kova-orders.csv"',
            'Cache-Control': 'no-store',
            'Content-Length': Buffer.byteLength(body),
          });
          return res.end(body);
        }
        if (req.method === 'GET' && pathname === '/api/staff/returns') {
          const rows = db.prepare(`SELECT r.*,u.name AS customer_name FROM return_requests r
            JOIN users u ON u.id=r.user_id ORDER BY r.requested_at DESC,r.id DESC LIMIT 100`).all();
          return json(res, 200, {
            returns: rows.map((row) => ({ ...publicReturnRequest(row), customerName: row.customer_name })),
          });
        }
        const staffReturnMatch = pathname.match(/^\/api\/staff\/returns\/(\d+)$/);
        if (req.method === 'PATCH' && staffReturnMatch) {
          const returnId = Number(staffReturnMatch[1]);
          if (!Number.isSafeInteger(returnId)) return fail(res, 404, '返品申請が見つかりません');
          const body = await readJson(req);
          if (body.status !== 'approved') return fail(res, 400, '返品状態を確認してください');
          const changed = db.prepare("UPDATE return_requests SET status='approved' WHERE id=? AND status='pending'")
            .run(returnId);
          if (changed.changes !== 1) {
            const exists = db.prepare('SELECT 1 FROM return_requests WHERE id=?').get(returnId);
            return fail(res, exists ? 409 : 404, exists ? 'この返品申請は承認できません' : '返品申請が見つかりません');
          }
          return json(res, 200, { returnRequest: returnRequestRecord(db, returnId) });
        }
        const staffOrder = pathname.match(/^\/api\/staff\/orders\/(K-\d{4}-\d+)$/);
        if (req.method === 'PATCH' && staffOrder) {
          const body = await readJson(req);
          if (!['processing', 'shipped', 'delivered', 'cancelled'].includes(body.status)) return fail(res, 400, '注文状態を確認してください');
          if (body.status === 'cancelled') return json(res, 200, { order: cancelOrder(db, staffOrder[1]) });
          const current = db.prepare('SELECT status FROM orders WHERE id=?').get(staffOrder[1]);
          if (!current) return fail(res, 404, '注文が見つかりません');
          const allowed = current.status === 'processing' ? ['processing', 'shipped', 'delivered'] :
            current.status === 'shipped' ? ['shipped', 'delivered'] :
              current.status === 'delivered' ? ['delivered'] : [];
          if (!allowed.includes(body.status)) return fail(res, 409, 'この注文状態には変更できません');
          const result = db.prepare('UPDATE orders SET status=? WHERE id=? AND status=?').run(body.status, staffOrder[1], current.status);
          return result.changes ? json(res, 200, { order: orderRecord(db, staffOrder[1]) }) : fail(res, 409, 'この注文状態には変更できません');
        }
      }
      return fail(res, 404, '操作が見つかりません');
    } catch (error) {
      return fail(res, error.status || 500, error.status ? error.message : '処理できませんでした');
    }
  });
  server.on('close', () => {
    if (!closed) { closed = true; catalog.close(); db.close(); }
  });
  return { server, db, close: () => new Promise((resolveClose) => server.close(resolveClose)) };
}
