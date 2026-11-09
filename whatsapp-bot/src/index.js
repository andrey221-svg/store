import { config } from "./config.js";
import { closeBrowser } from "./browser.js";
import { startWhatsApp } from "./whatsapp.js";

if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  console.warn("⚠️  לא נמצא ANTHROPIC_API_KEY. העתק את .env.example ל-.env והכנס את המפתח שלך.");
}

console.log(`🤖 מפעיל את הבוט (מודל: ${config.model})…`);
await startWhatsApp();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    console.log("\nסוגר…");
    await closeBrowser().catch(() => {});
    process.exit(0);
  });
}
