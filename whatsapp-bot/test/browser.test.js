import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

/** Drives the real browser tools against a tiny local shop page. */

const PAGE = `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>חנות בדיקה</title></head>
<body>
  <h1>פיצה בדיקה</h1>
  <p>פיצה משפחתית - 60 ₪</p>
  <input id="q" placeholder="חיפוש במנה">
  <button onclick="document.getElementById('cart').textContent='בסל: 1'">הוסף לסל</button>
  <div id="cart">הסל ריק</div>
  <button onclick="document.body.innerHTML='<h2>ההזמנה בוצעה! מספר 123</h2>'">שלם עכשיו</button>
</body></html>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGE);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bot-browser-"));
// In environments with a preinstalled Chromium, point Playwright at it.
if (!process.env.BROWSER_EXECUTABLE_PATH && fs.existsSync("/opt/pw-browsers/chromium")) {
  const dir = fs.readdirSync("/opt/pw-browsers").find((d) => /^chromium-\d+$/.test(d));
  if (dir) process.env.BROWSER_EXECUTABLE_PATH = `/opt/pw-browsers/${dir}/chrome-linux64/chrome`;
}

const { runTool } = await import("../src/tools.js");
const { approvals } = await import("../src/approvals.js");
const { closeBrowser } = await import("../src/browser.js");

after(async () => {
  await closeBrowser();
  server.close();
});

const ctx = { chatId: "browser-test", io: { sendText: async () => {}, sendImage: async () => {}, sendToNumber: async () => ({ ok: true }) } };
const url = `http://127.0.0.1:${server.address().port}/`;

function refFor(snapshot, label) {
  const line = snapshot.split("\n").find((l) => l.includes(`"${label}"`));
  assert.ok(line, `element "${label}" missing from snapshot:\n${snapshot}`);
  return Number(line.match(/^\[(\d+)\]/)[1]);
}

test("browse, add to cart, and the pay button is gated by approval", async () => {
  const opened = await runTool("browser_open", { url }, ctx);
  assert.ok(!opened.isError, opened.content);
  assert.match(opened.content, /פיצה משפחתית - 60 ₪/);

  const add = refFor(opened.content, "הוסף לסל");
  const afterAdd = await runTool("browser_click", { ref: add }, ctx);
  assert.match(afterAdd.content, /בסל: 1/);

  const typed = await runTool("browser_type", { ref: refFor(afterAdd.content, "חיפוש במנה"), text: "זיתים" }, ctx);
  assert.match(typed.content, /value="זיתים"/);

  const card = await runTool("browser_type", { ref: refFor(typed.content, "חיפוש במנה"), text: "4580 1234 5678 9012" }, ctx);
  assert.equal(card.isError, true);

  const pay = refFor(typed.content, "שלם עכשיו");
  const blocked = await runTool("browser_click", { ref: pay }, ctx);
  assert.equal(blocked.isError, true);
  assert.match(blocked.content, /BLOCKED/);

  approvals.request(ctx.chatId, "פיצה משפחתית 60 ₪");
  approvals.approve(ctx.chatId);
  const paid = await runTool("browser_click", { ref: pay }, ctx);
  assert.ok(!paid.isError, paid.content);
  assert.match(paid.content, /ההזמנה בוצעה! מספר 123/);

  const shot = await runTool("browser_screenshot", {}, ctx);
  assert.equal(shot.content[0].type, "image");
  assert.ok(shot.content[0].source.data.length > 1000);
});
