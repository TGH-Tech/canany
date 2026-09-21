// Web routes. Mounted by src/infrastructure/web/server.js.
// The web is the product front door: signup -> create org -> connect token, then
// a per-org board mirroring what the Telegram bot shows for that org. Accounts are
// real (bcryptjs); the session cookie carries { uid, orgId, csrf }.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('../../config');
const asks = require('../../infrastructure/db/asksRepository');
const users = require('../../infrastructure/db/usersRepository');
const orgs = require('../../infrastructure/db/orgsRepository');
const storage = require('../../infrastructure/storage/s3');
const { STATUS_ORDER } = require('../../domain/constants');

const BCRYPT_COST = 10;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const normalizeEmail = (e) => String(e || '').trim().toLowerCase();

// ---- CSRF (synchronizer token) ----
// sameSite:'lax' on the cookie is the baseline; authed POSTs additionally carry a
// per-session token compared timing-safely. Minted lazily in requireAuth.
function ensureCsrf(req) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(16).toString('hex');
  return req.session.csrf;
}

function verifyCsrf(req, res, next) {
  const sent = Buffer.from(String((req.body && req.body._csrf) || ''));
  const want = Buffer.from(String((req.session && req.session.csrf) || ''));
  if (sent.length > 0 && sent.length === want.length && crypto.timingSafeEqual(sent, want)) return next();
  return res.status(403).type('text').send('Bad CSRF token. Reload the page and try again.');
}

// Gate for everything that shows data. Loads the user fresh each request so a
// deleted account can't keep a live session. Bounces to /login otherwise.
async function requireAuth(req, res, next) {
  try {
    if (!req.session || !req.session.uid) return res.redirect('/login');
    const user = await users.findUserById(req.session.uid);
    if (!user) { req.session = null; return res.redirect('/login'); } // account gone -> hard logout
    req.user = user;
    res.locals.user = user;
    res.locals.csrf = ensureCsrf(req);
    next();
  } catch (err) { next(err); }
}

// The org the request acts on. Returns the owned-org list and the "current" org
// (session.orgId if still owned, else the first org), persisting the choice so
// board links need no ?org param. current is null when the user owns no org yet.
async function resolveCurrentOrg(req) {
  const list = await orgs.listOrgsByUser(req.user.id);
  if (!list.length) return { list, current: null };
  const current = list.find((o) => o.id === req.session.orgId) || list[0];
  req.session.orgId = current.id;
  return { list, current };
}

// Styled 404 — also used for "not your org" so we never leak whether an org id
// exists (no existence leak: same response for missing and not-owned).
function notFound(res, message) {
  return res.status(404).render('404', { title: 'canany — not found', message: message || 'Not found.' });
}

// Load an org the current user owns, or send a 404 and return null. Callers must
// `if (!org) return;` immediately.
async function loadOwnedOrg(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { notFound(res, 'No such org.'); return null; }
  const org = await orgs.getOrg(id);
  if (!org || org.owner_user_id !== req.user.id) { notFound(res, 'No such org.'); return null; }
  return org;
}

// Give each stored attachment the app URL that streams it (GET /attachments/:id
// below). The bucket is private and its endpoint may be reachable only from
// inside the deployment network, so bytes go through the app rather than a
// presigned URL. Oversize files (null s3_key) get url:null and the view falls
// back to the ask's thread link.
function attachAttachmentUrls(rows) {
  const canServe = config.storage.enabled;
  for (const r of rows) {
    for (const a of r.attachments || []) {
      a.url = canServe && a.s3_key ? `/attachments/${a.id}` : null;
    }
  }
}

// Image types a browser may render inline from our own origin. Anything else is
// sent as a download: user-supplied HTML or SVG rendered same-origin would run
// with the session cookie (stored XSS), which a separate S3 origin used to prevent.
const INLINE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

