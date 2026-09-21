# Multi-Tenancy for Can Anyone — Implementation Plan

> Companion to [`MULTI-TENANCY-ARCHITECRUE-CAN-ANYONE.md`](../MULTI-TENANCY-ARCHITECRUE-CAN-ANYONE.md)
> (the product/architecture brief). This doc is the **engineering implementation plan** —
> schema, repos, routes, bot changes, migration, and verification.

## Context

Can Anyone is a Telegram help-board bot with an optional read-only web board, today
**single-tenant**: one flat `asks` table, web auth is a single shared password, and there
are no users/orgs/groups. Critically, every ask already records its origin chat in
`tg_chat_id`, but **no read path filters on it** — so `/board`, `/top`, `/stalled` (bot and
web) show every group's data mixed together.

The goal is to make it a **multi-org product**: sign up → create an org → get a one-time
connect token + a "add the bot" link → run `/connect <token>` in your Telegram group → that
group gets its **own** board, in the bot and on the web, scoped so each org sees only its own
data. Existing groups are migrated into their own orgs with data **preserved intact**.

**Decided ordering:** build the **account + org-creation flow first** so a real account and org
id exist, then run the **data migration LAST**, assigning each migrated org to that admin
account (`owner_user_id`). This is why the build order below ends with migration.

Out of scope: the "going to market" React/CDN split in the brief's last section — explicitly a
separate, later effort. This plan keeps the current EJS web board and the single bot+web process.

---

## Build order (follow this sequence)

1. **Schema + repos** — add `User`, `Org`, `Group`, `ConnectToken` models; add `org_id` to `Ask`; one additive Prisma migration; new repository files.
2. **Auth** — signup / login / logout, real accounts (bcryptjs), session stores `uid`.
3. **Org creation + token page (web)** — create-org screen, org dashboard showing the connect token + bot link.
4. **Bot** — `/connect <token>`, DM gating, org-scoped `/board` `/top` `/stalled`, `#ask` org resolution.
5. **Web board scoping** — `GET /` shows only the logged-in user's org data (org switcher when >1).
6. **Data migration — LAST** — backfill existing groups into orgs owned by the admin account; additive + reversible.

---

## 1. Data model (`prisma/schema.prisma`)

Add four models and one column. Keep the existing snake_case + `@map` convention.

```prisma
model User {
  id            Int      @id @default(autoincrement())
  email         String   @unique          // store normalized: trim + lowercase
  password_hash String
  created_at    DateTime @default(now())
  orgs          Org[]
  @@map("users")
}

model Org {
  id            Int            @id @default(autoincrement())
  name          String
  origin        String         @default("web")   // 'web' | 'migrated'
  owner_user_id Int?
  owner         User?          @relation(fields: [owner_user_id], references: [id])
  created_at    DateTime       @default(now())
  groups        Group[]
  tokens        ConnectToken[]
  asks          Ask[]
  @@index([owner_user_id])
  @@map("orgs")
}

model Group {
  id           Int       @id @default(autoincrement())
  tg_chat_id   String    @unique           // one chat -> exactly one org; upsert key for /connect
  org_id       Int
  org          Org       @relation(fields: [org_id], references: [id], onDelete: Cascade)
  title        String?
  connected_by String?                      // tg user id who ran /connect (null if migrated)
  connected_at DateTime?
  created_at   DateTime  @default(now())
  @@index([org_id])
  @@map("groups")
}

model ConnectToken {
  id              Int       @id @default(autoincrement())
  token           String    @unique
  org_id          Int
  org             Org       @relation(fields: [org_id], references: [id], onDelete: Cascade)
  expires_at      DateTime
  used_at         DateTime?                 // null = still consumable
  used_by_chat_id String?
  created_at      DateTime  @default(now())
  @@index([org_id])
  @@map("connect_tokens")
}

// inside model Ask — add:
  org_id Int?
  org    Org? @relation(fields: [org_id], references: [id], onDelete: SetNull)
  @@index([org_id, status])
  @@index([org_id, created_at])
```

