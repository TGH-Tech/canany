// Incoming messages: outcome capture (the reply that closes a 'done' ask) and
// new asks (an #ask-prefixed message, optionally carrying files, in a group).
// Slash commands are handled separately in ../commands.js.
const config = require('../../config');
const db = require('../../infrastructure/db/asksRepository');
const groups = require('../../infrastructure/db/groupsRepository');
const storage = require('../../infrastructure/storage/s3');
const tgFiles = require('../../infrastructure/telegram/files');
const views = require('../../presentation/views');
const { displayName, threadLink, keyboardFor, threadOpts, parseOutcomePrompt } = require('../../presentation/keyboards');
const { refreshCard } = require('../cards');
const { extractAttachments, bufferAlbum } = require('../attachments');

const ASK_PREFIX = config.behavior.askPrefix;

// Split "#ask" into its leading symbol ("#") and word ("ask") so the two can be
// matched independently: case-insensitively, and with optional whitespace
// between them (so "#ask", "#Ask", "# ask", "# Ask" all match).
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const prefixParts = ASK_PREFIX.match(/^(\W+)(\w+)$/);
const ASK_PATTERN = prefixParts
  ? new RegExp(`^${escapeRegex(prefixParts[1])}\\s*${escapeRegex(prefixParts[2])}(?=\\s|$)`, 'i')
  : new RegExp(`^${escapeRegex(ASK_PREFIX)}(?=\\s|$)`, 'i');

// The Telegram Bot API can't download a file larger than this, so it can't be
// copied to S3 — such a file is recorded with no key and shown as a "view in
// Telegram" link on the board instead of a thumbnail.
const MAX_TG_DOWNLOAD = 20 * 1024 * 1024;

// Parse an ask body out of message text. Returns the trimmed request, or null if
// the text isn't a well-formed ask ("#asking ..." and a bare "#ask" are rejected).
function parseAsk(text) {
  const match = ASK_PATTERN.exec(text);
  if (!match) return null;
  return text.slice(match[0].length).trim() || null; // null for a bare "#ask" with no body
}

// Store an ask's files best-effort and concurrently, after the card is posted, so
// the asker never waits on uploads. Per file: skip S3 if it's over the Telegram
// download limit (record link-only), else copy Telegram -> S3. A failure of one
// file never affects the ask or the other files.
async function storeAttachments(row, orgId, attachments) {
  await Promise.allSettled(attachments.map(async (att, index) => {
    let s3Key = null;
    const tooBig = att.file_size != null && att.file_size > MAX_TG_DOWNLOAD;
    if (tooBig) {
      console.warn(`ask #${row.id}: ${att.file_name || att.kind} over 20MB — stored as a Telegram link only`);
    } else {
      try {
        s3Key = await storage.putAttachment({
          orgId,
          askId: row.id,
          index,
          fileUniqueId: att.tg_file_unique_id,
          body: tgFiles.getStream(att.tg_file_id),
          contentType: att.mime_type,
        });
      } catch (err) {
        // Fall through with a null key so the file still shows as a Telegram link.
        console.error(`ask #${row.id}: upload of attachment ${index} failed:`, err.message);
      }
    }
    try {
      await db.addAttachment(row.id, { ...att, s3_key: s3Key });
    } catch (err) {
      console.error(`ask #${row.id}: saving attachment ${index} failed:`, err.message);
    }
  }));
}

// Create an ask from its lead message (the one carrying the #ask), post the card,
// then store any attachments. Shared by the single-message and album paths.
async function handleNewAsk(bot, lead, askText, attachments) {
  const chatId = lead.chat.id;

  // An ask must land in a connected group so it gets an org and shows on a board.
  // A DM or an unconnected group gets a hint instead of an orphan (org-less) ask.
  if (lead.chat.type === 'private') {
    await bot.sendMessage(chatId, '#ask works inside a connected group — add the bot to your group and run /connect <token>.', threadOpts(lead));
    return;
  }
  const orgId = await groups.orgIdForChat(chatId);
  if (orgId == null) {
    await bot.sendMessage(chatId, "This group isn't linked yet. Run /connect <token> with a token from your org page.", threadOpts(lead));
    return;
  }

  const asker = displayName(lead.from);
  const row = await db.createAsk({
    ask: askText,
    asker,
    askerId: lead.from.id,
    effort: null,
    urgency: null,
    threadLink: threadLink(chatId, lead.message_thread_id, lead.message_id),
    chatId,
    topicId: lead.message_thread_id || null,
    msgId: lead.message_id,
    orgId,
  });

  const sent = await bot.sendMessage(chatId, views.card(row), {
    message_thread_id: lead.message_thread_id,
    parse_mode: 'HTML',
    reply_markup: keyboardFor(row),
  });
  await db.setCardId(row.id, sent.message_id);

  // Attachments run after the card so the asker gets instant confirmation.
  if (!attachments.length) return;
  if (!config.storage.enabled) {
    console.warn(`ask #${row.id}: ${attachments.length} attachment(s) dropped — S3 storage not configured`);
    return;
  }
  await storeAttachments(row, orgId, attachments);
}

// An album (several files sent together) arrives as separate messages sharing a
// media_group_id, with the #ask caption on just one. Find that lead; if none, the
// album isn't an ask. Every member's file is attached to the one ask.
async function handleAlbum(bot, members) {
  const lead = members.find((m) => parseAsk((m.text || m.caption || '').trim()) !== null);
  if (!lead) return;
  const askText = parseAsk((lead.text || lead.caption || '').trim());
  const attachments = members.flatMap(extractAttachments);
  await handleNewAsk(bot, lead, askText, attachments);
}

function register(bot) {
  bot.on('message', async (msg) => {
    try {
      // Albums are buffered and handled together once all members have arrived.
      if (msg.media_group_id) {
        bufferAlbum(msg, (members) => handleAlbum(bot, members));
        return;
      }

      // A file carries its text in msg.caption, a plain message in msg.text.
      const text = (msg.text || msg.caption || '').trim();
      const attachments = extractAttachments(msg);
      if (!text && !attachments.length) return;

      const chatId = msg.chat.id;
      const repliedTo = msg.reply_to_message;

      // 1) Outcome reply that closes a claimed ask — only a *text* reply to our
      //    ✅ Done prompt, matched statelessly via the ask id in the prompt text
      //    (so an outstanding prompt survives a bot restart).
      if (text && repliedTo?.from?.is_bot && !text.startsWith('/')) {
        const askId = parseOutcomePrompt(repliedTo.text);
        if (askId !== null) {
          const ask = await db.getAsk(askId);
          if (!ask) return; // ask vanished — ignore the stray reply

          // Only the claimer can close it (same rule as the callback handler).
          const isClaimer = ask.claimer_id
            ? String(msg.from.id) === ask.claimer_id
            : displayName(msg.from) === ask.claimer;
          if (!isClaimer) return;

          const closed = await db.doneAsk(askId, text);
          if (closed) {
            await refreshCard(bot, closed);
            await bot.sendMessage(chatId, `✅ Ask #${askId} closed. Outcome saved.`, threadOpts(msg));
          } else {
            await bot.sendMessage(chatId, `Couldn't close ask #${askId} — it may have changed.`, threadOpts(msg));
          }
          return;
        }
      }

      // 2) Slash commands are routed by ../commands.js — ignore them here.
      if (text.startsWith('/')) return;

      // 3) New ask (optionally with a single file).
      const askText = parseAsk(text);
      if (askText === null) return;
      await handleNewAsk(bot, msg, askText, attachments);
    } catch (err) {
      console.error('message handler error:', err.message);
    }
  });
}

module.exports = { register };