// A filename that is safe inside a quoted Content-Disposition value.
function safeFilename(att) {
  const raw = att.file_name || `${att.kind}-${att.id}`;
  return String(raw).replace(/[^\w.\-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120) || `file-${att.id}`;
}

function register(app) {
  // Liveness probe — no auth, so an uptime checker can hit it without a session.
  app.get('/healthz', (_req, res) => res.type('text').send('ok'));

  // ---- Signup ----
  app.get('/signup', (req, res) => {
    if (req.session && req.session.uid) return res.redirect('/');
    res.render('signup', { error: null, email: '', codeRequired: Boolean(config.web.signupCode) });
  });

  app.post('/signup', async (req, res, next) => {
    try {
      const codeRequired = Boolean(config.web.signupCode);
      const render = (error, status = 400) =>
        res.status(status).render('signup', { error, email: req.body.email || '', codeRequired });

      if (codeRequired && String(req.body._code || '') !== config.web.signupCode) {
        return render('That signup code isn’t valid.');
      }
      const email = normalizeEmail(req.body.email);
      const password = String(req.body.password || '');
      const passwordConfirm = String(req.body.passwordConfirm || '');
      if (!EMAIL_RE.test(email)) return render('Enter a valid email address.');
      if (password.length < 8) return render('Password must be at least 8 characters.');
      if (password !== passwordConfirm) return render('Passwords do not match.');

      if (await users.findUserByEmail(email)) return render('That email is already registered. Log in instead.', 409);

      const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
      let user;
      try {
        user = await users.createUser({ email, passwordHash });
      } catch (e) {
        // Lost the race to the unique-email constraint — treat as a dup.
        if (e && e.code === 'P2002') return render('That email is already registered. Log in instead.', 409);
        throw e;
      }

      // Reset the session before setting uid — avoids fixation / attacker-seeded orgId.
      req.session = null;
      req.session = { uid: user.id };
      return res.redirect('/');
    } catch (err) { next(err); }
  });

  // ---- Login ----
  app.get('/login', (req, res) => {
    if (req.session && req.session.uid) return res.redirect('/');
    res.render('login', { error: null, email: '', remember: false });
  });

  app.post('/login', async (req, res, next) => {
    try {
      const email = normalizeEmail(req.body.email);
      const password = String(req.body.password || '');
      const remember = req.body.remember === '1';
      // Generic message either way — never reveal whether the email exists.
      const fail = () => res.status(401).render('login', { error: 'Wrong email or password.', email: req.body.email || '', remember });

      const user = await users.findUserByEmail(email);
      if (!user) return fail();
      if (!(await bcrypt.compare(password, user.password_hash))) return fail();

      req.session = null;
      // cookie-session clones these options for each request. Explicitly clear
      // maxAge for a browser-session cookie when Remember me is unchecked.
      if (!remember) req.sessionOptions.maxAge = null;
      req.session = { uid: user.id, remember };
      return res.redirect('/');
    } catch (err) { next(err); }
  });

  app.post('/logout', requireAuth, verifyCsrf, (req, res) => {
    req.session = null;
    res.redirect('/login');
  });

  // ---- The per-org board ----
  const TABS = ['board', 'top', 'stalled'];
  const STATUS_FILTERS = [...STATUS_ORDER, 'all'];

  app.get('/', async (req, res, next) => { if (!req.session || !req.session.uid) return res.render('landing', { title: 'canany — ask better, together' }); return requireAuth(req, res, next); }, async (req, res, next) => {
    try {
      const { list, current } = await resolveCurrentOrg(req);
      if (!current) return res.redirect('/orgs/new'); // 0 orgs -> create one first

      // ?org=<id> switches the active org (only if owned), then PRG-redirects so
      // the param doesn't linger in the URL.
      if (req.query.org !== undefined) {
        const owned = list.find((o) => o.id === Number(req.query.org));
        if (!owned) return notFound(res, 'No such org.');
        req.session.orgId = owned.id;
        return res.redirect('/');
      }

      // Anything unrecognised falls back to the default, so a hand-edited query
      // string can never 500 the page. Queries are scoped to the current org.
      const tab = TABS.includes(req.query.tab) ? req.query.tab : 'board';
      const data = { tab, org: current, orgs: list };

      if (tab === 'board') {
        const rows = await asks.listAsks(current.id);
        // Counts over the FULL set so the chips always show real totals.
        data.counts = STATUS_ORDER.map((s) => ({ status: s, n: rows.filter((r) => r.status === s).length }));
        data.total = rows.length;
        const status = STATUS_FILTERS.includes(req.query.status) ? req.query.status : 'all';
        data.status = status;
        data.rows = status === 'all' ? rows : rows.filter((r) => r.status === status);
        attachAttachmentUrls(data.rows); // only the rows we'll render
      } else if (tab === 'top') {
        // COUNT comes back BigInt via $queryRaw — convert for EJS.
        const raw = await asks.leaderboard(current.id);
        data.builders = raw.map((b) => ({ person: b.person, shipped: Number(b.shipped), raised: Number(b.raised) }));
      } else {
        const days = config.behavior.stalledDays;
        const raw = await asks.stalledAsks(current.id, days);
        data.days = days;
        data.stalled = raw.map((r) => ({
          ...r,
          ageDays: Math.floor((Date.now() - new Date(r.created_at).getTime()) / 86400000),
        }));
      }

      res.render('index', data);
    } catch (err) { next(err); }
  });

  // ---- Attachments ----
  // Stream one stored file to the signed-in owner of the org its ask belongs to.
  // Same access rule as the board: the org must be owned by the current user; a
  // missing, oversize (no s3_key) or foreign attachment is a uniform 404.
  app.get('/attachments/:id', requireAuth, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || !config.storage.enabled) return notFound(res, 'No such file.');
      const att = await asks.getAttachment(id);
      if (!att || !att.s3_key || !att.ask || !att.ask.org_id) return notFound(res, 'No such file.');
      const org = await orgs.getOrg(att.ask.org_id);
      if (!org || org.owner_user_id !== req.user.id) return notFound(res, 'No such file.');

      const obj = await storage.getAttachment(att.s3_key);
      const type = obj.contentType || att.mime_type || 'application/octet-stream';
      const inline = INLINE_IMAGE_TYPES.has(type);
      res.set('Content-Type', type);
      if (obj.contentLength !== null) res.set('Content-Length', String(obj.contentLength));
      res.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${safeFilename(att)}"`);
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Cache-Control', 'private, max-age=3600');
      // A read error after the headers are out can't become a 500 page any more —
      // drop the connection so the browser sees a failed load, not a truncated file.
      obj.body.on('error', (err) => {
        console.error('attachment stream failed:', err.message);
        if (res.headersSent) res.destroy(); else next(err);
      });
      obj.body.pipe(res);
    } catch (err) { next(err); }
  });

  // ---- Orgs ----
  // /orgs/new is defined BEFORE /orgs/:id so the literal path wins.
  app.get('/orgs/new', requireAuth, (req, res) => {
    res.render('org-new', { error: null, name: '' });
  });

  app.post('/orgs', requireAuth, verifyCsrf, async (req, res, next) => {
    try {
      const name = String(req.body.name || '').trim();
      if (name.length < 1 || name.length > 80) {
        return res.status(400).render('org-new', { error: 'Org name must be 1–80 characters.', name: req.body.name || '' });
      }
      const org = await orgs.createOrg({ name, ownerUserId: req.user.id });
      await orgs.createConnectToken(org.id);
      req.session.orgId = org.id;
      return res.redirect(`/orgs/${org.id}`);
    } catch (err) { next(err); }
  });

  app.get('/orgs/:id', requireAuth, async (req, res, next) => {
    try {
      const org = await loadOwnedOrg(req, res);
      if (!org) return;
      const token = await orgs.getActiveConnectToken(org.id);
      const connectedGroups = await orgs.listGroupsByOrg(org.id);
      const botLink = config.telegram.botUsername
        ? `https://t.me/${config.telegram.botUsername}?startgroup=true`
        : null;
      res.render('org', { org, token, connectedGroups, botLink });
    } catch (err) { next(err); }
  });

  app.post('/orgs/:id/token', requireAuth, verifyCsrf, async (req, res, next) => {
    try {
      const org = await loadOwnedOrg(req, res);
      if (!org) return;
      await orgs.regenerateConnectToken(org.id);
      return res.redirect(`/orgs/${org.id}`);
    } catch (err) { next(err); }
  });
}

module.exports = { register, requireAuth };
