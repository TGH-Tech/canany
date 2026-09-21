# Plan: Invite a user to an organization (react-email + AWS SES)

## Context

`canany` is a plain-JavaScript (CommonJS, **no TypeScript, no build step**) Node app: an Express web board + a Telegram bot running in **one process**, with EJS server-rendered views, Prisma/PostgreSQL, and `cookie-session` auth. The recent multi-tenancy work introduced `User`, `Org`, `Group`, and `ConnectToken`, but an **org has exactly one owner and there is no membership table** — access is checked everywhere as `org.owner_user_id === req.user.id`. There is no email, no AWS, and no React anywhere in the project.

This change lets an org owner (or co-admin) **invite another person by email to join their org**. The invitee gets an emailed accept link; accepting makes them a member who can see that org's board and help administer it. This requires three new capabilities: (1) a real **membership** model so an org can have more than one user, (2) an **invitation** token + accept flow, and (3) an **email-sending layer** (react-email templates rendered to HTML, delivered via AWS SES).

### Decisions locked with the user
- **react-email integration:** no-build — templates authored as plain CommonJS via `React.createElement` + react-email's components/render (the ESM `@react-email/*` packages loaded with dynamic `import()`). Keeps the project build-free.
- **Member powers:** **co-admin**. A `member` can view the board, invite teammates, and manage connect tokens/groups. **Owner-only:** removing members; the owner can never be removed (anchor / no self-lockout).
- **Management UI:** **full** — members list with remove, pending-invites list with resend + revoke.
- **Invites are email-locked** (only the account whose email matches the invitation can accept) and single-use, mirroring the existing `ConnectToken` idiom.

---

## 1. Data model & migration

Append two models to `prisma/schema.prisma` (snake_case columns via `@map`, role as a validated `String` to match the existing `Org.origin` / `Ask.status` convention — no Prisma enum).

```prisma
model OrgMembership {
  id         Int      @id @default(autoincrement())
  user_id    Int
  org_id     Int
  role       String   @default("member") // 'owner' | 'member' (co-admin)
  created_at DateTime @default(now())
  user       User     @relation(fields: [user_id], references: [id], onDelete: Cascade)
  org        Org      @relation(fields: [org_id], references: [id], onDelete: Cascade)
  @@unique([user_id, org_id])
  @@index([org_id])
  @@map("org_memberships")
}

model Invitation {
  id                  Int       @id @default(autoincrement())
  token               String    @unique
  org_id              Int
  email               String    // normalized (trim + lowercase)
  role                String    @default("member")
  invited_by_user_id  Int?
  expires_at          DateTime
  accepted_at         DateTime? // null = still acceptable
  accepted_by_user_id Int?
  created_at          DateTime  @default(now())
  org         Org   @relation(fields: [org_id], references: [id], onDelete: Cascade)
  invited_by  User? @relation("InvitationInvitedBy",  fields: [invited_by_user_id],  references: [id], onDelete: SetNull)
  accepted_by User? @relation("InvitationAcceptedBy", fields: [accepted_by_user_id], references: [id], onDelete: SetNull)
  @@index([org_id])
  @@index([org_id, email])
  @@map("invitations")
}
```

Add back-relations to existing models: on `User` — `memberships OrgMembership[]`, `invites_sent Invitation[] @relation("InvitationInvitedBy")`, `invites_accepted Invitation[] @relation("InvitationAcceptedBy")`; on `Org` — `memberships OrgMembership[]`, `invitations Invitation[]`. (`Org.owner_user_id` stays as the authoritative single owner; an `owner` membership row mirrors it so all access goes through one table.)

**Migration:** `npx prisma migrate dev --create-only --name add_memberships_invitations`, then **append** an idempotent backfill so existing owners keep access, then apply with `npm run db:dev`:

```sql
INSERT INTO "org_memberships" ("user_id", "org_id", "role", "created_at")
SELECT "owner_user_id", "id", 'owner', CURRENT_TIMESTAMP
FROM "orgs" WHERE "owner_user_id" IS NOT NULL
ON CONFLICT ("user_id", "org_id") DO NOTHING;
```

