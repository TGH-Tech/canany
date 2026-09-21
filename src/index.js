// Composition root. Boot order matters:
// load+validate config -> connect Prisma -> wire handlers -> start polling.
// The schema is applied by Prisma migrations (npm run db:dev / prisma:migrate),
// not on boot — so the database + tables must exist before starting.
const config = require('./config'); // requiring this validates env and exits if BOT_TOKEN/DATABASE_URL are missing.

// Node's Happy Eyeballs gives each resolved address 250 ms to complete the TCP
// handshake before closing the attempt and moving to the next one. From the
// production server api.telegram.org answers the SYN in ~400 ms, and the
// container network has no IPv6 to fall back to, so every poll died with
// "EFATAL: AggregateError" (ETIMEDOUT on IPv4, ENETUNREACH on IPv6) before the
// handshake could finish. Give one attempt a realistic budget instead.
require('net').setDefaultAutoSelectFamilyAttemptTimeout(5000);

const { prisma } = require('./infrastructure/db/prisma');
const webOnly = config.web.only;
let bot, startPolling;
if (!webOnly) ({ bot, startPolling } = require('./infrastructure/telegram/client'));
const messageHandler = require('./application/handlers/message');
const callbackHandler = require('./application/handlers/callback');
const commands = require('./application/commands');

(async () => {
  // A landing-page preview needs neither Telegram polling nor PostgreSQL. Keep
  // normal and bot deployments fail-fast, but allow WEB_ONLY=true to serve the
  // public web UI even when a local database is not running.
  if (!webOnly) {
    await prisma.$connect();
    console.log('Database connected.');
  } else {
    console.log('Web-only mode: Telegram polling and database startup skipped.');
  }

  if (!webOnly) {
  // Attach all Telegram listeners before polling begins.
  messageHandler.register(bot);
  callbackHandler.register(bot);
  commands.register(bot);

  await startPolling();
  }

  // The web board (signup / orgs / per-org board) runs in this same process,
  // on by default. Disabled only when WEB_ENABLED=false (pure-bot deploy).
  if (config.web.enabled) {
    const { startWeb } = require('./infrastructure/web/server');
    await startWeb();
    console.log(`✅ web board on http://localhost:${config.web.port}`);
  } else {
    console.log('Web board disabled (WEB_ENABLED=false).');
  }

  console.log(webOnly
    ? '✅ web preview is running — Telegram bot is disabled.'
    : '✅ canany is running — post a #ask message, then try /board.');
})().catch((err) => {
  console.error('Startup failed:', err.message);
  process.exit(1);
});

// Close the Prisma connection cleanly on shutdown (pm2 restart, Ctrl+C, etc.).
async function shutdown(signal) {
  console.log(`\n${signal} received — shutting down.`);
  try { await prisma.$disconnect(); } catch (_) {}
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});
