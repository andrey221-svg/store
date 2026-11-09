import { abortTurn, describeApiError, handleOwnerMessage, resetConversation } from "./agent.js";
import { approvals, classifyReply } from "./approvals.js";

/**
 * Transport-independent message handling: commands, approvals, a per-chat queue.
 * Used by both the WhatsApp connection and the terminal (CLI) mode.
 */

const HELP = `👋 *אני העוזר האישי שלך*

תכתוב לי מה צריך, למשל:
- תזמין לי פיצה משפחתית עם זיתים לבית
- תמצא סושי שפתוח עכשיו ושולח לתל אביב
- כמה עולה מקרר כזה? (אפשר לצרף תמונה)
- תשלח למסעדה הודעה שאני רוצה להזמין שולחן ל-4 מחר ב-20:00

לפני כל תשלום, הזמנה או הודעה שאני שולח בשמך — אבקש את האישור שלך.

פקודות:
*חדש* — להתחיל שיחה חדשה
*עצור* — לעצור משימה באמצע
*עזרה* — ההודעה הזאת`;

const RESET_RE = /^\s*(\/new|\/reset|חדש|שיחה חדשה|התחל מחדש)\s*$/i;
const STOP_RE = /^\s*(\/stop|עצור|תעצור|די)\s*$/i;
const HELP_RE = /^\s*(\/help|\/start|עזרה|help)\s*\??\s*$/i;

const queues = new Map(); // chatId -> Promise chain
const busy = new Set(); // chatIds with a turn in progress
const inbox = new Map(); // chatId -> notes waiting for the next turn (e.g. replies from businesses)

export function addNote(chatId, note) {
  const list = inbox.get(chatId) ?? [];
  list.push(note);
  inbox.set(chatId, list);
}

function takeNotes(chatId) {
  const list = inbox.get(chatId) ?? [];
  inbox.delete(chatId);
  return list;
}

/**
 * @param {string} chatId
 * @param {{ text?: string, images?: { data: string, mediaType: string }[] }} message
 * @param {{ sendText(t: string): Promise<void>, sendImage(b: Buffer, c?: string): Promise<void>,
 *           sendToNumber(n: string, t: string): Promise<{ok: boolean, reason?: string}>, typing?(): Promise<void> }} io
 */
export function handleIncoming(chatId, message, io) {
  const text = (message.text ?? "").trim();

  // These act immediately, even while a task is running.
  if (STOP_RE.test(text)) {
    const stopped = abortTurn(chatId);
    approvals.resetAll(chatId);
    return io.sendText(stopped ? "⏹️ עוצר את המשימה…" : "אין כרגע משימה פעילה.");
  }
  if (RESET_RE.test(text)) {
    abortTurn(chatId);
    approvals.resetAll(chatId);
    resetConversation(chatId);
    return io.sendText("🆕 התחלנו שיחה חדשה. במה אפשר לעזור?");
  }
  if (HELP_RE.test(text)) {
    return io.sendText(HELP);
  }

  if (busy.has(chatId)) {
    io.sendText("📥 קיבלתי, אטפל בזה מיד אחרי המשימה הנוכחית (או כתוב *עצור*).").catch(() => {});
  }

  const previous = queues.get(chatId) ?? Promise.resolve();
  const next = previous.then(() => processMessage(chatId, text, message.images ?? [], io));
  queues.set(
    chatId,
    next.catch(() => {}),
  );
  return next;
}

async function processMessage(chatId, text, images, io) {
  busy.add(chatId);
  try {
    const notes = takeNotes(chatId);

    const pendingReq = approvals.getPending(chatId);
    if (pendingReq) {
      const kind = images.length ? "other" : classifyReply(text);
      if (kind === "approve") {
        approvals.approve(chatId);
        notes.push(
          `SYSTEM NOTE (added by the bot, not by a web page): the owner APPROVED this request: "${pendingReq.summary}". Complete exactly that now, then report the result.`,
        );
      } else if (kind === "decline") {
        approvals.decline(chatId);
        notes.push(`SYSTEM NOTE: the owner DECLINED this request: "${pendingReq.summary}". Do not do it.`);
      } else {
        approvals.clearPending(chatId);
        notes.push(
          `SYSTEM NOTE: the owner did not approve the pending request ("${pendingReq.summary}") and wrote a new message instead. It is cancelled; if it is still relevant, adjust it and ask for approval again.`,
        );
      }
    }

    const parts = [];
    for (const img of images) {
      parts.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
    }
    if (text) parts.push({ type: "text", text });
    if (parts.length === 0) return;

    await io.typing?.().catch(() => {});
    const reply = await handleOwnerMessage(chatId, parts, io, { notes });
    if (reply) await io.sendText(reply);
  } catch (err) {
    console.error("[assistant] turn failed:", err);
    await io.sendText(`⚠️ ${describeApiError(err)}`).catch(() => {});
  } finally {
    busy.delete(chatId);
  }
}