---

## 2. Email layer (new `src/infrastructure/email/`)

Mirror the existing infra-adapter layout. Three files.

**`templates/inviteEmail.js`** — react-email template, pure CommonJS. `react`/`react-dom` are CJS (`require` ok); `@react-email/components` + `@react-email/render` are ESM, loaded once via memoized dynamic `import()`. Build the tree with `React.createElement`, then `render(tree, { pretty: true })` for HTML and `render(tree, { plainText: true })` for the text fallback. Export `renderInviteEmail({ orgName, inviterEmail, acceptUrl }) → { html, text }`. Style it in the project's terminal aesthetic.

**`sesClient.js`** — `@aws-sdk/client-ses` (v3, CJS — plain `require`). Lazily construct one `SESClient({ region: config.email.region })` per process (so importing the module never touches AWS and the app boots without creds — credentials come from the SDK default provider chain: env vars in dev, IAM role in prod). Export `sendEmail({ to, subject, html, text }) → MessageId` using `SendEmailCommand` with `Source: config.email.from`. Throws on SES failure (caller owns UX).

**`index.js`** — the single public API the route calls:
```js
async function sendInviteEmail({ to, orgName, inviterEmail, acceptUrl }) {
  const subject = `${inviterEmail} invited you to ${orgName} on canany`;
  const { html, text } = await renderInviteEmail({ orgName, inviterEmail, acceptUrl });
  if (!config.email.enabled) { console.log(`[email:disabled] invite for ${to} -> ${acceptUrl}`); return { delivered: false }; }
  return { delivered: true, messageId: await sendEmail({ to, subject, html, text }) };
}
```

Optional `scripts/preview-email.js` + `"email:preview"` npm script that prints the rendered HTML for local design iteration (no new dep).

---

## 3. Config & env (`src/config/index.js`, `.env.example`)

Add an `email` group plus `web.appUrl`, following the existing `need()` / feature-flag pattern. Email is **off by default** so the app boots with no AWS account:

- `email.enabled` — an env toggle, off unless explicitly `true`.
- When on, `need()` the SES region and the verified from-address; `email.region`
  defaults to `us-east-1`, `email.from` to null.
- `web.appUrl` — optional env override; falls back to the request-derived base.

