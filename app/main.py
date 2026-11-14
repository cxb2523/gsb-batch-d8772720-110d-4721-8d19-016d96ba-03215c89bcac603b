import sys
import os
import pandas as pd
import json

# Add the directory containing this script to the Python path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from flask import Flask, render_template, request, jsonify, redirect, url_for, send_file
import threading
import asyncio
import glob
from scraper import BookingScraper, FAILED_REASONS
from visualizer import create_visualization

app = Flask(__name__)

# Global state for simplicity (in a real app, use a DB or Redis)
SCRAPE_STATUS = {
    "is_scraping": False,
    "progress": 0,
    "message": "Idle",
    "last_file": None,
    "error": None,
    # Real page-level progress
    "target": 0,
    "total_records": 0,
    "pages_completed": 0,
    "page_records": [],
    "failed_pages": [],
    "mode": "full",  # "full" | "retry"
}

LAST_RUN_META = "last_run.json"


def get_records_dir():
    """
    Returns the path to the records directory.
    Uses /tmp/records if the application root is not writable (e.g., Vercel),
    otherwise uses app/records.
    """
    if os.access(app.root_path, os.W_OK):
        base_dir = app.root_path
    else:
        base_dir = "/tmp"

    records_path = os.path.join(base_dir, "records")
    if not os.path.exists(records_path):
        try:
            os.makedirs(records_path, exist_ok=True)
        except OSError:
            # Fallback for some very restrictive environments
            return "/tmp"
    return records_path


def _last_run_meta_path():
    return os.path.join(get_records_dir(), LAST_RUN_META)


def _save_last_run_meta(meta):
    try:
        with open(_last_run_meta_path(), "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"Warning: could not persist last run metadata: {e}")


def _load_last_run_meta():
    path = _last_run_meta_path()
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"Warning: could not read last run metadata: {e}")
    return None


def _reset_status(mode):
    SCRAPE_STATUS["is_scraping"] = True
    SCRAPE_STATUS["progress"] = 0
    SCRAPE_STATUS["message"] = "Starting scraper..."
    SCRAPE_STATUS["error"] = None
    SCRAPE_STATUS["target"] = 0
    SCRAPE_STATUS["total_records"] = 0
    SCRAPE_STATUS["pages_completed"] = 0
    SCRAPE_STATUS["page_records"] = []
    SCRAPE_STATUS["failed_pages"] = []
    SCRAPE_STATUS["mode"] = mode


def _make_page_callback():
    """Callback pushed into the scraper: streams real page-level progress."""
    def on_page_record(record):
        SCRAPE_STATUS["page_records"].append(record)
        SCRAPE_STATUS["pages_completed"] = len(SCRAPE_STATUS["page_records"])
        SCRAPE_STATUS["total_records"] = record["total_records"]
        target = SCRAPE_STATUS["target"]
        if target > 0:
            SCRAPE_STATUS["progress"] = min(100, int(100 * record["total_records"] / target))
        SCRAPE_STATUS["message"] = (
            f"Page {record['page']} done (+{record['new_records']}, "
            f"total {record['total_records']}/{target})"
        )
    return on_page_record


def run_scraper_background(limit):
    global SCRAPE_STATUS
    _reset_status(mode="full")
    SCRAPE_STATUS["target"] = limit

    try:
        records_dir = get_records_dir()
        scraper = BookingScraper(records_dir=records_dir, on_page_record=_make_page_callback())
        # We need a new event loop for this thread
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        result = loop.run_until_complete(scraper.run(limit=limit))
        loop.close()

        failed_pages = [r["page"] for r in result["page_records"] if not r["success"]]
        SCRAPE_STATUS["last_file"] = result["filepath"]
        SCRAPE_STATUS["total_records"] = result["total_records"]
        SCRAPE_STATUS["failed_pages"] = failed_pages
        SCRAPE_STATUS["progress"] = 100 if not failed_pages else SCRAPE_STATUS["progress"]
        SCRAPE_STATUS["message"] = "Completed" if not failed_pages else "Completed with failed pages"

        _save_last_run_meta({
            "filepath": result["filepath"],
            "limit": limit,
            "page_records": result["page_records"],
            "failed_pages": failed_pages,
        })
    except Exception as e:
        SCRAPE_STATUS["error"] = str(e)
        SCRAPE_STATUS["message"] = "Error"
    finally:
        SCRAPE_STATUS["is_scraping"] = False


