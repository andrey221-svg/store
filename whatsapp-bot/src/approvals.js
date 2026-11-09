import { config } from "./config.js";

/**
 * Money-spending and outward-facing actions are gated in code, not just in the prompt:
 * the model can only *request* approval, and only the owner's own WhatsApp reply grants it.
 * Text on a web page or in a tool result can never approve anything.
 */

const pending = new Map(); // chatId -> { summary, createdAt }
const approved = new Map(); // chatId -> { summary, until, usesLeft }

const MAX_USES_PER_APPROVAL = 3;

// Buttons that complete a purchase or send an order. Navigation steps such as
// "go to cart" / "לקופה" are deliberately not listed: those don't commit anything.
// JavaScript's \b does not understand Hebrew letters, so whole words are matched by hand.
const hebWord = (word) => new RegExp(`(^|[^\\u0590-\\u05FF])${word}($|[^\\u0590-\\u05FF])`);

const PURCHASE_PATTERNS = [
  hebWord("שלם"), hebWord("לשלם"), hebWord("שלמו"), hebWord("תשלום"), hebWord("לתשלום"),
  hebWord("רכישה"), hebWord("לרכישה"), hebWord("קנה"), hebWord("קנייה"),
  /בצע\/?י? ?(את ה)?הזמנה/, /ביצוע הזמנה/, /אישור הזמנה/, /אשר\/?י? ?(את ה)?הזמנה/,
  /שלח\/?י? ?(את ה)?הזמנה/, /שליחת הזמנה/, /סיום הזמנה/, /סיים הזמנה/, /הזמן עכשיו/, /הזמינו עכשיו/,
  /הזמינו/, /הזמן ושלם/,
  /\bpay\b/i, /pay now/i, /place (your )?order/i, /confirm (and pay|order|purchase|payment)/i,
  /complete (order|purchase|payment)/i, /submit order/i, /buy now/i, /^\s*order now\s*$/i,
  /checkout and pay/i, /send order/i,
];

export function looksLikePurchase(label) {
  if (!label) return false;
  const text = String(label).replace(/\s+/g, " ").trim();
  if (!text) return false;
  return PURCHASE_PATTERNS.some((re) => re.test(text));
}

// A run of 13-19 digits (optionally grouped) is almost certainly a card number.
export function looksLikeCardNumber(text) {
  const compact = String(text ?? "").replace(/[\s-]/g, "");
  return /\d{13,19}/.test(compact);
}

const APPROVE_RE = /^\s*(מאשר|מאשרת|מאושר|אשר|אישור|כן|כן מאשר|כן מאשרת|סגור|יאללה|yes|ok|okay|approve|approved|confirm)\s*[.!👍✅]*\s*$/i;
const DECLINE_RE = /^\s*(בטל|ביטול|לא|לא מאשר|לא מאשרת|עצור|no|cancel|stop)\s*[.!]*\s*$/i;

export function classifyReply(text) {
  if (APPROVE_RE.test(text ?? "")) return "approve";
  if (DECLINE_RE.test(text ?? "")) return "decline";
  return "other";
}

export const approvals = {
  request(chatId, summary) {
    approved.delete(chatId);
    pending.set(chatId, { summary, createdAt: Date.now() });
  },

  getPending(chatId) {
    return pending.get(chatId) ?? null;
  },

  /** Called only from the WhatsApp/CLI message handler when the owner replies. */
  approve(chatId) {
    const req = pending.get(chatId);
    if (!req) return null;
    pending.delete(chatId);
    approved.set(chatId, {
      summary: req.summary,
      until: Date.now() + config.approvalWindowMinutes * 60_000,
      usesLeft: MAX_USES_PER_APPROVAL,
    });
    return req;
  },

  decline(chatId) {
    const req = pending.get(chatId) ?? null;
    pending.delete(chatId);
    approved.delete(chatId);
    return req;
  },

  /** The owner wrote something other than yes/no: any pending request is void. */
  clearPending(chatId) {
    const req = pending.get(chatId) ?? null;
    pending.delete(chatId);
    return req;
  },

  isApproved(chatId) {
    const a = approved.get(chatId);
    if (!a) return false;
    if (Date.now() > a.until || a.usesLeft <= 0) {
      approved.delete(chatId);
      return false;
    }
    return true;
  },

  /** Spend one use of the current approval. Returns false if there is no valid approval. */
  consume(chatId) {
    if (!this.isApproved(chatId)) return false;
    const a = approved.get(chatId);
    a.usesLeft -= 1;
    return true;
  },

  resetAll(chatId) {
    pending.delete(chatId);
    approved.delete(chatId);
  },
};
