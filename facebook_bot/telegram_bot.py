#!/usr/bin/env python3
"""
Telegram Bot - ממשק לחיפוש פייסבוק
שלח פקודות לבוט הטלגרם וקבל תוצאות ישירות לטלפון
"""

import asyncio
import json
import threading
import logging
from datetime import datetime
from pathlib import Path

try:
    from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
    from telegram.ext import (
        Application, CommandHandler, MessageHandler,
        CallbackQueryHandler, ContextTypes, filters
    )
    from telegram.constants import ParseMode
    from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout
except ImportError:
    print("ERROR: הרץ: pip install -r requirements.txt && playwright install chromium")
    raise

CONFIG_PATH = Path(__file__).parent / "config.json"

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.WARNING
)

# ─── Config ──────────────────────────────────────────────────────────────────

def load_config() -> dict:
    with open(CONFIG_PATH, encoding="utf-8") as f:
        return json.load(f)

def save_config(cfg: dict):
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)

# ─── Facebook Search (runs in thread) ────────────────────────────────────────

def _fb_login(page, email: str, password: str) -> bool:
    page.goto("https://www.facebook.com/login", timeout=30000)
    try:
        page.click("[data-testid='cookie-policy-manage-dialog-accept-button']", timeout=3000)
    except Exception:
        pass
    page.fill("#email", email)
    page.fill("#pass", password)
    page.click("[name='login']")
    page.wait_for_load_state("networkidle", timeout=20000)
    return "facebook.com/login" not in page.url


def _search_jobs(page, keyword: str, max_results: int) -> list:
    results = []
    try:
        page.goto(f"https://www.facebook.com/jobs/?q={keyword}", timeout=30000)
        page.wait_for_load_state("networkidle", timeout=12000)
        for _ in range(3):
            page.keyboard.press("End")
            page.wait_for_timeout(1200)

        cards = page.query_selector_all("div[class*='x1yztbdb'], [data-testid='job_listing_card']")
        seen = set()
        for card in cards:
            try:
                text = card.inner_text().strip()
                if not text or text in seen:
                    continue
                seen.add(text)
                link_el = card.query_selector("a")
                link = ""
                if link_el:
                    link = link_el.get_attribute("href") or ""
                    if link and not link.startswith("http"):
                        link = "https://www.facebook.com" + link
                lines = [l.strip() for l in text.split("\n") if l.strip()]
                if lines:
                    results.append({
                        "type": "job", "keyword": keyword,
                        "title": lines[0],
                        "company": lines[1] if len(lines) > 1 else "",
                        "location": lines[2] if len(lines) > 2 else "",
                        "url": link,
                        "found_at": datetime.now().isoformat()
                    })
                if len(results) >= max_results:
                    break
            except Exception:
                continue
    except Exception:
        pass
    return results


def _search_marketplace(page, keyword: str, max_results: int,
                         min_price: int = 0, max_price: int = 0) -> list:
    results = []
    try:
        url = f"https://www.facebook.com/marketplace/search/?query={keyword}"
        if min_price:
            url += f"&minPrice={min_price}"
        if max_price:
            url += f"&maxPrice={max_price}"
        page.goto(url, timeout=30000)
        page.wait_for_load_state("networkidle", timeout=12000)
        for _ in range(4):
            page.keyboard.press("End")
            page.wait_for_timeout(1000)

        cards = page.query_selector_all("a[href*='/marketplace/item/']")
        seen = set()
        for card in cards:
            try:
                text = card.inner_text().strip()
                link = card.get_attribute("href") or ""
                if not link.startswith("http"):
                    link = "https://www.facebook.com" + link
                if link in seen or not text:
                    continue
                seen.add(link)
                lines = [l.strip() for l in text.split("\n") if l.strip()]
                price = next((l for l in lines if "₪" in l or l.replace(",","").isdigit()), "")
                results.append({
                    "type": "marketplace", "keyword": keyword,
                    "title": lines[0] if lines else "",
                    "price": price,
                    "url": link,
                    "found_at": datetime.now().isoformat()
                })
                if len(results) >= max_results:
                    break
            except Exception:
                continue
    except Exception:
        pass
    return results


