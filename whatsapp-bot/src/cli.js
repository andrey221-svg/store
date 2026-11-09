import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { handleIncoming } from "./assistant.js";
import { closeBrowser } from "./browser.js";
import { config } from "./config.js";

/**
 * Talk to the assistant from the terminal - the same brain as the WhatsApp bot,
 * without connecting WhatsApp. Good for trying it out. Screenshots are saved to data/.
 */

if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  console.warn("⚠️  לא נמצא ANTHROPIC_API_KEY. העתק את .env.example ל-.env והכנס את המפתח שלך.");
}

const chatId = "cli";
let shot = 0;

const io = {
  async sendText(text) {
    console.log(`\n🤖 ${text}\n`);
  },
  async sendImage(buffer, caption = "") {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const file = path.join(config.dataDir, `screenshot-${++shot}.jpg`);
    fs.writeFileSync(file, buffer);
    console.log(`\n🖼️  ${caption} (נשמר ב-${file})\n`);
  },
  async sendToNumber(number, text) {
    console.log(`\n📤 [מצב בדיקה - לא נשלח באמת] אל ${number}:\n${text}\n`);
    return { ok: true };
  },
};

const rl = readline.createInterface({ input, output });
console.log(`מצב בדיקה בטרמינל (מודל: ${config.model}). כתוב הודעה, או "יציאה" כדי לצאת.\n`);

while (true) {
  const line = (await rl.question("אתה: ")).trim();
  if (!line) continue;
  if (["יציאה", "exit", "quit"].includes(line)) break;
  await handleIncoming(chatId, { text: line }, io);
}

rl.close();
await closeBrowser().catch(() => {});
