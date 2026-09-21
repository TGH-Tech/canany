// The web transport: builds the Express app, wires sessions + EJS, mounts the
// routes, and listens. Analogous to telegram/client.js — index.js calls
// startWeb() once the DB is connected (and only when config.web.enabled).
const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');
const config = require('../../config');
const routes = require('../../application/web/routes');

const VIEWS_DIR = path.join(__dirname, '..', '..', 'presentation', 'web', 'views');

function buildApp() {
  const app = express();

  // Server-side rendered HTML via EJS — no client framework, no build step.
  app.set('view engine', 'ejs');
  app.set('views', VIEWS_DIR);
  app.use(express.static(path.join(__dirname, '..', '..', 'presentation', 'web', 'public')));

  // Behind the platform's TLS reverse proxy (one hop) so req.protocol — and with
  // it the session cookie's Secure flag — reflects the original https request.
  app.set('trust proxy', 1);

  // Parse signup / login / org form posts.
  app.use(express.urlencoded({ extended: false }));

  // Stateless signed cookie carrying { uid, orgId, csrf } — no server-side store,
  // so sessions survive restarts. sameSite:'lax' is the CSRF baseline; authed
  // POSTs additionally carry a synchronizer token (see routes.js verifyCsrf).
  // No explicit `secure`: the cookie library derives it from req.protocol, which
  // honours the trusted proxy's X-Forwarded-Proto — Secure over HTTPS in
  // production, plain over http://localhost in development, with no flag to set.
  app.use(cookieSession({
    name: 'canany.sid',
    secret: config.web.sessionSecret,
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  }));

  // Keep non-remembered logins session-only on every response. Without this,
  // later CSRF/org updates would reissue them with the middleware's 7-day maxAge.
  app.use((req, _res, next) => {
    if (req.session && req.session.remember === false) req.sessionOptions.maxAge = null;
    next();
  });

  routes.register(app);

  // Last-resort error handler so a DB hiccup renders a page, not a stack trace.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error('Web request failed:', err.message);
    res.status(500).type('text').send('Something went wrong.');
  });

  return app;
}

// Starts listening and resolves once the socket is bound (so index.js can log
// success in order). Rejects if the port is already in use.
function startWeb() {
  const app = buildApp();
  return new Promise((resolve, reject) => {
    const server = app.listen(config.web.port, resolve);
    server.on('error', reject);
  });
}

module.exports = { buildApp, startWeb };
