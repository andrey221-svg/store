import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bot-unit-"));
const { normalizePhone } = await import("../src/config.js");
const { approvals, classifyReply, looksLikeCardNumber, looksLikePurchase } = await import("../src/approvals.js");
const { repairAfterError } = await import("../src/agent.js");

test("normalizePhone handles Israeli formats", () => {
  assert.equal(normalizePhone("054-762-8636"), "972547628636");
  assert.equal(normalizePhone("+972 54 762 8636"), "972547628636");
  assert.equal(normalizePhone("00972547628636"), "972547628636");
  assert.equal(normalizePhone("547628636"), "972547628636");
  assert.equal(normalizePhone("03-5551234"), "97235551234");
  assert.equal(normalizePhone(""), "");
});

test("purchase buttons are recognised, navigation buttons are not", () => {
  for (const label of ["שלם עכשיו", "המשך לתשלום", "בצע הזמנה", "בצע/י הזמנה", "אישור הזמנה", "Place order", "Pay ₪84", "Buy now", "לשלם 120 ₪", "הזמינו עכשיו"]) {
    assert.ok(looksLikePurchase(label), `should block: ${label}`);
  }
  for (const label of ["הוסף לסל", "לקופה", "השלם פרטים", "Add to cart", "View cart", "חיפוש", "שלמה המלך 5", "Payments FAQ page"]) {
    assert.ok(!looksLikePurchase(label), `should allow: ${label}`);
  }
});

test("card numbers are detected", () => {
  assert.ok(looksLikeCardNumber("4580 1234 5678 9012"));
  assert.ok(looksLikeCardNumber("4580-1234-5678-9012"));
  assert.ok(!looksLikeCardNumber("0547628636"));
  assert.ok(!looksLikeCardNumber("רחוב הרצל 12 דירה 4"));
});

test("owner replies are classified", () => {
  assert.equal(classifyReply("מאשר"), "approve");
  assert.equal(classifyReply("כן!"), "approve");
  assert.equal(classifyReply("ok 👍"), "approve");
  assert.equal(classifyReply("בטל"), "decline");
  assert.equal(classifyReply("לא"), "decline");
  assert.equal(classifyReply("כן אבל בלי בצל"), "other");
  assert.equal(classifyReply("תוסיף קולה"), "other");
});

test("approval is required, granted by the owner, and limited", () => {
  const chat = "c1";
  assert.equal(approvals.consume(chat), false);
  approvals.request(chat, "פיצה ב-80 ₪");
  assert.equal(approvals.consume(chat), false, "a pending request is not an approval");
  assert.ok(approvals.approve(chat));
  assert.equal(approvals.consume(chat), true);
  assert.equal(approvals.consume(chat), true);
  assert.equal(approvals.consume(chat), true);
  assert.equal(approvals.consume(chat), false, "uses run out");
  approvals.request(chat, "x");
  approvals.clearPending(chat);
  assert.equal(approvals.approve(chat), null, "nothing to approve after a different reply");
});

test("repairAfterError keeps the history valid", () => {
  const withTool = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "browser_snapshot", input: {} }] },
  ];
  repairAfterError(withTool);
  assert.equal(withTool.length, 3);
  assert.equal(withTool[2].content[0].tool_use_id, "t1");

  const unanswered = [
    { role: "user", content: [{ type: "text", text: "a" }] },
    { role: "assistant", content: [{ type: "text", text: "b" }] },
    { role: "user", content: [{ type: "text", text: "c" }] },
  ];
  repairAfterError(unanswered);
  assert.equal(unanswered.length, 2);
  assert.equal(unanswered[1].role, "assistant");
});
