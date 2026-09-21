# Architecture — Can Anyone

An open "asks" board that lives inside Telegram. Anyone posts `#ask <request>`,
anyone claims it, finishes it, and the outcome is kept. The board itself is the
`/board` command, answered with a monospace table in the chat. An optional
read-only web view shows the same data.

This document describes the architecture: the tenancy model, the runtime shape,
the tech stack, the layering, the data model, the core flows, and deployment.

---

## Tenancy: single-tenant (one global board)

**Can Anyone is single-tenant.** One bot process is backed by one database with a
single asks table, and that table is **one global pool of asks shared by every
chat the bot is in**.

What this means architecturally:

- All board reads (`/board`, `/top`, `/stalled`, and the web view) query the
  whole asks table, scoped only by status and date — **never by chat**. So
  `/board` in Group A, in Group B, and in a DM all return the **same** rows.
- The originating chat / topic / message ids are stored on each ask, but only to
  **deep-link back to the source thread** and to keep editing the bot's own card
  — *not* to partition data. Nothing isolates reads by chat.
- Identity is per-Telegram-user and global too — the leaderboard aggregates
  people across every chat.
- **Only one poller may run at a time.** Telegram long polling is exclusive; a
  second instance on the same token gets a `409 Conflict`. You can't run two
  copies on one token, so "scale out" is not a path to isolation.

This is a deliberate "one community, one board" design. To serve separate
tenants you **deploy separate instances**, each with its own bot token and its
own database. Making it multi-tenant in a single instance would mean introducing
a tenant key (e.g. chat → workspace) and scoping every board read and index by
it — there is no built-in multi-tenancy today.

---

## Runtime shape

A single long-running Node.js process. It does **not** expose an inbound bot
webhook — it uses Telegram **long polling**, so the bot is outbound-only. The
optional web board runs an HTTP server **in the same process** when enabled.

```
TELEGRAM (source of truth for actions)        NODE PROCESS
  #ask · ✋ Claim · ✅ Done · urgency/effort  ──▶  Telegram bot client (long poll)
  /board /top /stalled /help                         │
                                                     ├─ Prisma ──▶ PostgreSQL (asks)
                                                     │
  browser ──▶ (optional, same process) ───────▶  HTTP server + session + templates
                                                  read-only web board
```

- **No Docker, no Activepieces, no Baserow.** Just Node + PostgreSQL.
- **No client-side framework / build step.** The web board is server-rendered.
- **Telegram is the source of truth for actions.** Claiming and closing happen in
  Telegram; the web board only *displays*.
- Boot order: load + validate config → connect to the database → register
  Telegram handlers → start polling → (optionally) start the web server.
  Schema migrations are applied separately, never on boot.

---

## Tech stack & dependencies

Deliberately small: a Node bot + Postgres, no Docker, no Activepieces/Baserow,
no client-side framework or build step.

**Runtime:** Node.js ≥ 18 · PostgreSQL.

**Production dependencies:**

| Package                 | Version | Role                                                          |
|-------------------------|---------|---------------------------------------------------------------|
| `node-telegram-bot-api` | ^0.66.0 | Telegram bot client; long polling, inline keyboards, commands |
| `@prisma/client`        | ^5.22.0 | Database client / query layer                                 |
| `express`               | ^4.22.2 | HTTP server for the optional read-only web board              |
| `ejs`                   | ^3.1.10 | Server-side HTML templating (no client framework)             |
| `cookie-session`        | ^2.1.1  | Stateless signed cookie holding just the auth flag            |
| `dotenv`                | ^16.4.5 | Loads environment config once at startup                      |

**Dev / tooling dependencies:**

| Package  | Version | Role                                                     |
|----------|---------|----------------------------------------------------------|
| `prisma` | ^5.22.0 | Schema definition and migrations                         |
| `pm2`    | ^5.4.2  | Process manager for the deployed app box                 |

**Standard library only** (no dependency): `crypto` for a constant-time password
compare on the web login. No test framework, no ORM beyond Prisma, no bundler.

---

## Layers

The code is organized as concentric layers so each part has one job and a single
composition root wires them together:

- **Config** — loads and validates environment configuration once; the only
  reader of the environment. A leaf imported everywhere else.
- **Domain** — the shared vocabulary: the status lifecycle, allowed urgencies,
  and the effort units/quantities. One source of truth for these values.
- **Infrastructure** — everything that talks to the outside world: the database
  access layer, the Telegram client, and the web/HTTP server.
- **Application** — orchestration, i.e. what happens on each event: new asks and
  outcome capture, button taps, slash-command routing, card re-rendering, and
  the web routes.
- **Presentation** — pure rendering: the monospace Telegram tables/cards, the
  inline keyboards, and the web templates. No I/O.

Dependency direction points inward: presentation and infrastructure depend on
domain; application orchestrates infrastructure and presentation; nothing depends
on application. The database access layer is the **only** place that issues
queries, which is what keeps the single-tenant scoping decision in one place.

---

## Data model

One table — **asks** — is the entire persistent state. There are no other
tables; the leaderboard is derived from this one table at query time.

