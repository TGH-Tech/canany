// The single source of truth for environment configuration.
// Loaded (and validated) once here; every other module imports this object
// instead of touching process.env directly.
require('dotenv').config();

// Hard requirement — exit early with a friendly hint if a critical var is missing.
function need(key) {
  if (!process.env[key]) {
    console.error(`Missing ${key}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
}
const webOnly = process.env.WEB_ONLY === 'true';
if (!webOnly) need('BOT_TOKEN');
need('DATABASE_URL');

// The web UI is now the product front door (signup -> org -> connect token), so
// it's on by default. Opt out for a pure-bot deploy with WEB_ENABLED=false.
// When the web is on we hard-require SESSION_SECRET (to sign the session cookie)
// and BOT_USERNAME (for the "add the bot to your group" deep link on the org page).
const webEnabled = process.env.WEB_ENABLED !== 'false';
if (webEnabled) {
  need('SESSION_SECRET');
  need('BOT_USERNAME');
}

// The port the web board listens on. A constant, not an env var: the platform
// routes traffic to exactly this port, so it must match `EXPOSE` in the
// Dockerfile and `port` in atlas.json.
const WEB_PORT = 8080;

const config = Object.freeze({
  telegram: {
    token: process.env.BOT_TOKEN,
    // Used to build https://t.me/<botUsername>?startgroup=true. Stored without a
    // leading @ so the link is always well-formed.
    botUsername: (process.env.BOT_USERNAME || '').replace(/^@/, '') || null,
  },
  database: {
    url: process.env.DATABASE_URL,
  },
  behavior: {
    askPrefix: process.env.ASK_PREFIX || '#ask',
    // Fall back to 2 if STALLED_DAYS is missing or not a positive number,
    // so a typo can't silently break /stalled with a NaN date cutoff.
    stalledDays: (() => {
      const n = Number(process.env.STALLED_DAYS);
      return Number.isFinite(n) && n > 0 ? n : 2;
    })(),
  },
  // The multi-tenant web board: accounts, orgs, and per-org boards (see src/infrastructure/web).
  web: {
    only: webOnly,
    enabled: webEnabled,
    port: WEB_PORT,
    sessionSecret: process.env.SESSION_SECRET || null,
    // Optional bootstrap kill-switch: when set, signup additionally requires this
    // code (gate to invited users). Unset (the default) = open signup.
    signupCode: process.env.SIGNUP_CODE || null,
  },
  // Object storage for #ask attachments (see src/infrastructure/storage). Reads
  // the S3_* names the deployment platform injects for its bucket (Atlas MinIO);
  // any S3-compatible store works. When S3_BUCKET is unset, `enabled` is false
  // and attachment capture is skipped — asks still work text-only.
  // S3_ACCESS_KEY / S3_SECRET_KEY are optional: when both are set they are used
  // as static credentials, otherwise the AWS SDK's default provider chain applies
  // (an IAM instance role on AWS, for instance).
  storage: (() => {
    const bucket = process.env.S3_BUCKET || null;
    const accessKey = process.env.S3_ACCESS_KEY || null;
    const secretKey = process.env.S3_SECRET_KEY || null;
    return {
      bucket,
      endpoint: process.env.S3_ENDPOINT || null, // null = AWS S3 proper
      region: process.env.S3_REGION || 'us-east-1', // MinIO ignores it; the SDK insists on one
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true', // MinIO: bucket in the path, not the host
      credentials: accessKey && secretKey ? { accessKeyId: accessKey, secretAccessKey: secretKey } : null,
      enabled: Boolean(bucket),
    };
  })(),
});

module.exports = config;
