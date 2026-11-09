import { z } from "zod";
import * as browser from "./browser.js";
import { approvals, looksLikeCardNumber, looksLikePurchase } from "./approvals.js";
import { config, normalizePhone } from "./config.js";
import { profile, state } from "./storage.js";

/**
 * Custom tools the bot runs on this machine. Web search and web fetch are
 * Anthropic server tools and are declared in agent.js instead.
 */

const schemas = {
  browser_open: z.object({ url: z.string().min(1) }),
  browser_snapshot: z.object({}).passthrough(),
  browser_click: z.object({ ref: z.coerce.number().int().positive() }),
  browser_type: z.object({
    ref: z.coerce.number().int().positive(),
    text: z.string(),
    press_enter: z.boolean().optional(),
  }),
  browser_select: z.object({ ref: z.coerce.number().int().positive(), option: z.string() }),
  browser_scroll: z.object({ direction: z.enum(["up", "down"]).optional() }),
  browser_back: z.object({}).passthrough(),
  browser_screenshot: z.object({ send_to_user: z.boolean().optional(), caption: z.string().optional() }),
  request_approval: z.object({ summary: z.string().min(1) }),
  send_whatsapp_message: z.object({
    phone: z.string().min(5),
    business_name: z.string().optional(),
    message: z.string().min(1),
  }),
  notify_user: z.object({ text: z.string().min(1) }),
  remember: z.object({ key: z.string().min(1), value: z.string() }),
};

export const toolDefinitions = [
  {
    name: "browser_open",
    description:
      "Open a URL in the bot's own Chromium browser and return the page text plus a numbered list of interactive elements. Use it for sites that need clicking, typing, logging in or a cart (delivery apps, booking sites, online shops). For just reading a page, web_fetch is cheaper.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string", description: "Full URL, e.g. https://wolt.com/he/isr" } },
      required: ["url"],
    },
  },
  {
    name: "browser_snapshot",
    description: "Return the current page's text and fresh element refs. Call it when refs may be stale.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "browser_click",
    description:
      "Click an element by its ref number from the latest snapshot. Clicking a button that pays or submits an order is blocked unless the owner approved it via request_approval first.",
    input_schema: {
      type: "object",
      properties: { ref: { type: "integer", description: "Element number from the snapshot" } },
      required: ["ref"],
    },
  },
  {
    name: "browser_type",
    description:
      "Type text into an input/textarea by ref (replaces its current value). Never type payment card numbers, CVV codes or passwords the owner did not explicitly give you for this purpose.",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "integer" },
        text: { type: "string" },
        press_enter: { type: "boolean", description: "Press Enter after typing (e.g. for search boxes)" },
      },
      required: ["ref", "text"],
    },
  },
  {
    name: "browser_select",
    description: "Choose an option in a <select> dropdown by its visible label or value.",
    input_schema: {
      type: "object",
      properties: { ref: { type: "integer" }, option: { type: "string" } },
      required: ["ref", "option"],
    },
  },
  {
    name: "browser_scroll",
    description: "Scroll the page to load more content (lazy-loaded menus, more results).",
    input_schema: {
      type: "object",
      properties: { direction: { type: "string", enum: ["up", "down"] } },
    },
  },
  {
    name: "browser_back",
    description: "Go back to the previous page.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "browser_screenshot",
    description:
      "Take a screenshot of the visible part of the page. You receive the image; with send_to_user=true it is also sent to the owner on WhatsApp (useful to show a cart, a menu or an order confirmation).",
    input_schema: {
      type: "object",
      properties: {
        send_to_user: { type: "boolean" },
        caption: { type: "string", description: "Caption for the image sent to the owner" },
      },
    },
  },
  {
    name: "request_approval",
    description:
      "Ask the owner to approve an action that spends money, places/books an order, or sends a message to someone else. The summary is sent to the owner with instructions to reply 'מאשר' or 'בטל'. After calling this, end your turn and wait - do not repeat the summary. You will be told in the next user message whether it was approved. The approval is valid for a short window and a few actions, and only for what the summary described.",
    input_schema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description:
            "Exactly what will happen, in the owner's language: business, items and quantities, price of each, delivery fee, total, address, time, payment method - or, for a message, the recipient and the full message text.",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "send_whatsapp_message",
    description:
      "Send a WhatsApp message from the bot's number to a business (e.g. a restaurant that takes orders on WhatsApp). Requires an approval from request_approval that showed this exact message. Replies from that number are forwarded to the owner.",
    input_schema: {
      type: "object",
      properties: {
        phone: { type: "string", description: "Phone number, e.g. 054-1234567 or +972541234567" },
        business_name: { type: "string" },
        message: { type: "string" },
      },
      required: ["phone", "message"],
    },
  },
  {
    name: "notify_user",
    description:
      "Send the owner a short progress message right now, while you keep working (e.g. 'מחפש מסעדות פתוחות באזור…'). Use sparingly on long tasks.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "remember",
    description:
      "Save a fact about the owner for future conversations: name, delivery address, phone, floor/entrance notes, allergies, favourite restaurants, usual orders. Pass an empty value to delete a key. Never store card numbers, CVV codes or passwords.",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Short key, e.g. address, name, allergies" },
        value: { type: "string" },
      },
      required: ["key", "value"],
    },
  },
];

