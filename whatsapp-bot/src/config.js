import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");

function bool(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Turns an Israeli/international phone number into WhatsApp's digits-only form.
 * "054-762-8636" -> "972547628636", "+972 54 762 8636" -> "972547628636".
 */
export function normalizePhone(raw, defaultCountry = "972") {
  if (!raw) return "";
  let digits = String(raw).replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = defaultCountry + digits.slice(1);
  // A local mobile number typed without the leading zero (e.g. 547628636).
  if (digits.length === 9 && digits.startsWith("5")) digits = defaultCountry + digits;
  return digits;
}

const dataDir = path.resolve(projectRoot, process.env.DATA_DIR || "data");

export const config = {
  projectRoot,
  dataDir,
  authDir: path.join(dataDir, "whatsapp-auth"),
  browserProfileDir: path.join(dataDir, "browser-profile"),
  sessionsDir: path.join(dataDir, "sessions"),

  // Claude
  model: process.env.BOT_MODEL || "claude-opus-5-5",
  effort: process.env.BOT_EFFORT ?? "medium",
  useFallbacks: bool(process.env.BOT_FALLBACKS, true),
  maxStepsPerMessage: int(process.env.MAX_STEPS_PER_MESSAGE, 40),
  sessionIdleHours: int(process.env.SESSION_IDLE_HOURS, 6),

  // WhatsApp
  ownerNumbers: (process.env.OWNER_NUMBER || "")
    .split(",")
    .map((n) => normalizePhone(n.trim()))
    .filter(Boolean),
  pairingNumber: normalizePhone(process.env.PAIRING_NUMBER || ""),

  // Browser
  browserHeadless: bool(process.env.BROWSER_HEADLESS, true),
  browserExecutablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined,
  browserIdleMinutes: int(process.env.BROWSER_IDLE_MINUTES, 15),

  // Approvals
  approvalWindowMinutes: int(process.env.APPROVAL_WINDOW_MINUTES, 15),

  // Location hints for web search
  city: process.env.USER_CITY || "",
  country: process.env.USER_COUNTRY || "IL",
  timezone: process.env.TZ_NAME || "Asia/Jerusalem",

  logLevel: process.env.LOG_LEVEL || "info",
};
