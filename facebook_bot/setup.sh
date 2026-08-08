#!/bin/bash
# Facebook Bot - Script התקנה מהיר
echo "=== Facebook Search Bot - התקנה ==="

# Check Python
if ! command -v python3 &>/dev/null; then
  echo "ERROR: Python3 לא מותקן"
  exit 1
fi

# Create virtual environment
python3 -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Install Playwright browsers
playwright install chromium

echo ""
echo "=== ההתקנה הושלמה! ==="
echo ""
echo "שלבים הבאים:"
echo "1. ערוך את config.json עם האימייל והסיסמה שלך"
echo "2. הגדר מילות חיפוש ב-config.json"
echo "3. הרץ: python bot.py"
echo "4. פתח viewer.html לצפייה בתוצאות"