function text(content) {
  return { content };
}

function error(message) {
  return { content: message, isError: true };
}

/**
 * Runs one tool call. `ctx` is { chatId, io } where io knows how to talk to WhatsApp
 * (or to the terminal in CLI mode).
 */
export async function runTool(name, rawInput, ctx) {
  const schema = schemas[name];
  if (!schema) return error(`Unknown tool: ${name}`);
  const parsed = schema.safeParse(rawInput ?? {});
  if (!parsed.success) return error(`Invalid input for ${name}: ${parsed.error.message}`);
  const input = parsed.data;

  try {
    switch (name) {
      case "browser_open":
        return text(await browser.open(input.url));

      case "browser_snapshot":
        return text(await browser.snapshot());

      case "browser_click": {
        const label = await browser.describe(input.ref);
        if (label === null) return error(`No element with ref ${input.ref}. Call browser_snapshot first.`);
        if (looksLikePurchase(label)) {
          if (!approvals.consume(ctx.chatId)) {
            return error(
              `BLOCKED: "${label}" looks like a payment/order button. Call request_approval with a full summary of the order and wait for the owner's approval before clicking it.`,
            );
          }
        }
        return text(await browser.click(input.ref));
      }

      case "browser_type":
        if (looksLikeCardNumber(input.text)) {
          return error(
            "BLOCKED: this looks like a payment card number. Never type card details - use the payment method saved in the site account, or send the owner a link to pay themselves.",
          );
        }
        return text(await browser.type(input.ref, input.text, input.press_enter ?? false));

      case "browser_select":
        return text(await browser.select(input.ref, input.option));

      case "browser_scroll":
        return text(await browser.scroll(input.direction ?? "down"));

      case "browser_back":
        return text(await browser.back());

      case "browser_screenshot": {
        const image = await browser.screenshot();
        if (input.send_to_user) await ctx.io.sendImage(image, input.caption ?? "");
        return {
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: image.toString("base64") },
            },
            { type: "text", text: `Screenshot of ${browser.currentUrl()}${input.send_to_user ? " (also sent to the owner)" : ""}` },
          ],
        };
      }

      case "request_approval": {
        approvals.request(ctx.chatId, input.summary);
        await ctx.io.sendText(
          `🛑 *נדרש אישור שלך*\n\n${input.summary}\n\nלאישור השב: *מאשר*\nלביטול השב: *בטל*`,
        );
        return text(
          "Approval request sent to the owner. End your turn now without repeating the summary; the owner's answer will arrive as the next message.",
        );
      }

      case "send_whatsapp_message": {
        const number = normalizePhone(input.phone);
        if (!number) return error("Could not understand that phone number.");
        if (config.ownerNumbers.includes(number)) {
          return error("That is the owner's own number - just reply normally instead.");
        }
        if (!approvals.consume(ctx.chatId)) {
          return error(
            "BLOCKED: sending a message to a third party needs approval. Call request_approval showing the recipient and the full message text, then wait.",
          );
        }
        const sent = await ctx.io.sendToNumber(number, input.message);
        if (!sent.ok) return error(sent.reason);
        state.update((s) => {
          s.contacted[number] = { name: input.business_name ?? "", at: Date.now() };
        });
        return text(`Message sent to ${input.business_name ?? number}. Their replies will be forwarded to the owner.`);
      }

      case "notify_user":
        await ctx.io.sendText(input.text);
        return text("Sent.");

      case "remember": {
        if (looksLikeCardNumber(input.value)) return error("BLOCKED: never store card numbers.");
        const data = profile.set(input.key, input.value);
        return text(`Saved. Current profile: ${JSON.stringify(data)}`);
      }

      default:
        return error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return error(`${name} failed: ${err?.message ?? err}`);
  }
}
