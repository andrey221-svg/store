import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

/**
 * Runs the real agent loop against a fake Messages API on localhost, so the
 * approval flow and history handling are tested without an API key or network.
 */

const requests = [];
const script = []; // queued fake responses

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = JSON.parse(body);
    requests.push({ url: req.url, headers: req.headers, body: parsed });
    const next = script.shift();
    if (!next) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "no scripted response" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: `msg_${requests.length}`,
        type: "message",
        role: "assistant",
        model: parsed.model,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
        ...next,
      }),
    );
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
after(() => server.close());

process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bot-agent-"));
process.env.BOT_MODEL = "claude-opus-5-5";
delete process.env.BOT_EFFORT;

const { handleIncoming } = await import("../src/assistant.js");
const { approvals } = await import("../src/approvals.js");
const { sessions } = await import("../src/storage.js");

function fakeIo() {
  const sent = [];
  const outbound = [];
  return {
    sent,
    outbound,
    async sendText(t) {
      sent.push(t);
    },
    async sendImage() {},
    async sendToNumber(n, t) {
      outbound.push({ n, t });
      return { ok: true };
    },
  };
}

test("order flow: approval is requested, outgoing message blocked until the owner approves", async () => {
  const chat = "owner@test";
  const io = fakeIo();

  // Turn 1: the model tries to message the restaurant without approval, then asks for approval.
  script.push(
    {
      stop_reason: "tool_use",
      content: [
        { type: "thinking", thinking: "", signature: "sig1" },
        {
          type: "tool_use",
          id: "tu_1",
          name: "send_whatsapp_message",
          input: { phone: "054-1112233", business_name: "פיצה בדיקה", message: "שלום, פיצה משפחתית למשלוח" },
        },
      ],
    },
    {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "tu_2",
          name: "request_approval",
          input: { summary: "הודעה לפיצה בדיקה: שלום, פיצה משפחתית למשלוח" },
        },
      ],
    },
    { stop_reason: "end_turn", content: [{ type: "text", text: "מחכה לאישור שלך." }] },
  );
  await handleIncoming(chat, { text: "תזמין לי פיצה מפיצה בדיקה" }, io);

  assert.equal(io.outbound.length, 0, "nothing may be sent before approval");
  const firstToolResult = requests[1].body.messages.at(-1).content[0];
  assert.equal(firstToolResult.is_error, true);
  assert.match(firstToolResult.content, /BLOCKED/);
  assert.ok(io.sent.some((t) => t.includes("נדרש אישור")), "approval card was sent to the owner");
  assert.ok(approvals.getPending(chat));

  // Request shape: betas, fallbacks, server tools, caching, context editing.
  const r0 = requests[0];
  assert.match(r0.url, /\/v1\/messages/);
  assert.match(r0.headers["anthropic-beta"], /context-management-2025-06-27/);
  assert.match(r0.headers["anthropic-beta"], /server-side-fallback-2026-07-01/);
  assert.equal(r0.body.fallbacks, "default");
  assert.equal(r0.body.model, "claude-opus-5-5");
  assert.deepEqual(r0.body.output_config, { effort: "medium" });
  assert.ok(r0.body.tools.some((t) => t.type === "web_search_20260209"));
  assert.ok(r0.body.tools.some((t) => t.type === "web_fetch_20260209"));
  assert.deepEqual(r0.body.context_management, { edits: [{ type: "clear_tool_uses_20250919" }] });
  assert.ok(!("thinking" in r0.body));

  // Turn 2: the owner approves; the model sends the message.
  script.push(
    {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "tu_3",
          name: "send_whatsapp_message",
          input: { phone: "054-1112233", business_name: "פיצה בדיקה", message: "שלום, פיצה משפחתית למשלוח" },
        },
      ],
    },
    { stop_reason: "end_turn", content: [{ type: "text", text: "שלחתי למסעדה ✅" }] },
  );
  const before = requests.length;
  await handleIncoming(chat, { text: "מאשר" }, io);

  assert.equal(io.outbound.length, 1);
  assert.equal(io.outbound[0].n, "972541112233");
  assert.equal(io.sent.at(-1), "שלחתי למסעדה ✅");
  const approvalTurn = requests[before].body.messages.at(-1);
  assert.match(approvalTurn.content[0].text, /APPROVED/);

  // History must be append-only: every request starts with the previous request's messages.
  for (let i = 1; i < requests.length; i++) {
    const prev = requests[i - 1].body.messages;
    const cur = requests[i].body.messages;
    assert.deepEqual(cur.slice(0, prev.length), prev, `request ${i} rewrote earlier history`);
  }
  // The thinking block is replayed unchanged.
  assert.deepEqual(requests.at(-1).body.messages[1].content[0], { type: "thinking", thinking: "", signature: "sig1" });

  const saved = sessions.load(chat);
  assert.equal(saved.messages.at(-1).role, "assistant");
});

test("an unrelated reply cancels a pending approval", async () => {
  const chat = "owner2@test";
  const io = fakeIo();
  script.push(
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "a1", name: "request_approval", input: { summary: "הזמנה ב-100 ₪" } }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "מחכה." }] },
  );
  await handleIncoming(chat, { text: "תזמין" }, io);
  assert.ok(approvals.getPending(chat));

  script.push({ stop_reason: "end_turn", content: [{ type: "text", text: "בסדר, הוספתי קולה." }] });
  const before = requests.length;
  await handleIncoming(chat, { text: "תוסיף גם קולה" }, io);
  assert.equal(approvals.getPending(chat), null);
  assert.equal(approvals.isApproved(chat), false);
  assert.match(requests[before].body.messages.at(-1).content[0].text, /did not approve/);
});

test("refusal and API errors leave a usable history", async () => {
  const chat = "owner3@test";
  const io = fakeIo();
  script.push({ stop_reason: "refusal", content: [] });
  await handleIncoming(chat, { text: "משהו" }, io);
  assert.match(io.sent.at(-1), /לא יכול לעזור/);
  assert.equal(sessions.load(chat).messages.at(-1).role, "assistant");

  // No scripted response -> the fake API returns 500 -> the owner gets an error message.
  await handleIncoming(chat, { text: "עוד משהו" }, io);
  assert.match(io.sent.at(-1), /⚠️/);
  const msgs = sessions.load(chat).messages;
  assert.equal(msgs.at(-1).role, "assistant", "the unanswered message was dropped");
});

test("commands: help, new conversation", async () => {
  const io = fakeIo();
  await handleIncoming("owner4@test", { text: "עזרה" }, io);
  assert.match(io.sent.at(-1), /העוזר האישי/);
  await handleIncoming("owner4@test", { text: "חדש" }, io);
  assert.match(io.sent.at(-1), /שיחה חדשה/);
});
