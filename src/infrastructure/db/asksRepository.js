// Data-access layer for the `asks` table — Prisma client, same function
// signatures and snake_case return shape the rest of the app already expects.
const { prisma } = require('./prisma');
const { STATUS_ORDER } = require('../../domain/constants');

// Telegram ids are stored as text. null/undefined stays null.
const str = (v) => (v === null || v === undefined ? null : String(v));

// Run a guarded status change: only flips when the ask is in an allowed state.
// Mirrors the old `UPDATE ... WHERE status IN (...)` guard. Returns the updated
// row, or null when the transition wasn't allowed (already taken/closed).
async function guardedTransition(id, fromStatuses, data) {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.ask.updateMany({
      where: { id, status: { in: fromStatuses } },
      data,
    });
    if (count === 0) return null;
    return tx.ask.findUnique({ where: { id } });
  });
}

async function createAsk({ ask, asker, askerId, effort, urgency, threadLink, chatId, topicId, msgId, orgId }) {
  return prisma.ask.create({
    data: {
      ask,
      asker,
      asker_id: str(askerId),
      effort,
      urgency,
      thread_link: str(threadLink),
      tg_chat_id: str(chatId),
      tg_topic_id: str(topicId),
      tg_msg_id: str(msgId),
      // Denormalized org snapshot — resolved from the group before we get here.
      // Defaults to null so a legacy/unscoped caller can't crash on a missing org.
      org_id: orgId ?? null,
    },
  });
}

async function setCardId(id, cardId) {
  await prisma.ask.update({ where: { id }, data: { tg_card_id: str(cardId) } });
}

// Insert one attachment row for an ask. Called once per successfully-stored file,
// so attachment capture stays best-effort per file — one failed upload never sinks
// the ask. s3_key is null when the file was too large to fetch from Telegram.
async function addAttachment(askId, att) {
  return prisma.askAttachment.create({
    data: {
      ask_id: askId,
      kind: att.kind,
      s3_key: att.s3_key ?? null,
      tg_file_id: str(att.tg_file_id),
      tg_file_unique_id: str(att.tg_file_unique_id),
      file_name: att.file_name ?? null,
      mime_type: att.mime_type ?? null,
      file_size: att.file_size ?? null,
      width: att.width ?? null,
      height: att.height ?? null,
    },
  });
}

async function getAsk(id) {
  return prisma.ask.findUnique({ where: { id } });
}

// Asker sets urgency (any time before it closes); claimer sets effort (only
// while claimed). Guarded so a concurrent close can't write onto a done ask,
// and so a vanished row returns null instead of throwing. Returns the row or null.
async function setUrgency(id, urgency) {
  return guardedTransition(id, ['open', 'claimed'], { urgency });
}

async function setEffort(id, effort) {
  return guardedTransition(id, ['claimed'], { effort });
}

// open -> claimed. Returns null if it wasn't claimable.
async function claimAsk(id, who, whoId) {
  return guardedTransition(id, ['open'], {
    status: 'claimed',
    claimer: who,
    claimer_id: str(whoId),
    claimed_at: new Date(),
  });
}

// claimed -> done. Returns null if not currently claimed.
async function doneAsk(id, outcome) {
  return guardedTransition(id, ['claimed'], {
    status: 'done',
    outcome,
    closed_at: new Date(),
  });
}

// Board rows, sorted by lifecycle (open -> claimed -> done) then age.
// Active asks are all shown; closed ones are capped to the most recent so the
// board can't grow past Telegram's 4096-char message limit as history piles up.
const DONE_ON_BOARD = 15;
async function listAsks(orgId) {
  const [active, recentDone] = await Promise.all([
    prisma.ask.findMany({
      where: { org_id: orgId, status: { in: ['open', 'claimed'] } },
      orderBy: { created_at: 'asc' },
      include: { attachments: { orderBy: { id: 'asc' } } },
    }),
    prisma.ask.findMany({
      where: { org_id: orgId, status: 'done' },
      orderBy: { closed_at: 'desc' },
      take: DONE_ON_BOARD,
      include: { attachments: { orderBy: { id: 'asc' } } },
    }),
  ]);
  const rank = (s) => {
    const i = STATUS_ORDER.indexOf(s);
    return i === -1 ? STATUS_ORDER.length : i;
  };
  // Stable sort keeps each group's order (active by age, done by most-recent).
  return [...active, ...recentDone].sort((a, b) => rank(a.status) - rank(b.status));
}

async function stalledAsks(orgId, days) {
  const cutoff = new Date(Date.now() - days * 86400000);
  return prisma.ask.findMany({
    where: { org_id: orgId, status: 'open', created_at: { lt: cutoff } },
    orderBy: { created_at: 'asc' },
  });
}

// Builders for the current calendar month. Kept as raw SQL — the UNION ALL +
// FILTER + date_trunc shape isn't worth expressing in the query builder.
async function leaderboard(orgId) {
  // org_id is filtered in EACH of the three UNION ALL arms — every ${orgId} is
  // bound as its own query parameter by $queryRaw (no string interpolation).
  return prisma.$queryRaw`
    SELECT person,
           COUNT(*) FILTER (WHERE kind='shipped') AS shipped,
           COUNT(*) FILTER (WHERE kind='helped')  AS helped,
           COUNT(*) FILTER (WHERE kind='raised')  AS raised
    FROM (
      SELECT claimer AS person, 'shipped' AS kind FROM asks
        WHERE status='done' AND claimer IS NOT NULL
          AND org_id = ${orgId}
          AND closed_at >= date_trunc('month', now())
      UNION ALL
      SELECT claimer AS person, 'helped' AS kind FROM asks
        WHERE status='claimed' AND claimer IS NOT NULL
          AND org_id = ${orgId}
          AND claimed_at >= date_trunc('month', now())
      UNION ALL
      SELECT asker AS person, 'raised' AS kind FROM asks
        WHERE asker IS NOT NULL
          AND org_id = ${orgId}
          AND created_at >= date_trunc('month', now())
    ) t
    WHERE person IS NOT NULL AND person <> ''
    GROUP BY person
    ORDER BY shipped DESC, helped DESC, raised DESC
    LIMIT 15`;
}

// One attachment plus the org its ask was raised under, for the serve path
// (GET /attachments/:id) to check ownership before streaming the file.
async function getAttachment(id) {
  return prisma.askAttachment.findUnique({
    where: { id },
    include: { ask: { select: { org_id: true } } },
  });
}

module.exports = {
  createAsk, setCardId, addAttachment, getAttachment, getAsk, setUrgency, setEffort,
  claimAsk, doneAsk, listAsks, stalledAsks,
  leaderboard,
};
