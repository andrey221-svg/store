#!/usr/bin/env python3
"""
Facebook Job & Marketplace Search Bot
חיפוש אוטומטי של משרות ומוצרים בפייסבוק
"""

import json
import time
import random
import sys
import os
from datetime import datetime
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout
    from colorama import init, Fore, Style
    init(autoreset=True)
except ImportError:
    print("ERROR: Missing dependencies. Run: pip install -r requirements.txt && playwright install chromium")
    sys.exit(1)


CONFIG_PATH = Path(__file__).parent / "config.json"
RESULTS_PATH = Path(__file__).parent / "results.json"


def load_config():
    with open(CONFIG_PATH, encoding="utf-8") as f:
        return json.load(f)


def save_results(results: dict):
    with open(RESULTS_PATH, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print(f"{Fore.GREEN}[✓] תוצאות נשמרו ל: {RESULTS_PATH}")


def log(msg, color=Fore.CYAN):
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"{color}[{ts}] {msg}{Style.RESET_ALL}")


def random_sleep(min_sec=1.5, max_sec=3.5):
    time.sleep(random.uniform(min_sec, max_sec))


# ─── LOGIN ────────────────────────────────────────────────────────────────────

def login(page, email: str, password: str) -> bool:
    log("מנסה להתחבר לפייסבוק...", Fore.YELLOW)
    try:
        page.goto("https://www.facebook.com/login", timeout=30000)
        random_sleep()

        # Accept cookies if prompted
        try:
            page.click("text=Allow all cookies", timeout=4000)
            random_sleep(0.5, 1)
        except Exception:
            pass
        try:
            page.click("[data-testid='cookie-policy-manage-dialog-accept-button']", timeout=3000)
            random_sleep(0.5, 1)
        except Exception:
            pass

        page.fill("#email", email)
        random_sleep(0.5, 1)
        page.fill("#pass", password)
        random_sleep(0.5, 1)
        page.click("[name='login']")
        page.wait_for_load_state("networkidle", timeout=20000)
        random_sleep(2, 4)

        # Check login success
        if "checkpoint" in page.url or "two_step" in page.url:
            log("נדרש אימות דו-שלבי! אנא אשר בטלפון ואז לחץ Enter...", Fore.YELLOW)
            input()
            page.wait_for_load_state("networkidle", timeout=30000)

        if "facebook.com/login" not in page.url:
            log("התחברת בהצלחה!", Fore.GREEN)
            return True
        else:
            log("כשל בהתחברות. בדוק אימייל וסיסמה.", Fore.RED)
            return False

    except Exception as e:
        log(f"שגיאת התחברות: {e}", Fore.RED)
        return False


# ─── FACEBOOK JOBS ────────────────────────────────────────────────────────────

def search_jobs(page, keyword: str, max_results: int) -> list:
    log(f"מחפש משרות: '{keyword}'", Fore.CYAN)
    results = []

    try:
        search_url = f"https://www.facebook.com/jobs/?q={keyword}"
        page.goto(search_url, timeout=30000)
        page.wait_for_load_state("networkidle", timeout=15000)
        random_sleep(2, 4)

        # Scroll to load more results
        for _ in range(3):
            page.keyboard.press("End")
            random_sleep(1.5, 2.5)

        # Try to find job cards
        job_cards = page.query_selector_all("[data-testid='job_listing_card'], div[class*='job']")

        if not job_cards:
            # Fallback: search via main search
            page.goto(f"https://www.facebook.com/search/jobs/?q={keyword}", timeout=30000)
            page.wait_for_load_state("networkidle", timeout=15000)
            random_sleep(2, 3)
            for _ in range(3):
                page.keyboard.press("End")
                random_sleep(1, 2)
            job_cards = page.query_selector_all("div[class*='x1yztbdb']")

        log(f"  נמצאו {len(job_cards)} כרטיסי משרה", Fore.WHITE)

        for card in job_cards[:max_results]:
            try:
                text = card.inner_text()
                link_el = card.query_selector("a")
                link = link_el.get_attribute("href") if link_el else ""
                if link and not link.startswith("http"):
                    link = "https://www.facebook.com" + link

                lines = [l.strip() for l in text.split("\n") if l.strip()]
                if lines:
                    result = {
                        "type": "job",
                        "keyword": keyword,
                        "title": lines[0] if lines else "",
                        "company": lines[1] if len(lines) > 1 else "",
                        "location": lines[2] if len(lines) > 2 else "",
                        "details": "\n".join(lines[:5]),
                        "url": link,
                        "found_at": datetime.now().isoformat()
                    }
                    results.append(result)
            except Exception:
                continue

    except PlaywrightTimeout:
        log(f"  Timeout בחיפוש משרות: '{keyword}'", Fore.YELLOW)
    except Exception as e:
        log(f"  שגיאה בחיפוש משרות: {e}", Fore.RED)

    return results


# ─── FACEBOOK MARKETPLACE ─────────────────────────────────────────────────────

