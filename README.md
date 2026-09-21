# 🛠️ Can Anyone

An open asks board that lives **entirely inside Telegram**. Anyone posts "can someone do this?", anyone claims it, finishes it, and the outcome is kept. The "board" isn't a website — it's the **`/board`** command, answered with a monospace table right in the chat.

Built with custom code — **no Activepieces, no Baserow**. Just a Node.js bot + PostgreSQL (via Prisma), shipped as one container.

```
TELEGRAM (everything lives here)          NODE APP
 #ask · claim · done              ──▶    node-telegram-bot-api (long polling)
 /board /top /stalled commands             └─ reads/writes PostgreSQL
```

## What it does

- Post `#ask <your request>` in the chat → the bot saves it and replies with a card carrying the action buttons.
- **Urgency is set by the asker** (🔴 now · 🟡 EOD · 🟢 no-rush); **effort by the claimer** — tap a unit (~mins · ~hrs · ~days · ~weeks) and the bot asks "how many?", giving an exact effort like "3 hrs". Each is owned by the person who actually knows it — no auto-guessing.
- **✅ Done only works after ✋ Claim** — tapping it early shows "Claim it first". Closing prompts for an outcome.
- **Attach files** — send a photo/document (or a whole album) captioned `#ask …` and the files are stored in S3 and shown on the web board (optional — see below).
- **`/board`** current asks (with outcomes) · **`/top`** month's builders · **`/stalled`** asks open > 2 days.

### Attachments (optional)

Files sent with an `#ask` — a photo, a document, or several at once (an album) — are copied from Telegram into a **private S3-compatible bucket** and shown as thumbnails / links on the web board, streamed through the app to the org's owner. To enable, set `S3_BUCKET` (plus `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION` and `S3_FORCE_PATH_STYLE` for a non-AWS store such as MinIO; on Atlas these are injected). With only `S3_BUCKET` set, credentials come from the AWS SDK's default chain (an IAM instance role, say), and the bucket identity needs `s3:PutObject` + `s3:GetObject`. Leave `S3_BUCKET` unset for a text-only deploy. Files over 20 MB (Telegram's bot-download limit) are shown as a "view in Telegram" link instead.

## Project layout

The code is organised in layers — config → domain → infrastructure → application → presentation — so each file has one clear job and `index.js` just wires them together.

```
src/
  config/index.js                  Loads + validates env once; the only place that reads process.env
  domain/constants.js              Shared vocabulary (status order, urgencies) — one source of truth
  infrastructure/
    db/prisma.js                   Prisma client (single shared instance)
    db/asksRepository.js           Prisma query helpers for the asks table
    telegram/client.js             Bot instance, command menu, polling
    web/server.js                  Express app + cookie-session + EJS (optional web board)
  application/
    handlers/message.js            New asks + force-reply capture (outcome / effort amount)
    handlers/callback.js           Claim · Done · urgency · effort button taps
    commands.js                    /board /top /stalled /help routing
    cards.js                       Re-render an ask card after a state change
    state.js                       In-memory map of outstanding force-reply prompts
    web/routes.js                  Login / logout / board routes + requireAuth
  presentation/
    views.js                       Monospace table / card rendering
    keyboards.js                   Inline keyboard, reply helpers, display names, help copy
    web/views/                     EJS templates (login, board) for the web UI
  index.js                         Composition root: validate → connect Prisma → wire → poll
prisma/schema.prisma               The `asks` model — source of truth; migrations build the DB
```

## Setup (local, no Docker)

1. **PostgreSQL** (native) — create the role and let it create its own database:
   ```bash
   sudo apt install postgresql
   sudo -u postgres psql -c "CREATE USER canany WITH PASSWORD 'canany';"
   sudo -u postgres psql -c "ALTER ROLE canany CREATEDB;"
   ```
   (No manual `CREATE DATABASE` — Prisma creates the `canany` database in step 4.)

2. **Telegram bot** (BotFather): create the bot, copy the token. Add it to your group **as admin** and run `/setprivacy → Disable` so it can see messages (a DM with the bot also works).

3. **Config + install**:
   ```bash
   cp .env.example .env      # fill in BOT_TOKEN + DATABASE_URL
   npm install               # also runs `prisma generate`
   ```

4. **Create the database + tables** (Prisma migrations — creates the `canany` DB and the `asks` table):
   ```bash
   npm run db:dev            # prisma migrate dev
   ```

5. **Run**:
   ```bash
   npm start
   ```

## Try it

In your group (or a DM with the bot):
```
#ask Can anyone make a quick landing page?
```
As the asker, tap an urgency button. Tap ✅ Done before claiming → "Claim it first". Tap ✋ Claim → tap an effort unit → reply with how many → ✅ Done → reply to the prompt with a link/outcome. Then run `/board`, `/top`, `/stalled`.

## Web board (on by default)

The web board is the product front door: **sign up → create an org → get a
one-time connect token + an "add the bot" link → run `/connect <token>` in your
Telegram group**, and that group gets its own board (in the bot and on the web),
scoped so each org sees only its own data. Server-rendered HTML, no React; it runs
**in the same process** as the bot, so there's nothing extra to deploy. The bot
still owns the writes — claiming/closing happens in Telegram; the web page mirrors
each org's asks.

It's **on by default**. Required config when enabled:

```bash
SESSION_SECRET=$(openssl rand -hex 32)   # signs the session cookie
BOT_USERNAME=YourBot                     # builds the t.me/<bot>?startgroup=true link
SIGNUP_CODE=                             # optional: set to gate signups to invited users
```

Then `npm start` and open `http://localhost:8080` — you'll be sent to `/login`
(or `/signup` for a new account). The port is fixed at 8080 (it must match the
container's `EXPOSE` and `atlas.json`). Set `WEB_ENABLED=false` to run the bot
only (no port is opened).

> 🔒 **Serve it over HTTPS in production.** Accounts and connect tokens over plain
> HTTP are exposed in transit. Behind a TLS proxy (Atlas, Caddy, nginx) the app
> trusts one proxy hop and marks the session cookie `Secure` automatically
> whenever the original request was https — there is no flag to set.

## Deploy — Atlas (one container)

The repo ships a `Dockerfile` (one Node 22 image running bot + web board) and an
`atlas.json` declaring a single public service, `web`, on port 8080 with a
PostgreSQL database and a MinIO bucket provisioned by the platform:

- `DATABASE_URL` and the `S3_*` variables are **injected** — don't set them.
- Set `BOT_TOKEN`, `BOT_USERNAME` and `SESSION_SECRET` (and `SIGNUP_CODE` if you
  want gated signup) as runtime environment in the service's settings.
- The **release** command runs `prisma migrate deploy` before every cutover, so
  the schema is always applied before the new container takes traffic.
- Name the service `web` in the Atlas wizard so it matches `atlas.json`.

Push to `main` and Atlas rebuilds and swaps the container. After the first
deploy, check the container's restart count is 0 and open the public URL —
`/healthz` answers `ok` without a session.

To build and run the same image anywhere else:

```bash
docker build -t canany .
docker run --env-file .env -p 8080:8080 canany
```

> ⚠️ Only one instance may poll Telegram at a time. During a cutover the old and
> new containers overlap for a few seconds and one of them logs `409 Conflict`
> until the old one exits — harmless. Two long-lived instances (say, a local bot
> and the deployed one on the same token) are not: stop one.
