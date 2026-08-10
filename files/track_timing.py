"""
TrackTiming v1.0 — Raspberry Pi / OpenStint
====================================================

Info :
  - Decoder connection : ZeroMQ SUB on tcp://localhost:5556 (OpenStint)
  - Optional RTC date/time via DS3231 I2C
  - Data storage on SQLite3 database (laps, sessions, drivers, classes)
  - Config : JSON file
  - Option LCD via RPLCD (I2C) (unfinished)
  - Captive portal : hostapd + dnsmasq + Flask + Gunicorn

Dependencies :
  pip install flask pyzmq gunicorn
  pip install RPLCD RPi.GPIO   # optional for LCD

Architecture :
    - Dependencies and I2C options
    - Parameters
    - Logging
    - Global state variables
    - DB init and config functions
    - 5 min time compute function
    - Helpers DB
    - LCD functions
    - Decoder messages processing function
    - ZEROMQ thread function
    - Flask web server + captive portal
    - Main function
"""

# ═══════════════════════════════════════════════════════════════════════════════
# DEPENDENCIES AND I2C OPTIONS
# ═══════════════════════════════════════════════════════════════════════════════
import os
import sys
import json
import time
import signal
import logging
import threading
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from flask import Flask, request, jsonify, send_file, redirect, abort
from collections import deque

try:
    import zmq
    ZMQ_AVAILABLE = True
except ImportError:
    ZMQ_AVAILABLE = False
    print("[WARNING] pyzmq not installed")

# ── LCD I2C (option) ────────────────────────────────────────────────────────
LCD_ENABLED = False
lcd = None
try:
    from RPLCD.i2c import CharLCD
    LCD_ENABLED = True
except ImportError:
    pass

# ── DS3231 RTC I2C (option) ────────────────────────────────────────────────────────
try:
    from smbus2 import SMBus
    DS3231_ENABLED = True
except ImportError:
    DS3231_ENABLED = False

DS3231_ADDR = 0x68
# BCD conversion helpers
def _bcd2dec(b):
    return (b & 0x0F) + ((b >> 4) * 10)