Notes:
- `Ask.org_id` is **nullable** (additive — live rows keep working) and **denormalized** (stamped at
  `createAsk` from the group→org lookup). Chosen over join-at-query-time because `leaderboard()` is
  raw SQL over `asks` only, `tg_chat_id` is nullable/unstable across supergroup upgrades, and a
  denormalized `org_id` snapshots the org an ask was *actually* raised under (re-connecting a group
  to a new org must not retroactively move history).
- One additive migration: author with `npm run db:dev` (e.g. `add_orgs_users_groups_tokens`), apply
  in prod with `npm run prisma:migrate` (`migrate deploy`). It only **adds** tables, a nullable
  column, indexes, and FKs — the running old bot is unaffected (writes `org_id = NULL`, never reads it).
- `users` must exist before the `orgs.owner_user_id` FK — keep both models in the same migration.

---

## 2. Repositories (`src/infrastructure/db/`)

Mirror the thin-wrapper style of the existing `asksRepository.js`; reuse the Prisma singleton
`src/infrastructure/db/prisma.js`. Keep bcrypt out of the repos (hash/compare lives in the route layer).

**New `usersRepository.js`:** `createUser({email, passwordHash})`, `findUserByEmail(email)`, `findUserById(id)`.

**New `orgsRepository.js`:** `createOrg({name, ownerUserId, origin})`, `getOrg(id)` (must include `owner_user_id`
for the ownership check), `listOrgsByUser(userId)`, `createConnectToken(orgId)`, `regenerateConnectToken(orgId)`
(burn outstanding unused token, mint new), `getActiveConnectToken(orgId)` (the unused/unexpired token to
**display** — page loads must not mint), `listGroupsByOrg(orgId)` (optional, for "connected groups" status).

**New `groupsRepository.js`:** `orgIdForChat(chatId)` — the single group→org resolver used by every bot
call site (`findUnique({where:{tg_chat_id:String(chatId)}})` → `org_id | null`); `linkGroup(...)`; `getGroupByChatId(chatId)`.

**New `tokensRepository.js`:**
- `createToken({orgId, ttlMs=24h})` → `crypto.randomBytes(18).toString('base64url')` (24 chars, ~144 bits), store plaintext (short-lived bearer), `expires_at = now + ttl`.
- `consumeToken({token, chatId, connectedBy})` → **transactional single-use burn**: inside `prisma.$transaction`,
  a guarded `updateMany({where:{token, used_at:null, expires_at:{gt:now}}, data:{used_at:now, used_by_chat_id}})`;
  if `count===0` → `{ok:false, reason:'invalid_or_expired'}`; else `group.upsert` on `tg_chat_id` linking/re-pointing
  to the token's org, return `{ok:true, org}`. The guarded `updateMany` (same idiom as `guardedTransition` at
  `asksRepository.js:12`) makes it race-safe — exactly one concurrent `/connect` wins.

**Changed `asksRepository.js`** — add an org filter to the four functions:
- `createAsk({..., orgId})` → write `org_id: orgId`.
- `listAsks(orgId)` → add `org_id: orgId` to both `findMany` where-clauses (`asksRepository.js:81-99`).
- `stalledAsks(orgId, days)` → add `org_id: orgId` to the where (`asksRepository.js:101-107`).
- `leaderboard(orgId)` → add `AND org_id = ${orgId}` to **each** of the three `UNION ALL` arms (`asksRepository.js:111-134`).
  `$queryRaw` binds each `${orgId}` as a parameter (safe). **Highest-risk edit — three WHERE clauses.**

---

## 3. Bot changes

