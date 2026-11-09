import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { launchContext } from "./browser.js";

/**
 * Opens the bot's browser profile in a visible window so you can log in to
 * delivery/shopping sites once. The bot reuses these logins later.
 * Usage: npm run login            (opens a few common sites)
 *        npm run login -- https://example.com
 */

const urls = process.argv.slice(2);
const defaults = ["https://wolt.com/he/isr", "https://www.10bis.co.il/", "https://www.mishloha.co.il/"];

const context = await launchContext({ headless: false });
const pages = context.pages();
const list = urls.length ? urls : defaults;
for (let i = 0; i < list.length; i++) {
  const page = i === 0 && pages[0] ? pages[0] : await context.newPage();
  await page.goto(list[i]).catch(() => {});
}

console.log("\nהתחבר לאתרים שאתה רוצה שהבוט ישתמש בהם (עם החשבון ואמצעי התשלום השמורים שלך).");
const rl = readline.createInterface({ input, output });
await rl.question("כשסיימת, לחץ Enter כדי לשמור ולסגור… ");
rl.close();
await context.close();
console.log("✅ נשמר. הבוט ישתמש בחיבורים האלה.");