def search_marketplace(page, keyword: str, max_results: int,
                        min_price: int = 0, max_price: int = 0) -> list:
    log(f"מחפש בשוק: '{keyword}'", Fore.MAGENTA)
    results = []

    try:
        url = f"https://www.facebook.com/marketplace/search/?query={keyword}"
        if min_price > 0:
            url += f"&minPrice={min_price}"
        if max_price > 0:
            url += f"&maxPrice={max_price}"

        page.goto(url, timeout=30000)
        page.wait_for_load_state("networkidle", timeout=15000)
        random_sleep(2, 4)

        # Scroll to load more items
        for _ in range(4):
            page.keyboard.press("End")
            random_sleep(1, 2)

        # Find marketplace item cards
        item_cards = page.query_selector_all(
            "[data-testid='marketplace_feed_item'], "
            "div[class*='x3ct3a4'], "
            "a[href*='/marketplace/item/']"
        )

        log(f"  נמצאו {len(item_cards)} פריטים", Fore.WHITE)

        seen_urls = set()
        for card in item_cards[:max_results * 2]:
            try:
                text = card.inner_text()
                link_el = card if card.tag_name() == "a" else card.query_selector("a")
                link = ""
                if link_el:
                    link = link_el.get_attribute("href") or ""
                    if not link.startswith("http"):
                        link = "https://www.facebook.com" + link

                if link in seen_urls:
                    continue
                seen_urls.add(link)

                lines = [l.strip() for l in text.split("\n") if l.strip()]
                if not lines:
                    continue

                # Try to extract price
                price = ""
                for line in lines:
                    if "₪" in line or "ILS" in line or line.replace(",", "").replace(".", "").isdigit():
                        price = line
                        break

                result = {
                    "type": "marketplace",
                    "keyword": keyword,
                    "title": lines[0] if lines else "",
                    "price": price,
                    "details": "\n".join(lines[:4]),
                    "url": link,
                    "found_at": datetime.now().isoformat()
                }
                results.append(result)

                if len(results) >= max_results:
                    break

            except Exception:
                continue

    except PlaywrightTimeout:
        log(f"  Timeout בחיפוש שוק: '{keyword}'", Fore.YELLOW)
    except Exception as e:
        log(f"  שגיאה בחיפוש שוק: {e}", Fore.RED)

    return results


# ─── TELEGRAM NOTIFY ──────────────────────────────────────────────────────────

def send_telegram(token: str, chat_id: str, results: list):
    try:
        import requests
        if not results:
            return
        msg = f"*Facebook Bot - {len(results)} תוצאות חדשות*\n\n"
        for r in results[:10]:
            icon = "💼" if r["type"] == "job" else "🛍"
            msg += f"{icon} *{r['title']}*\n"
            if r.get("price"):
                msg += f"  מחיר: {r['price']}\n"
            if r.get("company"):
                msg += f"  חברה: {r['company']}\n"
            if r.get("url"):
                msg += f"  [קישור]({r['url']})\n"
            msg += "\n"

        url = f"https://api.telegram.org/bot{token}/sendMessage"
        requests.post(url, json={
            "chat_id": chat_id,
            "text": msg,
            "parse_mode": "Markdown"
        }, timeout=10)
        log("הודעת טלגרם נשלחה!", Fore.GREEN)
    except Exception as e:
        log(f"שגיאה בשליחת טלגרם: {e}", Fore.YELLOW)


# ─── MAIN ─────────────────────────────────────────────────────────────────────

def main():
    config = load_config()
    creds = config["credentials"]
    search = config["search"]
    output = config["output"]
    options = config["options"]

    if creds["email"] == "YOUR_FACEBOOK_EMAIL":
        log("עדכן credentials ב-config.json לפני הרצה!", Fore.RED)
        sys.exit(1)

    all_results = {
        "run_date": datetime.now().isoformat(),
        "jobs": [],
        "marketplace": []
    }

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=options.get("headless", False),
            slow_mo=options.get("slow_mo_ms", 500),
            args=["--no-sandbox", "--disable-blink-features=AutomationControlled"]
        )
        context = browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            ),
            viewport={"width": 1366, "height": 768},
            locale="he-IL"
        )
        page = context.new_page()

        if not login(page, creds["email"], creds["password"]):
            browser.close()
            sys.exit(1)

        # Search Jobs
        if options.get("search_jobs", True):
            for kw in search.get("keywords", []):
                results = search_jobs(page, kw, search.get("max_results_per_keyword", 20))
                all_results["jobs"].extend(results)
                log(f"  -> {len(results)} משרות נמצאו עבור '{kw}'", Fore.GREEN)
                random_sleep(2, 5)

        # Search Marketplace
        if options.get("search_marketplace", True):
            for kw in search.get("marketplace_keywords", []):
                results = search_marketplace(
                    page, kw,
                    search.get("max_results_per_keyword", 20),
                    options.get("min_price", 0),
                    options.get("max_price", 0)
                )
                all_results["marketplace"].extend(results)
                log(f"  -> {len(results)} פריטים נמצאו עבור '{kw}'", Fore.GREEN)
                random_sleep(2, 5)

        browser.close()

    # Save results
    save_results(all_results)

    total = len(all_results["jobs"]) + len(all_results["marketplace"])
    print(f"\n{Fore.GREEN}{'='*50}")
    print(f"  סה\"כ: {len(all_results['jobs'])} משרות | {len(all_results['marketplace'])} פריטי שוק")
    print(f"  תוצאות נשמרו ב: {RESULTS_PATH}")
    print(f"{'='*50}{Style.RESET_ALL}")

    # Telegram notification
    if output.get("notify_telegram") and output.get("telegram_token"):
        combined = all_results["jobs"] + all_results["marketplace"]
        send_telegram(output["telegram_token"], output["telegram_chat_id"], combined)

    return all_results


if __name__ == "__main__":
    main()