**`src/application/commands.js`** — restructure the `bot.on('message')` slash router:
- Read `isPrivate = msg.chat.type === 'private'` (this field is currently never checked anywhere).
- **`/connect <token>`** (group-only): extract the token from raw text with
  `text.match(/^\/connect(?:@\S+)?\s+(\S+)/i)` (the existing `split(/[\s@]/)` parser discards args, so parse
  separately). In a DM → reply "Run /connect inside the group you want to link." No token → usage hint. Else
  `tokens.consumeToken(...)` → `✅ Verified — connected to <Org>. Board is live.` or `❌ Invalid or expired.`
- **`/board` `/top` `/stalled`**: in a DM → redirect ("Boards live in your group — run it there"). In a group →
  `orgId = await groups.orgIdForChat(chatId)`; if null → "This group isn't connected yet. Run /connect <token>";
  else call `db.listAsks(orgId)` / `db.leaderboard(orgId)` / `db.stalledAsks(orgId, STALLED_DAYS)`.
- `/start`, `/help` unchanged (still work in DMs for onboarding).
- Add `{command:'connect', description:'Link this group to your org'}` to `setMyCommands` in
  `src/infrastructure/telegram/client.js:12`.

**`src/application/handlers/message.js`** — in the `#ask` branch, before `createAsk`:
- DM → reply "#ask works inside a connected group — add the bot and run /connect" (no orphan ask).
- `orgId = await groups.orgIdForChat(chatId)`; if null → reply "This group isn't linked yet. Run /connect <token>"
  (no orphan ask). Else pass `orgId` into `db.createAsk({...})`.
- The outcome-close path (`message.js:25-46`) needs no org param (resolves the ask by id from the bot's own
  force-reply, which only exists in the originating chat). Optional hardening: assert the ask's `org_id` matches the chat's org.

**`src/application/handlers/callback.js`** — no change. Claim/done/urgency/effort act on an ask by id on the
org's own card in the org's own chat → implicitly org-scoped.

---

## 4. Auth + web

**Dependency:** add `bcryptjs` (pure JS, no native build — matches the lean single-EC2 setup), cost factor 10.

**Config (`src/config/index.js`):** web is now the product front door, no longer keyed off the old shared web password.
- `web.enabled = process.env.WEB_ENABLED !== 'false'` (default-on; opt-out for a pure-bot deploy).
- Remove `web.password` and delete `passwordMatches` (`routes.js:12-17`); retire the shared web password from config, `.env.example`, README.
- `SESSION_SECRET` required whenever web enabled (keep the `need()` pattern).
- Add `config.telegram.botUsername = process.env.BOT_USERNAME` (required when web enabled) for the
  `https://t.me/<bot>?startgroup=true` link; add optional `web.signupCode = process.env.SIGNUP_CODE || null`
  (bootstrap kill-switch — open signup by default, gate to invited users when set).
- `src/index.js:26-32` gate still reads `config.web.enabled`; only the log copy changes.

**Sessions (`cookie-session` unchanged, `server.js:28-35`):** `req.session` carries `{ uid, orgId, csrf }`
instead of the old `authed` boolean.
- `requireAuth` becomes `async`: bounce to `/login` if no `uid`; `findUserById(uid)`; if the user is gone null
  the session + redirect; set `req.user` + `res.locals.user`. Lazily mint `req.session.csrf` (16 random bytes hex).
- On **login and signup**, reset session first (`req.session = null; req.session = {uid}`) to avoid fixation /
  attacker-seeded `orgId`.
- **Org resolution** helper for `/` and org routes: `listOrgsByUser(user.id)`; 0 orgs → redirect `/orgs/new`;
  else current = `session.orgId` if owned else `orgs[0]` (persist it). Current org lives in the session so the
  board's tab/filter/refresh links need no `org` query param.
- **CSRF:** `sameSite:'lax'` is the baseline; add a synchronizer-token `verifyCsrf` on authed POSTs
  (`/logout`, `/orgs`, `/orgs/:id/token`) comparing `req.body._csrf` to `req.session.csrf` (timing-safe). Each
  authed POST form renders `<input type=hidden name=_csrf>`.