`.env.example` additions (names to be chosen when this ships, so the deploy
doctor doesn't see them before the code reads them): the email toggle, the SES
region and from-address, the AWS credential pair, and the app URL. Document that
**SES starts in sandbox mode** (only sends to verified addresses until production
access is requested) and that with email off invite links are logged to the console — the invite record is still created and the link is fully valid, so the whole accept flow is testable offline.

---

## 4. Membership-aware access (`src/application/web/routes.js`, repos)

New **`src/infrastructure/db/membershipsRepository.js`**: `addMembership({userId,orgId,role})` (idempotent upsert, `update:{}` so it never downgrades), `getMembership(userId,orgId)`, `listOrgsForUser(userId)` (returns each org with the user's `role` attached), `listMembers(orgId)` (email + role + joined-at), `removeMember(orgId,userId)` (`deleteMany where org_id, user_id, role: { not: 'owner' }` — this is the owner-protection / no-self-lockout guard).

Changes in `routes.js`:
- **Replace `loadOwnedOrg` with role-aware `loadOrg(req, res, requiredRole = null)`**: 404 (never 403, no existence leak) if the user has no membership, or if `requiredRole === 'owner'` and their role isn't owner. Sets `req.membershipRole`.
- **`resolveCurrentOrg`**: swap `orgs.listOrgsByUser` → `memberships.listOrgsForUser`. Org switching via `?org=` now matches any org the user belongs to; `current.role` becomes available to views.
- **`orgsRepository.createOrg`**: wrap in `prisma.$transaction` to atomically create the org **and** the creator's `owner` membership (bot-side "migrated" orgs pass no `ownerUserId` and get no membership). Remove the now-dead `orgsRepository.listOrgsByUser`.
- **Route guards** (co-admin policy): `GET /orgs/:id`, `POST /orgs/:id/token`, `POST /orgs/:id/invite`, `POST /orgs/:id/invite/:inviteId/revoke` → `loadOrg(req,res)` (any member). `POST /orgs/:id/members/:userId/remove` → `loadOrg(req,res,'owner')`.
- **`index.ejs`** manage link: show to all members (co-admins manage), not just owners.

---

## 5. Invitation repo & flows

New **`src/infrastructure/db/invitationsRepository.js`** (mirrors `tokensRepository`): 
- `createInvite({orgId,email,role,invitedByUserId,ttlMs=7d})` — in a transaction, expire any outstanding live invite for `org_id+email` (burn-then-mint, like `regenerateConnectToken`), then create a fresh row with `token = crypto.randomBytes(18).toString('base64url')`.
- `findByToken(token)` (include `org`), `listPending(orgId)` (unaccepted, unexpired).
- `consumeInvite({token,userId})` — **guarded single-use** like `tokensRepository.consumeToken`: in a transaction, validate not-expired, `updateMany({where:{token, accepted_at:null}, data:{accepted_at, accepted_by_user_id}})`, then idempotent `orgMembership.upsert` (`update:{}`). Returns `{ok, orgId}`. Handles double-accept and owner-accepts-own-invite benignly.
- `revokePending(orgId, inviteId)` — `deleteMany where id, org_id, accepted_at:null`.

**Invite creation — `POST /orgs/:id/invite`** (`requireAuth`, `verifyCsrf`, `loadOrg`): validate with existing `EMAIL_RE` + `normalizeEmail`; reject self-invite; if the email is already a member, no-op flash (no email); else `createInvite`, build `acceptUrl = ${config.web.appUrl || req.protocol+'://'+req.get('host')}/invite/${token}` (`trust proxy` is already on), then `sendInviteEmail` inside `try/catch` so an SES failure **never 500s** — on failure, flash the accept link for manual sharing. PRG-redirect to `/orgs/:id`.

**Accept flow** (literal `/invite/...` routes registered before `:param` routes; `GET` is **not** behind `requireAuth`):
- **`GET /invite/:token`** — `findByToken`; if missing/accepted/expired → render `invite.ejs` `state:'invalid'`. Else branch on session: logged in as the invited email → `state:'accept'` (shows the accept POST form, mint CSRF); logged in as a different email → `state:'wrong-account'` (offers logout); logged out → `state:'guest'` with `Create account → /signup?next=/invite/<token>` and `Log in → /login?next=/invite/<token>`.
- **Auth handoff:** add a strict `safeNext` helper (`/^\/invite\/[A-Za-z0-9_-]+$/` only — no open redirect). `GET/POST /login` and `/signup` carry `next` (hidden field) and redirect to it on success. In `POST /signup`, **bypass the `SIGNUP_CODE` gate** only when `next` resolves to a live invite whose `email` equals the signup email; pre-fill + `readonly` the email field in that case.
- **`POST /invite/:token`** (`requireAuth`, `verifyCsrf`) — re-check email-lock (403 `wrong-account` on mismatch), `consumeInvite`, set `req.session.orgId = orgId`, redirect to `/` (board with the new org active).

**Full management UI:** `POST /orgs/:id/invite/:inviteId/revoke` (any member) → `revokePending`; `POST /orgs/:id/members/:userId/remove` (owner only) → `removeMember` (refuses owner rows). Both flash + PRG-redirect to `/orgs/:id`.

A minimal **flash** mechanism (cookie-session-native): handlers set `req.session.flash = { type, msg }`; `GET /orgs/:id` reads then deletes it and passes to the view.

---

## 6. Views (`src/presentation/web/views/`)

- **New `invite.ejs`** — accept landing page using `partials/{head,form-styles,foot}`, same shell as `login.ejs`. Branches on `state`: `accept` (Join `<org>` form), `guest` (signup/login CTAs carrying `?next`), `wrong-account` (mismatch + logout form), `invalid` (friendly dead-link message).
- **`org.ejs`** additions: a flash banner (add an `.ok` style alongside the existing `.err`); an **"Invite a teammate"** form (`POST /orgs/:id/invite`, `_csrf`); a **Members** list (email + role badge; non-owner rows get a remove form, owner-only); a **Pending invites** list (email + sent-time, each with resend + revoke forms). `GET /orgs/:id` passes `{ org, token, connectedGroups, botLink, members, pendingInvites, flash, role }`.
- **`signup.ejs` / `login.ejs`**: hidden `next` input + `?next=` on cross-links; in signup, render email `value`+`readonly` when `lockedEmail`.

---

## 7. Edge cases

Expired/already-accepted token → `invalid`. Email mismatch → `wrong-account` (GET) / 403 (POST), never consumed. Invite existing member → no-op flash, no email. Self-invite → blocked. Resend → burn-then-mint kills the old link. `SIGNUP_CODE` → bypassed only for a live, email-matching invite. Owner accepts own invite / concurrent double-accept → idempotent upsert, no downgrade. Remove member → instant access loss on next request (`resolveCurrentOrg` drops the org); owner row is unremovable. Open-redirect via `next` → blocked by `safeNext` allowlist. SES failure → invite still valid, link surfaced for manual sharing.

---

## 8. Verification (end-to-end, single process, web on, email off)

1. Run the migration (`npm run db:dev`); confirm existing owners got `owner` membership rows.
2. user1 signs up → creates Org A → lands on `/orgs/<A>` with an `owner` membership (created in the same transaction).
3. user1 submits the Invite form with user2's email → invite row created; accept link printed to the server console; org page shows user2 under **Pending invites**.
4. In a logged-out browser, open the accept link → `guest` page → "Create account" → `/signup?next=/invite/<token>` (email pre-filled/locked); signup succeeds even with `SIGNUP_CODE` set.
5. Redirected to `GET /invite/<token>` → `accept` → Join → membership created (`member`/co-admin), `session.orgId = A`, redirected to `/`; user2's board shows Org A and the org switcher lists it.
6. As a co-admin, user2 can open `/orgs/<A>`, invite a third teammate, and regenerate the connect token; user2 **cannot** remove members.
7. Reload `/orgs/<A>` as user1 → user2 appears under **Members**; pending invite gone. user1 removes user2 → user2 loses Org A on next request; user1 cannot remove themselves.
8. (Optional, real SES) verify a from + to address in the SES sandbox, turn the email toggle on + region + creds, confirm the react-email HTML arrives. Preview the template anytime with `npm run email:preview`.

---

## Dependencies & footprint

**New prod deps:** `@aws-sdk/client-ses`, `@react-email/components`, `@react-email/render`, `react`, `react-dom`. **Dev:** none. **New npm script:** `email:preview`. Takes the project from 7 → ~12 prod deps (the AWS SDK is unavoidable for SES; the no-build createElement approach is the lightest way to honor the react-email request without adding a build step or loader).

## Critical files
- `prisma/schema.prisma` (+ new migration under `prisma/migrations/`)
- `src/config/index.js`, `.env.example`, `package.json`
- `src/infrastructure/email/{index,sesClient,templates/inviteEmail}.js` (new), `scripts/preview-email.js` (new, optional)
- `src/infrastructure/db/membershipsRepository.js`, `src/infrastructure/db/invitationsRepository.js` (new); `src/infrastructure/db/orgsRepository.js` (createOrg transaction, drop listOrgsByUser)
- `src/application/web/routes.js` (loadOrg, resolveCurrentOrg, invite/accept/manage routes, safeNext, signup gate bypass, flash)
- `src/presentation/web/views/invite.ejs` (new); `org.ejs`, `index.ejs`, `signup.ejs`, `login.ejs`