def run_retry_background(failed_pages, limit, base_file, previous_records):
    global SCRAPE_STATUS
    _reset_status(mode="retry")
    SCRAPE_STATUS["target"] = limit
    SCRAPE_STATUS["last_file"] = base_file
    # Keep previous successful page records visible; retried pages get replaced on completion
    SCRAPE_STATUS["page_records"] = [r for r in previous_records if r["page"] not in failed_pages]
    SCRAPE_STATUS["pages_completed"] = len(SCRAPE_STATUS["page_records"])

    try:
        records_dir = get_records_dir()
        scraper = BookingScraper(records_dir=records_dir, on_page_record=_make_page_callback())
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        result = loop.run_until_complete(
            scraper.retry_failed_pages(failed_pages, limit, base_file)
        )
        loop.close()

        # Merge: replace retried pages' old records with the new outcomes
        merged = [r for r in previous_records if r["page"] not in failed_pages]
        merged.extend(result["page_records"])
        merged.sort(key=lambda r: r["page"])

        failed_now = [r["page"] for r in merged if not r["success"]]
        SCRAPE_STATUS["page_records"] = merged
        SCRAPE_STATUS["pages_completed"] = len(merged)
        SCRAPE_STATUS["last_file"] = result["filepath"]
        SCRAPE_STATUS["total_records"] = result["total_records"]
        SCRAPE_STATUS["failed_pages"] = failed_now
        SCRAPE_STATUS["progress"] = min(100, int(100 * result["total_records"] / limit)) if limit else 0
        SCRAPE_STATUS["message"] = "Completed" if not failed_now else "Completed with failed pages"

        _save_last_run_meta({
            "filepath": result["filepath"],
            "limit": limit,
            "page_records": merged,
            "failed_pages": failed_now,
        })
    except Exception as e:
        SCRAPE_STATUS["error"] = str(e)
        SCRAPE_STATUS["message"] = "Error"
    finally:
        SCRAPE_STATUS["is_scraping"] = False


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/start-scrape', methods=['POST'])
def start_scrape():
    global SCRAPE_STATUS
    if SCRAPE_STATUS["is_scraping"]:
        return jsonify({"status": "error", "message": "Scraping already in progress"}), 400

    data = request.json
    limit = int(data.get('limit', 10))

    # Clear previous records to ensure data freshness
    records_dir = get_records_dir()
    try:
        if os.path.exists(records_dir):
            for f in glob.glob(os.path.join(records_dir, "*.csv")):
                os.remove(f)
            meta = os.path.join(records_dir, LAST_RUN_META)
            if os.path.exists(meta):
                os.remove(meta)
            # Reset last_file in status
            SCRAPE_STATUS["last_file"] = None
    except Exception as e:
        print(f"Warning: Could not clear old records: {e}")

    # Start background thread
    thread = threading.Thread(target=run_scraper_background, args=(limit,))
    thread.start()

    return jsonify({"status": "started", "limit": limit})


@app.route('/retry-failed', methods=['POST'])
def retry_failed():
    """Re-scrape only the pages marked as failed in the last run."""
    global SCRAPE_STATUS
    if SCRAPE_STATUS["is_scraping"]:
        return jsonify({"status": "error", "message": "Scraping already in progress"}), 400

    meta = _load_last_run_meta()
    if not meta and SCRAPE_STATUS.get("page_records"):
        # Fall back to in-memory state from this process
        meta = {
            "filepath": SCRAPE_STATUS.get("last_file"),
            "limit": SCRAPE_STATUS.get("target") or 10,
            "page_records": SCRAPE_STATUS["page_records"],
            "failed_pages": SCRAPE_STATUS.get("failed_pages", []),
        }

    if not meta or not meta.get("filepath") or not os.path.exists(meta["filepath"]):
        return jsonify({
            "status": "no_previous_run",
            "message": "没有可重试的上次采集记录，请先执行一次采集。"
        }), 400

    failed_pages = [r["page"] for r in meta.get("page_records", []) if not r.get("success", True)]
    if not failed_pages:
        return jsonify({
            "status": "no_failed_pages",
            "message": "上次采集没有失败页，无可重试内容。"
        }), 200

    thread = threading.Thread(
        target=run_retry_background,
        args=(failed_pages, meta.get("limit", 10), meta["filepath"], meta.get("page_records", [])),
    )
    thread.start()

    return jsonify({"status": "started", "mode": "retry", "pages": failed_pages})


@app.route('/status')
def status():
    return jsonify(SCRAPE_STATUS)


@app.route('/visualization')
def visualization():
    global SCRAPE_STATUS
    # Find latest file if not in memory
    if not SCRAPE_STATUS["last_file"]:
        # Look in records dir
        records_dir = get_records_dir()
        files = glob.glob(os.path.join(records_dir, "*.csv"))
        if files:
            SCRAPE_STATUS["last_file"] = max(files, key=os.path.getctime)

    if not SCRAPE_STATUS["last_file"]:
        return "No data found. Please scrape first."

    try:
        # Read and process CSV for Knowledge Graph
        df = pd.read_csv(SCRAPE_STATUS["last_file"])

        # Clean Price for logic (create a numeric column)
        # Handle cases like 'PKR 12,345' -> 12345
        df['Price_Clean'] = df['Price'].astype(str).str.replace(',', '', regex=False)
        df['Price_Clean'] = df['Price_Clean'].str.extract(r'(\d+\.?\d*)')[0]
        df['Price_Clean'] = pd.to_numeric(df['Price_Clean'], errors='coerce').fillna(0)

        # Handle N/A
        df = df.fillna("N/A")

        # Convert to list of dicts for frontend
        hotels_data = df.to_dict(orient='records')

        filename = os.path.basename(SCRAPE_STATUS["last_file"])
        return render_template('visualization.html', hotels_data=hotels_data, filename=filename)

    except Exception as e:
        return f"Error processing data: {str(e)}"


@app.route('/download/<filename>')
def download_file(filename):
    records_dir = get_records_dir()
    filepath = os.path.join(records_dir, filename)
    if os.path.exists(filepath):
        return send_file(filepath, as_attachment=True)
    return "File not found", 404


if __name__ == '__main__':
    app.run(debug=True, port=5000)