**Routes (`src/application/web/routes.js`):**

| Method | Path | Auth | Behavior |
|---|---|---|---|
| GET | `/healthz` | none | unchanged |
| GET/POST | `/signup` | none | email+password (+ `_code` if `signupCode` set); normalize email; dup email → 409 re-render; create user, reset+set session, → `/` |
| GET/POST | `/login` | none | email+password; generic "Wrong email or password" (no enumeration); preserve typed email; reset+set session, → `/` |
| POST | `/logout` | requireAuth + csrf | `req.session=null` → `/login` |
| GET | `/` | requireAuth | resolve orgs (0 → `/orgs/new`); `?org=<id>` if owned sets `session.orgId` (PRG) else 404; existing tab logic but `asks.listAsks(current.id)` / `leaderboard(current.id)` / `stalledAsks(current.id, days)`; pass `org`, `orgs` to `index.ejs` |
| GET | `/orgs/new` | requireAuth | create-org screen (also the 0-org empty state) |
| POST | `/orgs` | requireAuth + csrf | validate name (1–80); `createOrg({name, ownerUserId})`; `createConnectToken`; set `session.orgId`; → `/orgs/:id` |
| GET | `/orgs/:id` | requireAuth + ownership | `getOrg`; not owner/missing → styled 404; show name, `getActiveConnectToken` (display only), `botLink`, optional connected-groups, regenerate form, "View board →" |
| POST | `/orgs/:id/token` | requireAuth + ownership + csrf | `regenerateConnectToken` → `/orgs/:id` (PRG) |

Define `/orgs/new` before `/orgs/:id` so the literal wins.

**Templates (`src/presentation/web/views/`)** — reuse `partials/head.ejs` ("Ink & Signal" terminal design system,
all CSS inlined). Extract the auth-form styles from `login.ejs` into `partials/form-styles.ejs` shared by the three forms.
- `login.ejs` (edit): add email field; update lede away from "shared password"; "No account? Sign up →".
- `signup.ejs` (new): email + password (+ optional signup code); "Have an account? Log in →".
- `org-new.ejs` (new): single org-name field → POST `/orgs`.
- `org.ejs` (new): the org dashboard — connect token in the `code` style with "Run `/connect <token>` in your group",
  `<a class=btn primary href="https://t.me/<bot>?startgroup=true">Add the bot to your group</a>`, regenerate form,
  optional connected-groups list, "View board →".
- `index.ejs` (edit): show org name in `term__title`; when `orgs.length>1` render an org switcher (reuse `.flags`
  chips linking `/?org=<id>`) plus "+ new org" and "manage/connect a group" (`/orgs/:id`); queries already scoped by the route.

---

## 5. Data migration — runs LAST (`scripts/backfill-orgs.js`)

Per the decided ordering, this is the **final** step — after the admin has signed up and we have a `user.id` to own
the migrated orgs. Plain Node script reusing the Prisma singleton; **not** a Prisma migration (kept separate so it's
idempotent, dry-runnable, reversible).

Run: `node scripts/backfill-orgs.js --owner <email|userId> --dry-run` then without `--dry-run`; `--revert` to undo.

Forward: for each `DISTINCT tg_chat_id` in `asks WHERE tg_chat_id IS NOT NULL AND org_id IS NULL`, in a transaction —
if a `groups` row exists reuse its `org_id`; else create an `Org { name: 'Migrated group <tg_chat_id>', origin:'migrated',
owner_user_id: <admin user id> }` and a `groups` row linking the chat; then
`ask.updateMany({where:{tg_chat_id, org_id:null}, data:{org_id}})`. Idempotent (only touches null-org asks; skips
already-linked chats). Assigning `owner_user_id` to the admin account is what makes every migrated group's board
visible on the web under that login.

Revert: select orgs with `origin='migrated'`, null their asks' `org_id`, delete their groups + orgs.

