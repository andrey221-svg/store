import fs from "node:fs";
import { chromium } from "playwright";
import { config } from "./config.js";

/**
 * One persistent Chromium profile for the bot. Because the profile is kept on disk,
 * logging in to a delivery site once (with `npm run login`) keeps the bot logged in.
 */

let context = null;
let page = null;
let idleTimer = null;
let launching = null;

const MAX_TEXT_CHARS = 7000;
const MAX_ELEMENTS = 180;

function touch() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => closeBrowser().catch(() => {}), config.browserIdleMinutes * 60_000);
  idleTimer.unref?.();
}

export async function launchContext({ headless = config.browserHeadless } = {}) {
  fs.mkdirSync(config.browserProfileDir, { recursive: true });
  return chromium.launchPersistentContext(config.browserProfileDir, {
    headless,
    executablePath: config.browserExecutablePath,
    locale: "he-IL",
    timezoneId: config.timezone,
    viewport: { width: 1280, height: 900 },
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
}

async function getPage() {
  touch();
  if (page && !page.isClosed()) return page;
  if (!context) {
    launching ??= launchContext().finally(() => {
      launching = null;
    });
    context = await launching;
    // Links that open a new tab: follow them, like a person would.
    context.on("page", (p) => {
      page = p;
    });
    context.on("close", () => {
      context = null;
      page = null;
    });
  }
  const pages = context.pages();
  page = pages.length ? pages[pages.length - 1] : await context.newPage();
  return page;
}

export async function closeBrowser() {
  clearTimeout(idleTimer);
  const ctx = context;
  context = null;
  page = null;
  if (ctx) await ctx.close();
}

async function settle(p) {
  try {
    await p.waitForLoadState("domcontentloaded", { timeout: 15_000 });
  } catch {
    // slow page - continue with what we have
  }
  try {
    await p.waitForLoadState("networkidle", { timeout: 4_000 });
  } catch {
    // sites with long-polling never go idle
  }
}

/**
 * Text view of the page for the model: visible text plus a numbered list of the
 * clickable / typeable elements. Each element gets a data-bot-ref attribute so a
 * later click or type can find it again.
 */
export async function snapshot() {
  const p = await getPage();
  const data = await p.evaluate(
    ({ maxElements, maxText }) => {
      const selector = [
        "a[href]", "button", "input:not([type=hidden])", "textarea", "select", "summary",
        "[role=button]", "[role=link]", "[role=checkbox]", "[role=radio]", "[role=tab]",
        "[role=menuitem]", "[role=option]", "[role=switch]", "[role=combobox]",
        "[contenteditable=true]", "[onclick]", "[tabindex='0']",
      ].join(",");
      document.querySelectorAll("[data-bot-ref]").forEach((el) => el.removeAttribute("data-bot-ref"));
      const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
      const items = [];
      let n = 0;
      for (const el of document.querySelectorAll(selector)) {
        if (n >= maxElements) break;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (rect.width < 2 || rect.height < 2) continue;
        if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;
        if (el.closest("[aria-hidden=true]")) continue;
        n += 1;
        el.setAttribute("data-bot-ref", String(n));
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute("role") || tag;
        let name = clean(
          el.getAttribute("aria-label") ||
            el.innerText ||
            el.getAttribute("placeholder") ||
            el.getAttribute("title") ||
            el.getAttribute("alt") ||
            (tag === "input" && ["button", "submit"].includes(el.type) ? el.value : ""),
        );
        if (!name) {
          const img = el.querySelector("img[alt]");
          if (img) name = clean(img.alt);
        }
        if (!name && el.id) {
          const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (label) name = clean(label.innerText);
        }
        let extra = "";
        if (tag === "input" || tag === "textarea") {
          extra += ` type=${el.type || "text"}`;
          if (["checkbox", "radio"].includes(el.type)) extra += el.checked ? " checked" : " unchecked";
          else if (el.value) extra += ` value="${clean(el.value).slice(0, 40)}"`;
        }
        if (tag === "select") {
          const opts = [...el.options].slice(0, 15).map((o) => (o.selected ? `*${clean(o.text)}` : clean(o.text)));
          extra += ` options=[${opts.join(" | ")}]`;
        }
        if (tag === "a") {
          const href = el.getAttribute("href") || "";
          if (href && !href.startsWith("javascript")) extra += ` href=${href.slice(0, 80)}`;
        }
        if (el.disabled || el.getAttribute("aria-disabled") === "true") extra += " disabled";
        const inView = rect.bottom > 0 && rect.top < innerHeight;
        items.push(`[${n}] ${role}${extra} "${name.slice(0, 90)}"${inView ? "" : " (off-screen)"}`);
      }
      const text = (document.body?.innerText || "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .join("\n");
      return {
        title: document.title,
        text: text.length > maxText ? `${text.slice(0, maxText)}\n…(truncated)` : text,
        elements: items,
      };
    },
    { maxElements: MAX_ELEMENTS, maxText: MAX_TEXT_CHARS },
  );
  return [
    `URL: ${p.url()}`,
    `Title: ${data.title}`,
    "",
    "--- Page text ---",
    data.text || "(no visible text)",
    "",
    "--- Interactive elements (use the number as ref) ---",
    data.elements.join("\n") || "(none found)",
  ].join("\n");
}

export async function open(url) {
  const p = await getPage();
  let target = String(url).trim();
  if (!/^https?:\/\//i.test(target)) target = `https://${target}`;
  await p.goto(target, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await settle(p);
  return snapshot();
}

function locate(p, ref) {
  return p.locator(`[data-bot-ref="${Number(ref)}"]`).first();
}

/** Visible label of an element, used by the purchase guard before clicking. */
export async function describe(ref) {
  const p = await getPage();
  const loc = locate(p, ref);
  if ((await loc.count()) === 0) return null;
  return loc.evaluate((el) =>
    [el.innerText, el.getAttribute("aria-label"), el.value, el.getAttribute("title")]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

export async function click(ref) {
  const p = await getPage();
  const loc = locate(p, ref);
  if ((await loc.count()) === 0) {
    throw new Error(`No element with ref ${ref}. The page changed - call browser_snapshot for fresh refs.`);
  }
  await loc.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
  await loc.click({ timeout: 10_000 });
  await p.waitForTimeout(1200);
  await settle(page ?? p);
  return snapshot();
}

export async function type(ref, text, pressEnter = false) {
  const p = await getPage();
  const loc = locate(p, ref);
  if ((await loc.count()) === 0) {
    throw new Error(`No element with ref ${ref}. Call browser_snapshot for fresh refs.`);
  }
  try {
    await loc.fill(String(text), { timeout: 8_000 });
  } catch {
    await loc.click({ timeout: 8_000 });
    await p.keyboard.type(String(text), { delay: 30 });
  }
  if (pressEnter) {
    await loc.press("Enter");
    await p.waitForTimeout(1200);
    await settle(p);
  }
  return snapshot();
}

export async function select(ref, option) {
  const p = await getPage();
  const loc = locate(p, ref);
  if ((await loc.count()) === 0) {
    throw new Error(`No element with ref ${ref}. Call browser_snapshot for fresh refs.`);
  }
  try {
    await loc.selectOption({ label: String(option) }, { timeout: 8_000 });
  } catch {
    await loc.selectOption(String(option), { timeout: 8_000 });
  }
  await p.waitForTimeout(800);
  return snapshot();
}

export async function scroll(direction = "down") {
  const p = await getPage();
  await p.mouse.wheel(0, direction === "up" ? -800 : 800);
  await p.waitForTimeout(900);
  return snapshot();
}

export async function back() {
  const p = await getPage();
  await p.goBack({ waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
  await settle(p);
  return snapshot();
}

export async function screenshot() {
  const p = await getPage();
  return p.screenshot({ type: "jpeg", quality: 60 });
}

export function currentUrl() {
  return page && !page.isClosed() ? page.url() : null;
}