def _dec2bcd(d):
    return ((d // 10) << 4) | (d % 10)
# Read datetime from DS3231
def ds3231_read_datetime():
    if not DS3231_ENABLED:
        return None
    try:
        with SMBus(1) as bus:
            data = bus.read_i2c_block_data(DS3231_ADDR, 0x00, 7)
        sec = _bcd2dec(data[0] & 0x7F)
        minute = _bcd2dec(data[1])
        hour = _bcd2dec(data[2] & 0x3F)
        day = _bcd2dec(data[4])
        month = _bcd2dec(data[5] & 0x1F)
        year = 2000 + _bcd2dec(data[6])
        return datetime(year, month, day, hour, minute, sec)
    except Exception as e:
        log.warning(f"DS3231 read failed: {e}")
        return None
# Set datetime on DS3231
def ds3231_set_datetime(dt):
    if not DS3231_ENABLED:
        return False
    try:
        with SMBus(1) as bus:
            data = [
                _dec2bcd(dt.second),
                _dec2bcd(dt.minute),
                _dec2bcd(dt.hour),
                _dec2bcd(dt.isoweekday()),
                _dec2bcd(dt.day),
                _dec2bcd(dt.month),
                _dec2bcd(dt.year - 2000)
            ]
            bus.write_i2c_block_data(DS3231_ADDR, 0x00, data)
        return True
    except Exception as e:
        log.warning(f"DS3231 set failed: {e}")
        return False

# ═══════════════════════════════════════════════════════════════════════════════
# PARAMETERS
# ═══════════════════════════════════════════════════════════════════════════════
DATA_DIR      = Path(os.environ.get("TRACKTIMING_DATA", Path.home() / ".tracktiming"))
CONFIG_FILE   = DATA_DIR / "config.json"
DB_FILE       = DATA_DIR / "tracktiming.db"
TXLEARN_FILE  = DATA_DIR / "txlearn.csv"
STATIC_DIR    = Path(__file__).parent / "static"
RC4_DIR       = Path("/opt/openstint")
ZMQ_HOST      = os.environ.get("OPENSTINT_HOST", "localhost")
ZMQ_PORT      = int(os.environ.get("OPENSTINT_PORT", "5556"))
WEB_HOST      = "0.0.0.0"
WEB_PORT      = int(os.environ.get("WEB_PORT", "80"))
PORTAL_IP     = os.environ.get("PORTAL_IP", "192.168.4.1")
LCD_I2C_ADDR  = 0x27
LCD_I2C_PORT  = 1
LCD_COLS      = 16
LCD_ROWS      = 2
DEFAULT_MIN_LAP = 5.0
DEFAULT_MAX_LAP = 120.0


# ═══════════════════════════════════════════════════════════════════════════════
# LOGGING
# ═══════════════════════════════════════════════════════════════════════════════
LOG_LEVEL = os.environ.get("TRACKTIMING_LOG_LEVEL", "INFO").upper()
log_level = getattr(logging, LOG_LEVEL, logging.INFO)
logging.basicConfig(
    level=log_level,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("TrackTiming")


# ═══════════════════════════════════════════════════════════════════════════════
# GLOBAL STATE VARIABLES
# ═══════════════════════════════════════════════════════════════════════════════
state_lock = threading.Lock()
stop_event = threading.Event()
min_lap_sec: float = DEFAULT_MIN_LAP
max_lap_sec: float = DEFAULT_MAX_LAP
rtlsdr_gain: int   = 20   # dB, default value
rssi_map: dict = {}
transponders: dict = {}
last_lap_display: dict = {
    "transponder": 0,
    "transponder_type": "",
    "seconds": 0.0,
    "rssi": 0.0,
    "hits": 0,
    "pass_duration_us": 0,
    "has": False,
}
# Decoder raw messages buffer (for debug / admin web UI)
recent_messages: deque = deque(maxlen=10)


# ═══════════════════════════════════════════════════════════════════════════════
# DB INIT AND CONFIG FUNCTIONS
# ═══════════════════════════════════════════════════════════════════════════════
# File db
def ensure_db():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_FILE); c = conn.cursor()
    # Create tables if not exist
    c.execute('''CREATE TABLE IF NOT EXISTS drivers (transponder TEXT PRIMARY KEY, name TEXT, class TEXT)''')
    c.execute('''CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, transponder TEXT, sessionid INTEGER, timestamp TEXT, five_min_count INTEGER, five_min_total REAL)''')
    c.execute('''CREATE TABLE IF NOT EXISTS laps (id INTEGER PRIMARY KEY AUTOINCREMENT, transponder TEXT, sessionid INTEGER, laptime REAL)''')
    c.execute('''CREATE TABLE IF NOT EXISTS classes (id   INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL)''')
    # Default class list
    c.execute("SELECT COUNT(*) FROM classes")
    if c.fetchone()[0] == 0:
        defaults = ["4x2","4x2S","4x4","4x4S","DTM Stock","DTM Mod","F1","FWD","GT"]
        c.executemany("INSERT OR IGNORE INTO classes (name) VALUES (?)", [(n,) for n in defaults])
    conn.commit(); conn.close()
    # Create txlearn.csv from .rc4 files with 4-digit names
    update_txlearn_csv()

# List all 4-digit .rc4 files in RC4_DIR and write to txlearn.csv
def update_txlearn_csv():
    try:
        RC4_DIR.mkdir(parents=True, exist_ok=True)
        files = sorted([f for f in RC4_DIR.glob("[0-9][0-9][0-9][0-9].rc4") if f.is_file()])
        with open(TXLEARN_FILE, "w", newline="") as f:
            f.write("transponder,filename\n")
            for file in files:
                num = file.stem
                f.write(f"{num},{file.name}\n")
    except (PermissionError, OSError) as e:
        log.warning(f"update_txlearn_csv ignored (RC4_DIR inaccessible) : {e}")
        # Create empty file to avoid potential errors
        if not TXLEARN_FILE.exists():
            TXLEARN_FILE.write_text("transponder,filename\n")

def load_config():
    global min_lap_sec, max_lap_sec, rtlsdr_gain
    if CONFIG_FILE.exists():
        try:
            cfg = json.loads(CONFIG_FILE.read_text())
            min_lap_sec  = float(cfg.get("minLapSec",   DEFAULT_MIN_LAP))
            max_lap_sec  = float(cfg.get("maxLapSec",   DEFAULT_MAX_LAP))
            rtlsdr_gain  = int(cfg.get("rtlsdrGain",    20))
        except Exception as e:
            log.warning(f"Impossible to read config : {e}")

def save_config():
    CONFIG_FILE.write_text(json.dumps({
        "minLapSec":  min_lap_sec,
        "maxLapSec":  max_lap_sec,
        "rtlsdrGain": rtlsdr_gain,
    }))


# ═══════════════════════════════════════════════════════════════════════════════
# HELPERS DB
# ═══════════════════════════════════════════════════════════════════════════════
def _compute_5min(lap_times: list) -> dict | None:
    """Return the first window of laps that reaches or exceeds 5 minutes total.
    Returns {"count": n, "total": seconds} or None if the session is too short."""
    acc, cnt = 0.0, 0
    for t in lap_times:
        acc += t
        cnt += 1
        if acc >= 300:
            return {"count": cnt, "total": round(acc, 3)}
    return None

def now_timestamp() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

def get_last_session_id(transponder: int) -> int:
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("SELECT MAX(sessionid) FROM sessions WHERE transponder=?", (str(transponder),))
    row = c.fetchone(); conn.close()
    return row[0] if row and row[0] is not None else 0

def append_session(transponder: int, session_id: int):
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("INSERT INTO sessions (transponder, sessionid, timestamp) VALUES (?, ?, ?)",
              (str(transponder), session_id, now_timestamp()))
    conn.commit(); conn.close()

def append_lap(transponder: int, session_id: int, laptime_sec: float):
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("INSERT INTO laps (transponder, sessionid, laptime) VALUES (?, ?, ?)",
              (str(transponder), session_id, laptime_sec))
    # Recompute 5min result for this session and persist it
    c.execute(
        "SELECT laptime FROM laps WHERE transponder=? AND sessionid=? ORDER BY id ASC",
        (str(transponder), session_id)
    )
    session_lap_times = [r[0] for r in c.fetchall()]
    best5 = _compute_5min(session_lap_times)
    if best5:
        c.execute(
            "UPDATE sessions SET five_min_count=?, five_min_total=? WHERE transponder=? AND sessionid=?",
            (best5["count"], best5["total"], str(transponder), session_id)
        )
    conn.commit(); conn.close()

def get_laps_from_row(from_row: int = 1):
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("SELECT transponder, sessionid, laptime FROM laps WHERE id >= ? ORDER BY id ASC", (from_row,))
    rows = c.fetchall(); conn.close()
    return rows

def get_sessions_from_row(from_row: int = 1):
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("SELECT transponder, sessionid, timestamp FROM sessions WHERE id >= ? ORDER BY id ASC", (from_row,))
    rows = c.fetchall(); conn.close()
    return rows

def delete_all_laps_and_sessions():
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("DELETE FROM laps")
    c.execute("DELETE FROM sessions")
    c.execute("DELETE FROM sqlite_sequence WHERE name IN ('laps', 'sessions')")
    conn.commit(); conn.close()
    with state_lock:
        transponders.clear()

def delete_lap_by_row(row: int) -> bool:
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("SELECT transponder, sessionid FROM laps WHERE id=?", (row,))
    lap_row = c.fetchone()
    if not lap_row:
        conn.close()
        return False
    transponder, session_id = lap_row
    c.execute("DELETE FROM laps WHERE id=?", (row,)) # Delete lap
    affected = c.rowcount
    c.execute(
        "SELECT laptime FROM laps WHERE transponder=? AND sessionid=? ORDER BY id ASC",
        (str(transponder), session_id)
    )
    session_lap_times = [r[0] for r in c.fetchall()]
    best5 = _compute_5min(session_lap_times) # Recompute 5min time for the affected session
    if best5:
        c.execute(
            "UPDATE sessions SET five_min_count=?, five_min_total=? WHERE transponder=? AND sessionid=?",
            (best5["count"], best5["total"], str(transponder), session_id)
        )
    else:
        c.execute(
            "UPDATE sessions SET five_min_count=NULL, five_min_total=NULL WHERE transponder=? AND sessionid=?",
            (str(transponder), session_id)
        )
    conn.commit(); conn.close()
    return affected > 0

def delete_by_transponder(tp: str) -> bool:
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("DELETE FROM laps WHERE transponder=?", (tp,))
    c.execute("DELETE FROM sessions WHERE transponder=?", (tp,))
    conn.commit(); conn.close()
    try:
        with state_lock:
            transponders.pop(int(tp), None)
    except ValueError:
        pass
    return True


# ═══════════════════════════════════════════════════════════════════════════════
# LCD FUNCTIONS
# ═══════════════════════════════════════════════════════════════════════════════
def init_lcd():
    global lcd, LCD_ENABLED
    if not LCD_ENABLED:
        return
    try:
        lcd = CharLCD(
            i2c_expander="PCF8574",
            address=LCD_I2C_ADDR,
            port=LCD_I2C_PORT,
            cols=LCD_COLS,
            rows=LCD_ROWS,
            backlight_enabled=True,
        )
        lcd.clear()
        lcd.cursor_pos = (0, 0); lcd.write_string("Track Timing 1.0")
        lcd.cursor_pos = (1, 0); lcd.write_string("  Let's Race !  ")
        time.sleep(2)
        lcd.clear()
    except Exception as e:
        log.warning(f"LCD unavailable : {e}")
        LCD_ENABLED = False

def lcd_write(row: int, text: str):
    if not LCD_ENABLED or lcd is None:
        return
    try:
        lcd.cursor_pos = (row, 0); lcd.write_string(f"{text:<16.16}")
    except Exception:
        pass

def refresh_lcd():
    now = datetime.now()
    with state_lock:
        snap = last_lap_display.copy()

    if snap["has"]:
        time_str  = now.strftime("%H:%M:%S")
        hit_qual  = f"{snap['hits']}x{abs(snap['rssi']):.0f}dB"
        line1     = f"{time_str:<8} {hit_qual:>7}"
        tp_str    = f"{snap['transponder']:07d}"
        secs      = snap["seconds"]
        lap_str   = f"{secs:.3f}s" if secs > 0 else "-------"
        line2     = f"{tp_str:<7} {lap_str:>8}"
        lcd_write(0, line1)
        lcd_write(1, line2)
    else:
        lcd_write(0, f" {now.strftime('%d/%m %H:%M:%S')} ")
        lcd_write(1, "  Let's Race !  ")

def lcd_refresh_thread():
    while not stop_event.is_set():
        refresh_lcd()
        time.sleep(0.25)


# ═══════════════════════════════════════════════════════════════════════════════
# DECODER MESSAGES PROCESSING FUNCTION
# ═══════════════════════════════════════════════════════════════════════════════
def process_message(raw: str):
    """
    Process OpenStint messsages received via ZeroMQ.
    Transponder passing :
      P <decoder_timestamp> <transponder_type> <transponder_id> <rssi> <hit_count> <pass_duration> [...]
    """
    log.debug(f"process_message() called with: {raw[:100]}")
    
    # Stock raw messages into buffer for debug / admin web UI
    with state_lock:
        recent_messages.appendleft({
            "time": datetime.now().strftime("%H:%M:%S"),
            "raw":  raw,
        })
    
    # Split message into parts
    parts = raw.split()
    msg_type = parts[0]

    # RC4 Learning done message
    if msg_type == "L" and parts[2] == "DONE":
        update_txlearn_csv()
        return

    # Discard non-P messages (e.g. "S" for status)
    if msg_type != "P":
        return

    # Process P messages
    try:
        decoder_timestamp_ms = int(parts[1])
        transponder_type     = parts[2]
        transponder_id       = int(parts[3])
        rssi                 = float(parts[4])
        hit_count            = int(parts[5])
        pass_duration_us     = int(parts[6])
    except (ValueError, IndexError):
        log.debug(f"Erroneous P message : {raw!r}")
        return

    # Log
    log.info(
        f"Passing → tp={transponder_id:07d} ({transponder_type})"
        f"  t={decoder_timestamp_ms}ms  rssi={rssi:.1f}dB"
        f"  hits={hit_count}  dur={pass_duration_us}µs"
    )

    # Signal quality Q = 2*(RSSI+53), 0-100, max RSSI = -3dB
    signal_quality = max(0, min(100, round(2 * (rssi + 53))))

    # Update global state
    with state_lock:
        rssi_map[str(transponder_id)] = signal_quality
        # Open new session
        if transponder_id not in transponders:
            last_sid = get_last_session_id(transponder_id)
            transponders[transponder_id] = {
                "last_decoder_time": 0,
                "session_id": last_sid + 1,
                "first": True,
            }
            append_session(transponder_id, transponders[transponder_id]["session_id"])

        td = transponders[transponder_id]
        laptime_sec = 0.0
        valid_lap   = False

        # Detect decoder restart if new timestamp lower by 30s+
        RESTART_THRESHOLD_MS = 30_000
        if (td["last_decoder_time"] > 0
                and decoder_timestamp_ms < td["last_decoder_time"] - RESTART_THRESHOLD_MS):
            log.warning(
                f"Decoder restart detected for tp={transponder_id} "
                f"(t={decoder_timestamp_ms} < last={td['last_decoder_time']}). "
                "Timestamp reset."
            )
            # Open a new session after decoder restart
            td["last_decoder_time"] = 0
            td["session_id"] += 1
            td["first"] = True
            append_session(transponder_id, td["session_id"])

        # Record lap time if last timestamp is valid and new timestamp is greater
        if td["last_decoder_time"] > 0 and decoder_timestamp_ms > td["last_decoder_time"]:
            diff_ms     = decoder_timestamp_ms - td["last_decoder_time"]
            laptime_sec = diff_ms / 1000.0

            # Min lap check
            if laptime_sec < min_lap_sec:
                return

            # Max lap check (new session)
            if laptime_sec > max_lap_sec:
                td["session_id"] += 1
                td["first"] = True
                append_session(transponder_id, td["session_id"])
                valid_lap = False
            else:
                valid_lap = True

        # Update last decoder timestamp
        td["last_decoder_time"] = decoder_timestamp_ms

        if valid_lap:
            append_lap(transponder_id, td["session_id"], laptime_sec)
            log.info(f"  → Lap : {laptime_sec:.3f}s  session={td['session_id']}")

        # Update LCD display
        last_lap_display.update({
            "transponder":       transponder_id,
            "transponder_type":  transponder_type,
            "seconds":           laptime_sec if valid_lap else 0.0,
            "rssi":              rssi,
            "hits":              hit_count,
            "pass_duration_us":  pass_duration_us,
            "has":               True,
        })


# ═══════════════════════════════════════════════════════════════════════════════
# ZEROMQ THREAD FUNCTION
# ═══════════════════════════════════════════════════════════════════════════════
def zmq_receiver_thread():
    if not ZMQ_AVAILABLE:
        log.warning("Thread ZMQ not available")
        return
    try:
        ctx    = zmq.Context()
        socket = ctx.socket(zmq.SUB)
        socket.setsockopt(zmq.SUBSCRIBE, b"")
        endpoint = f"tcp://{ZMQ_HOST}:{ZMQ_PORT}"
        socket.connect(endpoint)
        log.info(f"ZeroMQ SUB connecté à {endpoint}")
    except Exception as e:
        log.error(f"ZeroMQ connection failed: {e}")
        return
    
    poller = zmq.Poller()
    poller.register(socket, zmq.POLLIN)
    msg_count = 0
    while not stop_event.is_set():
        try:
            socks = dict(poller.poll(timeout=500))
            if socket in socks:
                raw  = socket.recv()
                line = raw.decode("utf-8", errors="replace").strip()
                if line:
                    msg_count += 1
                    log.debug(f"[ZMQ #{msg_count}] Received: {line[:100]}")
                    # OpenStint message processing
                    process_message(line)
        except zmq.ZMQError as e:
            log.error(f"Erreur ZMQ : {e}")
            time.sleep(1)
        except Exception as e:
            log.error(f"Unexpected error in ZMQ receiver: {e}")
            time.sleep(1)
    socket.close()
    ctx.term()
    log.info(f"Thread ZMQ arrêté. (received {msg_count} messages total)")


# ═══════════════════════════════════════════════════════════════════════════════
# FLASK WEB SERVER + CAPTIVE PORTAL
# ═══════════════════════════════════════════════════════════════════════════════
app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="")

# ── Web requests filter ───────────────────────────────────────────
MAX_CONTENT_LENGTH = 1 * 1024 * 1024   # 1 Mo max
app.config["MAX_CONTENT_LENGTH"] = MAX_CONTENT_LENGTH

_API_POST_ALLOWED = {
    "/api/thresholds", "/api/rtc", "/api/drivers",
    "/api/classes", "/api/openstint",
}
@app.before_request
def reject_unwanted_methods():
    method = request.method
    if method in ("POST", "PUT", "PATCH"):
        path = request.path.rstrip("/") or "/"
        # Authorized API POST endpoints
        if path in _API_POST_ALLOWED or path.startswith("/api/"):
            return None   # laisser passer
        # Filtered requests
        log.debug(f"Request {method} not allowed on {path}")
        from flask import make_response
        resp = make_response("Method Not Allowed", 405)
        resp.headers["Allow"] = "GET, HEAD, OPTIONS"
        resp.headers["Connection"] = "close"
        return resp
    return None

# ── Web cache ───────────────────────────────────────────
STATIC_CACHE_TTL = 86_400   # 1 day cache for static pages
@app.after_request
def set_cache_headers(response):
    path = request.path
    if (response.status_code == 200 and not path.startswith("/api/") and not path.endswith(".csv")):
        response.headers["Cache-Control"] = (f"public, max-age={STATIC_CACHE_TTL}")
    return response

# ── Static html pages ───────────────────────────────────
@app.route("/")
def index():
    f = STATIC_DIR / "index.html"
    if not f.exists(): abort(404, "missing index.html")
    return send_file(str(f))

@app.route("/admin.html")
def admin():
    f = STATIC_DIR / "admin.html"
    if not f.exists(): abort(404, "missing admin.html")
    return send_file(str(f))

# ── CSV files export ────────────────────────────────────
@app.route("/laps.csv")
def raw_laps():
    """Export laps CSV from SQLite."""
    conn = sqlite3.connect(DB_FILE); c = conn.cursor()
    c.execute("SELECT transponder, sessionid, laptime FROM laps ORDER BY id ASC")
    rows = c.fetchall(); conn.close()
    text = "transponder,sessionid,laptime\n" + "".join([f"{r[0]},{r[1]},{r[2]:.3f}\n" for r in rows])
    return text, 200, {"Content-Type": "text/csv"}

@app.route("/sessions.csv")
def raw_sessions():
    """Export sessions CSV from SQLite."""
    conn = sqlite3.connect(DB_FILE); c = conn.cursor()
    c.execute("SELECT transponder, sessionid, timestamp FROM sessions ORDER BY id ASC")
    rows = c.fetchall(); conn.close()
    text = "transponder,sessionid,timestamp\n" + "".join([f"{r[0]},{r[1]},{r[2]}\n" for r in rows])
    return text, 200, {"Content-Type": "text/csv"}

@app.route("/drivers.csv")
def raw_drivers():
    """Export drivers CSV from SQLite."""
    conn = sqlite3.connect(DB_FILE); c = conn.cursor()
    c.execute("SELECT transponder, name, class FROM drivers ORDER BY transponder ASC")
    rows = c.fetchall(); conn.close()
    text = "transponder,name,class\n" + "".join([f"{r[0]},{r[1]},{r[2]}\n" for r in rows])
    return text, 200, {"Content-Type": "text/csv"}

@app.route("/txlearn.csv")
def raw_txlearn():
    update_txlearn_csv()
    return send_file(str(TXLEARN_FILE), mimetype="text/csv")

# ── API laps (GET + DELETE) ────────────────────────────────────────────────────
# Get laps (with optional fromRow and transponder filter)
@app.route("/api/laps", methods=["GET"])
def api_laps_get():
    from_row = int(request.args.get("fromRow", 1))
    tp_filter = request.args.get("tp", None)
    conn = sqlite3.connect(DB_FILE); c = conn.cursor()
    if tp_filter:
        c.execute(
            "SELECT id, transponder, sessionid, laptime FROM laps WHERE id >= ? AND transponder=? ORDER BY id ASC",
            (from_row, str(tp_filter))
        )
    else:
        c.execute(
            "SELECT id, transponder, sessionid, laptime FROM laps WHERE id >= ? ORDER BY id ASC",
            (from_row,)
        )
    rows = c.fetchall()
    # Return last id for incremental polling
    c.execute("SELECT MAX(id) FROM laps")
    max_id = c.fetchone()[0] or 0
    conn.close()
    return jsonify(
        laps=[{"id": r[0], "transponder": r[1], "sessionid": r[2], "laptime": r[3]} for r in rows],
        lastId=max_id
    )

# Delete laps
@app.route("/api/laps", methods=["DELETE"])
def api_laps_delete():
    # Params from query string or JSON body
    tp_arg  = request.args.get("tp")
    row_arg = request.args.get("row")
    if not tp_arg and not row_arg:
        body    = request.get_json(silent=True) or {}
        tp_arg  = body.get("tp")
        row_arg = body.get("row")
    # Delete single lap by row id
    if row_arg is not None:
        if not delete_lap_by_row(int(row_arg)): abort(500, "Lap delete failed")
        return jsonify(ok=True)
    # Delete laps by transponder
    if tp_arg:
        delete_by_transponder(str(tp_arg))
        return jsonify(ok=True, tp=tp_arg)
    # Delete all laps and sessions
    delete_all_laps_and_sessions()
    return jsonify(ok=True)

# ── API sessions ───────────────────────────────────────────────────────────────
# Get sessions (with optional fromRow and transponder filter)
@app.route("/api/sessions", methods=["GET"])
def api_sessions_get():
    from_row = int(request.args.get("fromRow", 1))
    tp_filter = request.args.get("tp", None)
    conn = sqlite3.connect(DB_FILE); c = conn.cursor()
    if tp_filter:
        c.execute(
            "SELECT id, transponder, sessionid, timestamp FROM sessions WHERE id >= ? AND transponder=? ORDER BY id ASC",
            (from_row, str(tp_filter))
        )
    else:
        c.execute(
            "SELECT id, transponder, sessionid, timestamp FROM sessions WHERE id >= ? ORDER BY id ASC",
            (from_row,)
        )
    rows = c.fetchall()
    c.execute("SELECT MAX(id) FROM sessions")
    max_id = c.fetchone()[0] or 0
    conn.close()
    return jsonify(
        sessions=[{"id": r[0], "transponder": r[1], "sessionid": r[2], "timestamp": r[3]} for r in rows],
        lastId=max_id
    )

# ── API leaderboard (server-side computation) ────────────────────────────────────────
@app.route("/api/leaderboard", methods=["GET"])
def api_leaderboard():
    class_filter = request.args.get("class", None)
    limit = int(request.args.get("limit", 50))
    conn = sqlite3.connect(DB_FILE); c = conn.cursor()
    if class_filter:
        c.execute("SELECT transponder, name, class FROM drivers WHERE class=?", (class_filter,))
    else:
        c.execute("SELECT transponder, name, class FROM drivers")
    drivers = {r[0]: {"name": r[1], "class": r[2]} for r in c.fetchall()}
    leaderboard = []
    for tp, info in drivers.items():
        c.execute("SELECT MIN(laptime), COUNT(*) FROM laps WHERE transponder=?", (tp,))
        min_lap, total_laps = c.fetchone()
        if not total_laps:
            continue
        c.execute(
            "SELECT five_min_count, five_min_total FROM sessions "
            "WHERE transponder=? AND five_min_count IS NOT NULL "
            "ORDER BY five_min_count DESC, five_min_total ASC LIMIT 1",
            (tp,)
        )
        row5 = c.fetchone()
        best5 = {"count": row5[0], "total": row5[1]} if row5 else None
        # Append to leaderboard
        leaderboard.append({
            "transponder": tp,
            "name":        info["name"],
            "class":       info["class"],
            "fastestlap":  min_lap,
            "lapCount":    total_laps,
            "fastest5min": best5,
        })
    conn.close()
    leaderboard.sort(key=lambda x: x["fastestlap"] if x["fastestlap"] is not None else 9999)
    return jsonify(leaderboard[:limit])

# ── API laps thresholds ─────────────────────────────────────────────────────────────────
@app.route("/api/thresholds", methods=["GET"])
def api_thresholds_get():
    return jsonify(min=min_lap_sec, max=max_lap_sec)

@app.route("/api/thresholds", methods=["POST"])
def api_thresholds_post():
    global min_lap_sec, max_lap_sec
    body = request.get_json(silent=True) or {}
    with state_lock:
        if "min" in body: min_lap_sec = float(body["min"])
        if "max" in body: max_lap_sec = float(body["max"])
    save_config()
    return jsonify(ok=True)

# ── API signal quality (RSSI → Q) ─────────────────────────────────────────────
@app.route("/api/rssi", methods=["GET"])
def api_rssi():
    with state_lock:
        data = dict(rssi_map)
    return jsonify(data)

# ── API raw messages buffer ───────────────────────────────────────────────────────
@app.route("/api/recentMessages", methods=["GET"])
def api_recent_messages():
    with state_lock:
        data = list(recent_messages)
    return jsonify(data)

# ── API debug status ───────────────────────────────────────────────────────────────
@app.route("/api/status", methods=["GET"])
def api_status():
    """Debug endpoint: show system status, ZMQ, transponders, recent messages."""
    with state_lock:
        status = {
            "zmq_available": ZMQ_AVAILABLE,
            "zmq_host": ZMQ_HOST,
            "zmq_port": ZMQ_PORT,
            "web_host": WEB_HOST,
            "web_port": WEB_PORT,
            "data_dir": str(DATA_DIR),
            "db_file": str(DB_FILE),
            "static_dir": str(STATIC_DIR),
            "min_lap_sec": min_lap_sec,
            "max_lap_sec": max_lap_sec,
            "transponders_count": len(transponders),
            "transponders": dict(transponders),
            "recent_messages_count": len(recent_messages),
            "recent_messages": list(recent_messages),
            "rssi_map": dict(rssi_map),
        }
    return jsonify(status)

# ── API RTL-SDR gain ───────────────────────────────────────────────────────────
@app.route("/api/gain", methods=["GET"])
def api_gain_get():
    return jsonify(gain=rtlsdr_gain)

@app.route("/api/gain", methods=["POST"])
def api_gain_post():
    # Apply RTL-SDR gain and restart openstint service. openstint.service must use EnvironmentFile.
    global rtlsdr_gain
    body = request.get_json(silent=True) or {}
    try:
        gain = int(body.get("gain", 20))
    except (TypeError, ValueError):
        abort(400, "Invalid gain (integer expected)")
    gain = max(0, min(40, gain))   # Gain range 0-40 dB
    # Write environment file
    gain_file = DATA_DIR / "openstint_gain.env"
    gain_file.write_text(f"OPENSTINT_GAIN={gain}\n")
    # Update config
    with state_lock:
        rtlsdr_gain = gain
    save_config()
    # Restart openstint (track_timing must be run as root or with sudo NOPASSWD)
    try:
        import subprocess
        result = subprocess.run(["sudo", "systemctl", "restart", "openstint"], capture_output=True, text=True, timeout=10)
        if result.returncode != 0:
            log.warning(f"systemctl restart openstint: {result.stderr.strip()}")
            return jsonify(ok=True, gain=gain, warning="Service restart failed — gain saved, restart manually")
    except Exception as e:
        log.warning(f"Impossible to restart openstint : {e}")
        return jsonify(ok=True, gain=gain, warning=str(e))

    log.info(f"RTL-SDR gain set to {gain} dB, openstint service restarted.")
    return jsonify(ok=True, gain=gain)

# ── API txlearn ────────────────────────────────────────────────────────────────
@app.route("/api/txlearn", methods=["POST"])
def api_txlearn():
    body = request.get_json(silent=True) or {}
    old_id = str(body.get("old_id", "")).strip()
    new_id = str(body.get("new_id", "")).strip()
    if not (old_id.isdigit() and len(old_id) == 4): abort(400, "Field 'old_id' (4 digits) missing or invalid")
    if not (new_id.isdigit() and len(new_id) == 7): abort(400, "Field 'new_id' (7 digits) missing or invalid")
    old_file = RC4_DIR / f"{old_id}.rc4"
    new_file = RC4_DIR / f"{new_id}.rc4"
    if not old_file.exists(): abort(404, f"File {old_id}.rc4 not found")
    if new_file.exists(): abort(409, f"File {new_id}.rc4 already exists")
    old_file.rename(new_file)
    update_txlearn_csv()
    # Remove old 4-digits ID from db
    conn = sqlite3.connect(DB_FILE); c = conn.cursor()
    c.execute("DELETE FROM laps WHERE transponder=?", (old_id,))
    c.execute("DELETE FROM sessions WHERE transponder=?", (old_id,))
    c.execute("DELETE FROM drivers WHERE transponder=?", (old_id,))
    conn.commit(); conn.close()
    log.info(f"txlearn: {old_id}.rc4 → {new_id}.rc4, cleared from db")
    return jsonify(ok=True)

# ── API classes ────────────────────────────────────────────────────────────────
@app.route("/api/classes", methods=["GET"])
def api_classes_get():
    # List classes
    conn = sqlite3.connect(DB_FILE); c = conn.cursor()
    c.execute("SELECT id, name FROM classes ORDER BY name ASC")
    rows = c.fetchall(); conn.close()
    return jsonify([{"id": r[0], "name": r[1]} for r in rows])

@app.route("/api/classes", methods=["POST"])
def api_classes_post():
    # Create class
    body = request.get_json(silent=True) or {}
    name = str(body.get("name", "")).strip()
    if not name:
        abort(400, "Field 'name' required")
    conn = sqlite3.connect(DB_FILE); c = conn.cursor()
    try:
        c.execute("INSERT INTO classes (name) VALUES (?)", (name,))
        conn.commit()
        new_id = c.lastrowid
    except sqlite3.IntegrityError:
        conn.close(); abort(409, f"Class '{name}' already exists")
    conn.close()
    return jsonify(ok=True, id=new_id)

@app.route("/api/classes", methods=["PUT"])
def api_classes_put():
    # Rename class
    body = request.get_json(silent=True) or {}
    old_name = str(body.get("old_name", "")).strip()
    new_name = str(body.get("new_name", "")).strip()
    if not old_name or not new_name:
        abort(400, "Champs 'old_name' et 'new_name' requis")
    if old_name == new_name:
        return jsonify(ok=True, updated_drivers=0)
    conn = sqlite3.connect(DB_FILE); c = conn.cursor()
    try:
        c.execute("UPDATE classes SET name=? WHERE name=?", (new_name, old_name))
        if c.rowcount == 0:
            conn.close(); abort(404, f"Class '{old_name}' not found")
        # Mise à jour en cascade sur les pilotes
        c.execute("UPDATE drivers SET class=? WHERE class=?", (new_name, old_name))
        updated_drivers = c.rowcount
        conn.commit()
    except sqlite3.IntegrityError:
        conn.close(); abort(409, f"Class '{new_name}' already exists")
    conn.close()
    return jsonify(ok=True, updated_drivers=updated_drivers)

@app.route("/api/classes", methods=["DELETE"])
def api_classes_delete():
    # Delete class and remove from drivers list
    body = request.get_json(silent=True) or {}
    name = str(body.get("name", "")).strip()
    if not name: abort(400, "Field 'name' required")
    conn = sqlite3.connect(DB_FILE); c = conn.cursor()
    c.execute("DELETE FROM classes WHERE name=?", (name,))
    if c.rowcount == 0:
        conn.close(); abort(404, f"Class '{name}' not found")
    c.execute("UPDATE drivers SET class='' WHERE class=?", (name,))
    affected = c.rowcount
    conn.commit(); conn.close()
    return jsonify(ok=True, affected_drivers=affected)

# ── API drivers ────────────────────────────────────────────────────────────────
@app.route("/api/drivers", methods=["GET"])
def api_drivers_get():
    # List drivers
    conn = sqlite3.connect(DB_FILE); c = conn.cursor()
    c.execute("SELECT transponder, name, class FROM drivers ORDER BY transponder ASC")
    rows = c.fetchall(); conn.close()
    return jsonify([{"id": r[0], "name": r[1], "class": r[2]} for r in rows])

@app.route("/api/drivers", methods=["POST"])
def api_drivers_post():
    # Register driver
    body = request.get_json(silent=True) or {}
    tid  = str(body.get("id",    "")).strip()
    name = str(body.get("name",  "")).strip()
    cls  = str(body.get("class", "")).strip()
    if not tid or not name: abort(400, "Fields 'id' and 'name' required")
    conn = sqlite3.connect(DB_FILE); c = conn.cursor()
    try:
        c.execute("INSERT INTO drivers (transponder, name, class) VALUES (?, ?, ?)", (tid, name, cls))
        conn.commit()
    except sqlite3.IntegrityError:
        conn.close(); abort(409, "TX already registered")
    conn.close()
    return jsonify(ok=True)

@app.route("/api/drivers", methods=["PUT"])
def api_drivers_put():
    # Edit driver
    body = request.get_json(silent=True) or {}
    tid  = str(body.get("id",    "")).strip()
    name = str(body.get("name",  "")).strip()
    cls  = str(body.get("class", "")).strip()
    if not tid or not name: abort(400, "Fields 'id' and 'name' required")
    conn = sqlite3.connect(DB_FILE); c = conn.cursor()
    c.execute("UPDATE drivers SET name=?, class=? WHERE transponder=?", (name, cls, tid))
    conn.commit(); conn.close()
    return jsonify(ok=True)

@app.route("/api/drivers", methods=["DELETE"])
def api_drivers_delete():
    # Delete driver
    body = request.get_json(silent=True) or {}
    tid  = str(body.get("id", "")).strip()
    if not tid: abort(400, "Field 'id' required")
    conn = sqlite3.connect(DB_FILE); c = conn.cursor()
    c.execute("DELETE FROM drivers WHERE transponder=?", (tid,))
    conn.commit(); conn.close()
    return jsonify(ok=True)

# ── API interface data ────────────────────────────────────────────────────────
@app.route("/api/allLaps", methods=["GET"])
def api_all_laps():
    # Data for Live mode (All) and Leaderboard
    date_start = request.args.get("start")  # YYYY-MM-DD
    date_end   = request.args.get("end")
    conn = sqlite3.connect(DB_FILE); c = conn.cursor()
    # Date filter
    if date_start or date_end:
        ts_start = f"{date_start} 00:00:00" if date_start else "0000-01-01 00:00:00"
        ts_end   = f"{date_end} 23:59:59"   if date_end   else "9999-12-31 23:59:59"
        c.execute(
            "SELECT transponder, sessionid FROM sessions WHERE timestamp >= ? AND timestamp <= ?",
            (ts_start, ts_end)
        )
        session_keys = {(r[0], r[1]) for r in c.fetchall()}
    else:
        session_keys = None  # All sessions
    # Get drivers list
    c.execute("SELECT transponder, name, class FROM drivers")
    driver_map = {r[0]: {"name": r[1], "class": r[2]} for r in c.fetchall()}
    # Filtered data
    if session_keys is not None and len(session_keys) == 0:
        conn.close()
        return jsonify(drivers=[], overallBest=None, allTimeBest=None)
    if session_keys is not None:
        placeholders = ",".join(["(?,?)"] * len(session_keys))
        flat = [x for pair in session_keys for x in pair]
        c.execute(
            f"SELECT transponder, sessionid, laptime FROM laps WHERE (transponder, sessionid) IN ({placeholders}) ORDER BY id ASC",
            flat
        )
    else:
        c.execute("SELECT transponder, sessionid, laptime FROM laps ORDER BY id ASC")
    rows = c.fetchall()
    # All-time best
    c.execute("SELECT MIN(laptime), s.timestamp FROM laps l "
              "JOIN sessions s ON l.transponder=s.transponder AND l.sessionid=s.sessionid "
              "ORDER BY laptime ASC LIMIT 1")
    alltime = c.fetchone()
    all_time_best = {"laptime": alltime[0], "timestamp": alltime[1]} if alltime and alltime[0] else None
    conn.close()
    # Group by TX
    from collections import defaultdict
    lap_groups = defaultdict(list)
    for tp, sid, lt in rows:
        lap_groups[tp].append(lt)
    overall_best = min((min(v) for v in lap_groups.values()), default=None)
    result = []
    for tp, lap_times in lap_groups.items():
        info = driver_map.get(tp, {"name": tp, "class": ""})
        result.append({
            "id":      tp,
            "name":    info["name"],
            "class":   info["class"],
            "numLaps": len(lap_times),
            "bestLap": min(lap_times),
            "lastLap": lap_times[-1],
        })
    result.sort(key=lambda x: -x["numLaps"])
    return jsonify(drivers=result, overallBest=overall_best, allTimeBest=all_time_best)

@app.route("/api/driverLaps", methods=["GET"])
def api_driver_laps():
    # Data for driver mode (per transponder)
    tp = request.args.get("tp", "").strip()
    if not tp: abort(400, "'tp' required")
    date_start = request.args.get("start")
    date_end   = request.args.get("end")
    conn = sqlite3.connect(DB_FILE); c = conn.cursor()
    ts_start = f"{date_start} 00:00:00" if date_start else "0000-01-01 00:00:00"
    ts_end   = f"{date_end} 23:59:59"   if date_end   else "9999-12-31 23:59:59"
    # Driver sessions filtered by date
    c.execute(
        "SELECT sessionid, timestamp FROM sessions WHERE transponder=? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC",
        (tp, ts_start, ts_end)
    )
    sessions_rows = c.fetchall()
    # All-time best
    c.execute(
        "SELECT MIN(l.laptime), s.timestamp FROM laps l "
        "JOIN sessions s ON l.transponder=s.transponder AND l.sessionid=s.sessionid "
        "WHERE l.transponder=?",
        (tp,)
    )
    alltime = c.fetchone()
    all_time_best = {"laptime": alltime[0], "timestamp": alltime[1]} if alltime and alltime[0] else None
    # Laps per session (with precomputed 5min from sessions table)
    session_laps = {}
    for sid, ts in sessions_rows:
        c.execute(
            "SELECT laptime FROM laps WHERE transponder=? AND sessionid=? ORDER BY id ASC",
            (tp, sid)
        )
        lap_times = [r[0] for r in c.fetchall()]
        c.execute(
            "SELECT five_min_count, five_min_total FROM sessions WHERE transponder=? AND sessionid=?",
            (tp, sid)
        )
        row5 = c.fetchone()
        best5 = {"count": row5[0], "total": row5[1]} if (row5 and row5[0] is not None) else None
        session_laps[sid] = {
            "sessionid":     sid,
            "timestamp":     ts,
            "laps":          lap_times,
            "best5":         best5,
        }
    conn.close()
    # Compute
    all_lap_times = [lt for s in session_laps.values() for lt in s["laps"]]
    overall_best  = min(all_lap_times) if all_lap_times else None
    overall_best3   = None
    overall_best10  = None
    overall_best5   = None
    days = {}
    for sid, sdata in session_laps.items():
        times    = sdata["laps"]
        lap_count = len(times)
        # Fastest, avg10, total
        fastest = min(times) if times else None
        sorted_t = sorted(times)
        avg10    = sum(sorted_t[:10]) / min(lap_count, 10) if times else None
        total    = sum(times)
        # Best 3
        best3      = None
        best3_start = -1
        if lap_count >= 3:
            for i in range(lap_count - 2):
                s3 = times[i] + times[i+1] + times[i+2]
                if best3 is None or s3 < best3:
                    best3      = s3
                    best3_start = i
        best5 = sdata["best5"]
        # Global bests
        if best3 is not None:
            if overall_best3 is None or best3 < overall_best3:
                overall_best3 = best3
        if avg10 is not None:
            if overall_best10 is None or avg10 < overall_best10:
                overall_best10 = avg10
        if best5 is not None:
            if (overall_best5 is None
                    or best5["count"] > overall_best5["count"]
                    or (best5["count"] == overall_best5["count"] and best5["total"] < overall_best5["total"])):
                overall_best5 = best5
        # Group by day
        day_key = sdata["timestamp"][:10]  # YYYY-MM-DD
        if day_key not in days:
            days[day_key] = []
        days[day_key].append({
            "sessionid":   sid,
            "timestamp":   sdata["timestamp"],
            "laps":        times,
            "lapCount":    lap_count,
            "fastest":     fastest,
            "avg10":       avg10,
            "total":       total,
            "best3":       best3,
            "best3Start":  best3_start,
            "best5":       best5,
        })
    # Sort by descending days, sessions in each day descending
    sorted_days = [
        {"date": d, "sessions": sorted(days[d], key=lambda s: s["timestamp"], reverse=True)}
        for d in sorted(days.keys(), reverse=True)
    ]
    return jsonify(
        allTimeBest=all_time_best,
        overallBest=overall_best,
        overallBest3=overall_best3,
        overallBest10=overall_best10,
        overallBest5min=overall_best5,
        days=sorted_days,
    )

# ── API time ──────────────────────────────────────────────────────────────────
@app.route("/api/time", methods=["GET"])
def api_time():
    dt = datetime.now()  # same clock source as now_timestamp() — must never diverge
    return jsonify(serverTimeLocal=dt.strftime("%Y-%m-%d %H:%M:%S"))

@app.route("/api/rtc", methods=["POST"])
def api_rtc_post():
    # Set DS3231 RTC if present, else fallback to system time (timedatectl).
    body = request.get_json(silent=True) or {}
    iso  = body.get("time", "")
    if not iso: abort(400, "Field 'time' required")
    try:
        dt = datetime.strptime(iso[:19], "%Y-%m-%dT%H:%M:%S")
    except Exception:
        abort(400, "Format 'time' invalid")
    ok = False
    err = None
    if DS3231_ENABLED:
        ok = ds3231_set_datetime(dt)
        if not ok: err = "DS3231 write failed"
    if not ok:
        # Fallback to system time
        try:
            import subprocess
            subprocess.run(["sudo", "timedatectl", "set-time", iso[:19]], check=True)
            ok = True
        except Exception as e:
            log.warning(f"Impossible to set time : {e}")
            err = str(e)
    return jsonify(ok=ok, error=err)

# ── Captive portal detection ────────────────────────────────
@app.route("/generate_204")        # Android
def captive_android(): return redirect(f"http://{PORTAL_IP}/", 302)

@app.route("/hotspot-detect.html") # Apple iOS / macOS
def captive_apple(): return redirect(f"http://{PORTAL_IP}/", 302)

@app.route("/ncsi.txt")            # Windows
def captive_windows(): return "Microsoft NCSI", 200, {"Content-Type": "text/plain"}

@app.route("/redirect")
def captive_redirect(): return redirect(f"http://{PORTAL_IP}/", 302)

@app.errorhandler(404)
def not_found(e):
    host = request.host.split(":")[0]
    # Do not redirect local traffic
    if host in ("localhost", "127.0.0.1"): return str(e), 404
    if host != PORTAL_IP: return redirect(f"http://{PORTAL_IP}/", 302)
    f = STATIC_DIR / "index.html"
    if not f.exists(): return str(e), 404
    return send_file(str(f))


# ═══════════════════════════════════════════════════════════════════════════════
# ********************************* MAIN LOOP ***********************************
# ═══════════════════════════════════════════════════════════════════════════════

def _startup():
    """
    Initialise DB, config, LCD and ZMQ threads.
    Called at import time when the Flask app is loaded in each process.
    This works for the dev server and for Gunicorn worker.
    """
    log.info("=== TrackTiming RPi ===")
    ensure_db()
    load_config()
    log.info(f"Directory : {DATA_DIR}  |  min={min_lap_sec}s  max={max_lap_sec}s")

    if LCD_ENABLED:
        init_lcd()
        threading.Thread(target=lcd_refresh_thread, daemon=True, name="lcd").start()
    else:
        log.info("LCD disabled (RPLCD not installed or hardware absent)")

    # ZMQ receiver runs in a daemon thread — survives Gunicorn worker lifecycle
    threading.Thread(target=zmq_receiver_thread, daemon=True, name="zmq").start()
    log.info(f"WSGI app ready — Gunicorn will serve on {WEB_HOST}:{WEB_PORT}  (portal IP : {PORTAL_IP})")

# Run startup when the module is imported (Gunicorn) or directly
_startup()

if __name__ == "__main__":
    # Dev fallback : run with Flask built-in server (not for production)
    log.warning("Running with Flask dev server — use Gunicorn in production")
    app.run(host=WEB_HOST, port=WEB_PORT, threaded=True)