Deploy sequence: (1) `prisma migrate deploy` (additive) — old bot keeps running, writes null `org_id`; (2) deploy the
new org-aware bot + web; (3) admin signs up + (optionally) creates a fresh org via the UI; (4) run the backfill with
`--owner <admin>`; (5) optional re-run to sweep any null-org asks created in the deploy window.

---

## Edge cases (handled)

- **Re-connecting an already-linked group:** `consumeToken` upsert re-points the group to the new token's org
  (last valid connect wins; in-group admin + valid token = consent). Past asks keep their original `org_id`.
- **Token race:** guarded `updateMany(used_at:null AND expires_at>now)` in a txn — exactly one winner.
- **Supergroup id change:** chat id changes on upgrade; denormalized `org_id` keeps old asks correct; (future:
  handle Telegram `migrate_to_chat_id` to update the `groups` row — out of scope).
- **Null-org asks** (legacy/DM/`tg_chat_id IS NULL`): invisible on every org board since reads filter `org_id` — acceptable.
- **Auth:** dup email → 409; login of a 0-org user succeeds → `/orgs/new`; accessing an org you don't own → 404
  (not 403, no existence leak); deleted-user cookie → hard logout; token page never mints on GET.

---

## Critical files

- `prisma/schema.prisma` — add `User`, `Org`, `Group`, `ConnectToken`; add `org_id` to `Ask`; one additive migration.
- `src/infrastructure/db/asksRepository.js` — org param on `createAsk`/`listAsks`/`stalledAsks`/`leaderboard`.
- `src/infrastructure/db/{usersRepository,orgsRepository,groupsRepository,tokensRepository}.js` — new.
- `src/application/commands.js` — `/connect`, DM gating, org-scoped reads.
- `src/application/handlers/message.js` — `#ask` org resolution + unconnected/DM gating.
- `src/infrastructure/telegram/client.js` — register `/connect` in `setMyCommands`.
- `src/application/web/routes.js` — rewrite auth, add org routes, scope `GET /`.
- `src/infrastructure/web/server.js` + `src/config/index.js` — session content, `WEB_ENABLED`/`BOT_USERNAME`/`SIGNUP_CODE`, retire the shared web password.
- `src/presentation/web/views/` — edit `login.ejs`, `index.ejs`; add `signup.ejs`, `org-new.ejs`, `org.ejs`, `partials/form-styles.ejs`.
- `scripts/backfill-orgs.js` — new migration script (run last, `--owner <admin>`).
- `package.json` — add `bcryptjs`.

---

## Verification (end-to-end)

1. **Migration apply:** `npm run db:dev` succeeds; old bot still runs against the new schema (writes null `org_id`).
2. **Signup/login:** sign up a new account on the web → land on `/orgs/new`; create an org → org page shows a
   connect token + "Add the bot" link. Log out / log back in works; wrong password gives the generic error.
3. **Connect:** add the bot to a test group, run `/connect <token>` → `✅ Verified — connected to <Org>`. Re-run
   with a used/garbage token → `❌ Invalid or expired.`
4. **Two-org isolation:** connect Group A and Group B to two different orgs. Post `#ask` in each; `/board` `/top`
   `/stalled` in Group A never show Group B's asks, and vice-versa. The web board under each org's login shows only its own.
5. **DM redirect:** DM the bot `/board` (and `#ask`) → redirect/hint, never a board or an orphan ask.
6. **Unconnected group:** `#ask` / `/board` in a group with no `/connect` → "run /connect" hint, no orphan ask created.
7. **Migration (last):** with real existing-group data present, run `node scripts/backfill-orgs.js --owner <admin> --dry-run`,
   review, then apply. Confirm each old group is now its own org owned by the admin, all asks intact (`org_id` populated),
   and the boards (bot + web under the admin login) render the migrated data. Verify `--revert` cleanly undoes it on a copy.