def run_facebook_search(keyword: str, search_type: str, config: dict) -> list:
    """Runs in a background thread. Returns list of results."""
    creds = config["credentials"]
    opts = config["options"]
    max_r = config["search"].get("max_results_per_keyword", 15)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-blink-features=AutomationControlled"]
        )
        ctx = browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            ),
            viewport={"width": 1366, "height": 768},
            locale="he-IL"
        )
        page = ctx.new_page()
        if not _fb_login(page, creds["email"], creds["password"]):
            browser.close()
            return []

        if search_type == "jobs":
            results = _search_jobs(page, keyword, max_r)
        elif search_type == "marketplace":
            results = _search_marketplace(
                page, keyword, max_r,
                opts.get("min_price", 0), opts.get("max_price", 0)
            )
        else:
            results = (_search_jobs(page, keyword, max_r // 2) +
                       _search_marketplace(page, keyword, max_r // 2))
        browser.close()
    return results


# ─── Telegram Handlers ───────────────────────────────────────────────────────

def format_result(r: dict) -> str:
    icon = "💼" if r["type"] == "job" else "🛍"
    lines = [f"{icon} *{_esc(r.get('title','ללא כותרת'))}*"]
    if r.get("price"):
        lines.append(f"💰 {_esc(r['price'])}")
    if r.get("company"):
        lines.append(f"🏢 {_esc(r['company'])}")
    if r.get("location"):
        lines.append(f"📍 {_esc(r['location'])}")
    if r.get("url"):
        lines.append(f"[פתח בפייסבוק]({r['url']})")
    return "\n".join(lines)


def _esc(s: str) -> str:
    for c in r"\_*[]()~`>#+-=|{}.!":
        s = s.replace(c, f"\\{c}")
    return s


async def cmd_start(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    text = (
        "👋 *ברוך הבא לבוט חיפוש פייסבוק\\!*\n\n"
        "📋 *פקודות זמינות:*\n"
        "/jobs `מילת חיפוש` \\- חפש משרות\n"
        "/market `מילת חיפוש` \\- חפש בשוק\n"
        "/search `מילת חיפוש` \\- חפש בשניהם\n"
        "/run \\- הרץ חיפוש מהרשימה שבהגדרות\n"
        "/keywords \\- הצג\\/ערוך מילות חיפוש\n"
        "/status \\- מצב הבוט\n\n"
        "🔎 *דוגמה:* `/jobs מפתח Python`"
    )
    await update.message.reply_text(text, parse_mode=ParseMode.MARKDOWN_V2)


async def cmd_status(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    cfg = load_config()
    creds = cfg["credentials"]
    logged_in = creds["email"] != "YOUR_FACEBOOK_EMAIL"
    jobs_kw = cfg["search"].get("keywords", [])
    market_kw = cfg["search"].get("marketplace_keywords", [])
    text = (
        f"{'✅' if logged_in else '❌'} פרטי פייסבוק: {'מוגדרים' if logged_in else 'חסרים'}\n"
        f"💼 מילות משרה: {len(jobs_kw)}\n"
        f"🛍 מילות שוק: {len(market_kw)}\n"
        f"📍 מיקום: {cfg['search'].get('location', 'לא הוגדר')}"
    )
    await update.message.reply_text(text)


async def cmd_keywords(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    cfg = load_config()
    jobs = "\n".join(f"  • {k}" for k in cfg["search"].get("keywords", []))
    market = "\n".join(f"  • {k}" for k in cfg["search"].get("marketplace_keywords", []))
    text = f"💼 *משרות:*\n{jobs or '  (ריק)'}\n\n🛍 *שוק:*\n{market or '  (ריק)'}"

    keyboard = [
        [InlineKeyboardButton("➕ הוסף מילת משרה", callback_data="add_job")],
        [InlineKeyboardButton("➕ הוסף מילת שוק", callback_data="add_market")],
        [InlineKeyboardButton("🗑 נקה הכל", callback_data="clear_all")],
    ]
    await update.message.reply_text(
        text, parse_mode=ParseMode.MARKDOWN,
        reply_markup=InlineKeyboardMarkup(keyboard)
    )


async def callback_handler(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    data = query.data

    if data == "add_job":
        ctx.user_data["waiting_for"] = "add_job"
        await query.message.reply_text("📝 שלח את מילת החיפוש למשרות:")
    elif data == "add_market":
        ctx.user_data["waiting_for"] = "add_market"
        await query.message.reply_text("📝 שלח את מילת החיפוש לשוק:")
    elif data == "clear_all":
        cfg = load_config()
        cfg["search"]["keywords"] = []
        cfg["search"]["marketplace_keywords"] = []
        save_config(cfg)
        await query.message.reply_text("✅ כל מילות החיפוש נמחקו.")


async def msg_handler(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    waiting = ctx.user_data.get("waiting_for")
    if not waiting:
        await update.message.reply_text(
            "לא הבנתי. נסה /help לרשימת פקודות."
        )
        return

    word = update.message.text.strip()
    cfg = load_config()

    if waiting == "add_job":
        cfg["search"].setdefault("keywords", []).append(word)
        save_config(cfg)
        await update.message.reply_text(f"✅ נוסף למשרות: *{word}*", parse_mode=ParseMode.MARKDOWN)
    elif waiting == "add_market":
        cfg["search"].setdefault("marketplace_keywords", []).append(word)
        save_config(cfg)
        await update.message.reply_text(f"✅ נוסף לשוק: *{word}*", parse_mode=ParseMode.MARKDOWN)

    ctx.user_data.pop("waiting_for", None)


async def _do_search(update: Update, keyword: str, search_type: str):
    icons = {"jobs": "💼", "marketplace": "🛍", "both": "🔎"}
    label = {"jobs": "משרות", "marketplace": "שוק", "both": "הכל"}

    msg = await update.message.reply_text(
        f"{icons[search_type]} מחפש *{keyword}* ב{label[search_type]}... נא המתן ⏳",
        parse_mode=ParseMode.MARKDOWN
    )

    cfg = load_config()
    if cfg["credentials"]["email"] == "YOUR_FACEBOOK_EMAIL":
        await msg.edit_text("❌ לא הוגדרו פרטי פייסבוק. ערוך את config.json")
        return

    loop = asyncio.get_event_loop()
    results = await loop.run_in_executor(
        None, run_facebook_search, keyword, search_type, cfg
    )

    if not results:
        await msg.edit_text(f"🔍 לא נמצאו תוצאות עבור *{keyword}*", parse_mode=ParseMode.MARKDOWN)
        return

    await msg.edit_text(f"✅ נמצאו {len(results)} תוצאות עבור *{keyword}*:", parse_mode=ParseMode.MARKDOWN)

    for i, r in enumerate(results[:10]):
        try:
            await update.message.reply_text(
                format_result(r),
                parse_mode=ParseMode.MARKDOWN_V2,
                disable_web_page_preview=False
            )
            await asyncio.sleep(0.3)
        except Exception:
            # Fallback without markdown
            plain = f"{'💼' if r['type']=='job' else '🛍'} {r.get('title','')}"
            if r.get('price'):
                plain += f"\n💰 {r['price']}"
            if r.get('url'):
                plain += f"\n{r['url']}"
            await update.message.reply_text(plain)

    if len(results) > 10:
        await update.message.reply_text(f"... ועוד {len(results)-10} תוצאות. הורד results.json לצפייה מלאה.")


async def cmd_jobs(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    keyword = " ".join(ctx.args) if ctx.args else ""
    if not keyword:
        await update.message.reply_text("❌ שימוש: /jobs מילת חיפוש\nדוגמה: /jobs מפתח Python")
        return
    await _do_search(update, keyword, "jobs")


async def cmd_market(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    keyword = " ".join(ctx.args) if ctx.args else ""
    if not keyword:
        await update.message.reply_text("❌ שימוש: /market מילת חיפוש\nדוגמה: /market מחשב נייד")
        return
    await _do_search(update, keyword, "marketplace")


async def cmd_search(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    keyword = " ".join(ctx.args) if ctx.args else ""
    if not keyword:
        await update.message.reply_text("❌ שימוש: /search מילת חיפוש\nדוגמה: /search דירה")
        return
    await _do_search(update, keyword, "both")


async def cmd_run(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    cfg = load_config()
    job_kws = cfg["search"].get("keywords", [])
    market_kws = cfg["search"].get("marketplace_keywords", [])

    if not job_kws and not market_kws:
        await update.message.reply_text(
            "❌ אין מילות חיפוש מוגדרות.\nהשתמש ב /keywords להוספה."
        )
        return

    total = len(job_kws) + len(market_kws)
    await update.message.reply_text(f"🚀 מתחיל חיפוש של {total} מילות מפתח...")

    all_results = []
    for kw in job_kws:
        await update.message.reply_text(f"💼 מחפש משרה: {kw}...")
        results = await asyncio.get_event_loop().run_in_executor(
            None, run_facebook_search, kw, "jobs", cfg
        )
        all_results.extend(results)
        if results:
            await update.message.reply_text(f"  ✅ נמצאו {len(results)} משרות")

    for kw in market_kws:
        await update.message.reply_text(f"🛍 מחפש בשוק: {kw}...")
        results = await asyncio.get_event_loop().run_in_executor(
            None, run_facebook_search, kw, "marketplace", cfg
        )
        all_results.extend(results)
        if results:
            await update.message.reply_text(f"  ✅ נמצאו {len(results)} פריטים")

    await update.message.reply_text(
        f"🎉 *הסתיים!* סה\"כ {len(all_results)} תוצאות.\n\n"
        f"שלח /jobs או /market עם מילת חיפוש לתוצאות חדשות.",
        parse_mode=ParseMode.MARKDOWN
    )


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    cfg = load_config()
    token = cfg["output"].get("telegram_token", "")
    if not token:
        print("ERROR: הוסף telegram_token ל-config.json")
        print("קבל טוקן מ: @BotFather בטלגרם")
        return

    app = Application.builder().token(token).build()

    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("help", cmd_start))
    app.add_handler(CommandHandler("status", cmd_status))
    app.add_handler(CommandHandler("keywords", cmd_keywords))
    app.add_handler(CommandHandler("jobs", cmd_jobs))
    app.add_handler(CommandHandler("market", cmd_market))
    app.add_handler(CommandHandler("search", cmd_search))
    app.add_handler(CommandHandler("run", cmd_run))
    app.add_handler(CallbackQueryHandler(callback_handler))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, msg_handler))

    print("✅ בוט טלגרם פועל! לחץ Ctrl+C לעצירה.")
    app.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()