| Field         | Type        | Purpose                                                        |
|---------------|-------------|----------------------------------------------------------------|
| id            | int PK      | Autoincrement; the ask's public number (`#42`)                 |
| ask           | text        | The request text                                               |
| asker         | text        | Asker display name                                             |
| asker_id      | text?       | Telegram user id — spoof-proof identity for asker-only actions |
| effort        | text?       | Free-form estimate, e.g. `"2 days"` (set by claimer)           |
| urgency       | text?       | `now` / `EOD` / `no-rush` (set by asker)                       |
| status        | text        | `open` → `claimed` → `done` (default `open`)                   |
| claimer       | text?       | Claimer display name                                           |
| claimer_id    | text?       | Telegram user id — spoof-proof identity for claimer-only actions |
| outcome       | text?       | Required to reach `done`                                       |
| thread_link   | text?       | Deep link back to the originating Telegram thread              |
| tg_chat_id    | text?       | Source chat id — for deep-linking, **not** for tenant scoping  |
| tg_topic_id   | text?       | Source topic id (forum topics)                                 |
| tg_msg_id     | text?       | The original `#ask` message id                                 |
| tg_card_id    | text?       | The bot's reply card — kept and edited in place                |
| created_at    | timestamp   | When raised                                                    |
| claimed_at    | timestamp?  | When claimed                                                   |
| closed_at     | timestamp?  | When closed                                                    |

Indexed on status and created_at (board sort + stalled cutoff). Telegram ids are
stored as **text** — they're identifiers, never used for math.

### Status lifecycle

```
open ──✋ Claim──▶ claimed ──✅ Done (+ outcome reply)──▶ done
```

Transitions are **guarded at the database level**: a status change only applies
when the ask is currently in an allowed prior status, inside a transaction. So
two people claiming at once, or a Done landing on an already-closed ask, can't
double-apply. The rules:

- **Done only after Claim** — closing an unclaimed ask is rejected.
- **Asker sets urgency** (until it closes); **claimer sets effort** (only while
  claimed).
- **Ownership is by Telegram user id**, not display name (names are spoofable).

---

## Core flows

- **Raise an ask** — a message beginning with the `#ask` prefix becomes an ask;
  the bot posts a card with inline buttons and remembers that card so it can keep
  editing the same message in place as state changes.
- **Claim / Done / urgency / effort** — handled as button taps on the card.
  Effort is a **two-step pick**: choose a unit (mins/hrs/days/weeks), then a
  quantity, stored as a human string like `"3 hrs"`. Inputs are validated against
  fixed presets so a crafted callback can't write an arbitrary value.
- **Close with an outcome** — tapping ✅ asks the claimer to reply with the
  outcome. The reply is matched back to its ask by an id carried in the prompt
  text, so a pending close **survives a process restart** (no in-memory state).
- **Read commands** — `/board` (active asks first, then the most recent done,
  capped to stay under Telegram's message-size limit), `/top` (this month's
  builders), `/stalled` (open asks older than the configured threshold).
- **Web board (optional)** — off unless a web password is set. A single shared
  password (constant-time compared) gates a stateless signed-cookie session. One
  server-rendered page with board / top / stalled tabs shows the same data as the
  bot. It is **read-only** — it never mutates state. An unauthenticated health
  endpoint supports uptime checks. Serve over HTTPS in production.

---

## Configuration

| Var                   | Required        | Purpose                                                   |
|-----------------------|-----------------|-----------------------------------------------------------|
| `BOT_TOKEN`           | yes             | Telegram bot token                                        |
| `BOT_USERNAME`        | if web enabled  | Builds the "add the bot to your group" link               |
| `DATABASE_URL`        | yes             | PostgreSQL connection string (injected on Atlas)          |
| `SESSION_SECRET`      | if web enabled  | Signs the session cookie                                  |
| `SIGNUP_CODE`         | no (open)       | Gate signups to people who know the code                  |
| `S3_BUCKET` + `S3_*`  | no (off)        | Attachment storage; any S3-compatible bucket (injected)   |
| `ASK_PREFIX`          | no (`#ask`)     | Trigger prefix for new asks                               |
| `STALLED_DAYS`        | no (`2`)        | Age threshold for `/stalled`                              |
| `WEB_ENABLED`         | no (`true`)     | `false` = pure-bot process, no port opened                |
| `WEB_ONLY`            | no (`false`)    | `true` = web preview only, no polling, no database        |

The web port is a constant (8080) — it must match the container's `EXPOSE` and
`atlas.json`. The session cookie's `Secure` flag follows the request protocol
behind the trusted proxy, so there is no flag for it.

---

## Deployment

Reference setup is **one container on Atlas** (see `Dockerfile` and `atlas.json`):

- **Service `web`:** the bot and the web board in one Node process, public on
  port 8080 behind the platform's TLS proxy.
- **PostgreSQL and object storage** are platform add-ons declared as `needs`;
  their connection variables are injected, never committed.
- **Migrations** run as the release command (`prisma migrate deploy`) before each
  cutover, never on process start.

> ⚠️ **One poller only.** Two instances polling the same token → `409 Conflict`.
> Stop one before starting the other. This is also why scaling out / multi-tenancy
> is not simply "run more copies."
