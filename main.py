"""
Key Rotation Manager + Analytics
─────────────────────────────────
Run:  pip install fastapi uvicorn && uvicorn main:app --host 0.0.0.0 --port 8000
Panel:  http://YOUR_IP:8000
"""

import sqlite3, time, uuid, os
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Optional
from pathlib import Path

from fastapi import FastAPI, HTTPException, Depends, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel

# ─────────────────────────────────────────────────
DB_PATH      = "manager.db"
ADMIN_SECRET = "zqinx-admin-6767"   # ← change this
TEMPLATES    = Path(__file__).parent  # html files same folder
# ─────────────────────────────────────────────────

def get_db():
    c = sqlite3.connect(DB_PATH, check_same_thread=False)
    c.row_factory = sqlite3.Row
    return c

def init_db():
    c = get_db()
    c.executescript("""
        CREATE TABLE IF NOT EXISTS api_keys (
            id          TEXT PRIMARY KEY,
            label       TEXT NOT NULL,
            key_value   TEXT NOT NULL UNIQUE,
            daily_limit INTEGER NOT NULL DEFAULT 100,
            used_today  INTEGER NOT NULL DEFAULT 0,
            total_used  INTEGER NOT NULL DEFAULT 0,
            is_active   INTEGER NOT NULL DEFAULT 1,
            last_reset  TEXT NOT NULL,
            created_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS request_log (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            key_id      TEXT,
            key_label   TEXT,
            endpoint    TEXT NOT NULL DEFAULT 'rotate',
            status_code INTEGER NOT NULL DEFAULT 200,
            latency_ms  INTEGER NOT NULL DEFAULT 0,
            success     INTEGER NOT NULL DEFAULT 1,
            ip          TEXT,
            ts          TEXT NOT NULL
        );
    """)
    c.commit(); c.close()

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db(); yield

app = FastAPI(title="Key Rotation Manager", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

security = HTTPBearer(auto_error=False)

def auth(creds: Optional[HTTPAuthorizationCredentials] = Depends(security)):
    if not creds or creds.credentials != ADMIN_SECRET:
        raise HTTPException(401, "Unauthorized")

def now() -> str:  return datetime.now(timezone.utc).isoformat()
def today() -> str: return datetime.now(timezone.utc).date().isoformat()

def maybe_reset(row, conn):
    d = dict(row)
    if d.get("last_reset", "")[:10] != today():
        conn.execute("UPDATE api_keys SET used_today=0, last_reset=? WHERE id=?", (now(), d["id"]))
        conn.commit()
        d["used_today"] = 0
    return d

# ── Schemas ─────────────────────────────────────
class KeyCreate(BaseModel):
    label: str
    key_value: str
    daily_limit: int = 100

class KeyUpdate(BaseModel):
    label: Optional[str] = None
    daily_limit: Optional[int] = None
    is_active: Optional[bool] = None

# ════════════════════════════════════════════════
#  /rotate  — called by youtube.py
#  Final API itself has NO limit — only the
#  individual Shruti keys have 100/day limit.
# ════════════════════════════════════════════════
@app.get("/rotate")
async def rotate(request: Request, endpoint: str = "download"):
    t0 = time.monotonic()
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM api_keys WHERE is_active=1 ORDER BY used_today ASC"
    ).fetchall()

    chosen = None
    for row in rows:
        d = maybe_reset(row, conn)
        if d["used_today"] < d["daily_limit"]:
            chosen = d; break

    latency = int((time.monotonic() - t0) * 1000)
    ip = request.client.host if request.client else "unknown"

    if not chosen:
        # log the exhausted event
        conn.execute(
            "INSERT INTO request_log (key_id,key_label,endpoint,status_code,latency_ms,success,ip,ts) VALUES (?,?,?,?,?,?,?,?)",
            (None, "ALL_EXHAUSTED", endpoint, 429, latency, 0, ip, now())
        )
        conn.commit(); conn.close()
        raise HTTPException(429, "All Shruti keys exhausted. Reset at UTC midnight.")

    conn.execute(
        "UPDATE api_keys SET used_today=used_today+1, total_used=total_used+1 WHERE id=?",
        (chosen["id"],)
    )
    conn.execute(
        "INSERT INTO request_log (key_id,key_label,endpoint,status_code,latency_ms,success,ip,ts) VALUES (?,?,?,?,?,?,?,?)",
        (chosen["id"], chosen["label"], endpoint, 200, latency, 1, ip, now())
    )
    conn.commit(); conn.close()

    return {
        "key_value":   chosen["key_value"],
        "label":       chosen["label"],
        "used_today":  chosen["used_today"] + 1,
        "daily_limit": chosen["daily_limit"],
        "remaining":   chosen["daily_limit"] - chosen["used_today"] - 1,
    }

# ════════════════════════════════════════════════
#  ADMIN — KEYS CRUD
# ════════════════════════════════════════════════
@app.get("/admin/keys", dependencies=[Depends(auth)])
def list_keys():
    conn = get_db()
    rows = conn.execute("SELECT * FROM api_keys ORDER BY created_at DESC").fetchall()
    out = []
    for row in rows:
        d = maybe_reset(row, conn)
        d["remaining"] = max(0, d["daily_limit"] - d["used_today"])
        d["pct_used"]  = round(d["used_today"] / d["daily_limit"] * 100, 1) if d["daily_limit"] else 0
        out.append(d)
    conn.close(); return out

@app.post("/admin/keys", dependencies=[Depends(auth)])
def add_key(body: KeyCreate):
    conn = get_db(); kid = str(uuid.uuid4())[:8]
    try:
        conn.execute(
            "INSERT INTO api_keys (id,label,key_value,daily_limit,last_reset,created_at) VALUES (?,?,?,?,?,?)",
            (kid, body.label, body.key_value, body.daily_limit, now(), now())
        )
        conn.commit()
    except sqlite3.IntegrityError:
        conn.close(); raise HTTPException(409, "Key value already exists")
    conn.close(); return {"id": kid, "message": "Key added"}

@app.patch("/admin/keys/{kid}", dependencies=[Depends(auth)])
def update_key(kid: str, body: KeyUpdate):
    conn = get_db()
    if not conn.execute("SELECT id FROM api_keys WHERE id=?", (kid,)).fetchone():
        conn.close(); raise HTTPException(404, "Not found")
    if body.label       is not None: conn.execute("UPDATE api_keys SET label=? WHERE id=?",       (body.label, kid))
    if body.daily_limit is not None: conn.execute("UPDATE api_keys SET daily_limit=? WHERE id=?", (body.daily_limit, kid))
    if body.is_active   is not None: conn.execute("UPDATE api_keys SET is_active=? WHERE id=?",   (int(body.is_active), kid))
    conn.commit(); conn.close(); return {"message": "Updated"}

@app.delete("/admin/keys/{kid}", dependencies=[Depends(auth)])
def delete_key(kid: str):
    conn = get_db()
    conn.execute("DELETE FROM api_keys WHERE id=?", (kid,))
    conn.commit(); conn.close(); return {"message": "Deleted"}

@app.post("/admin/keys/{kid}/reset", dependencies=[Depends(auth)])
def reset_key(kid: str):
    conn = get_db()
    conn.execute("UPDATE api_keys SET used_today=0, last_reset=? WHERE id=?", (now(), kid))
    conn.commit(); conn.close(); return {"message": "Reset done"}

@app.post("/admin/reset-all", dependencies=[Depends(auth)])
def reset_all():
    conn = get_db()
    conn.execute("UPDATE api_keys SET used_today=0, last_reset=?", (now(),))
    conn.commit(); conn.close(); return {"message": "All reset"}

# ════════════════════════════════════════════════
#  ANALYTICS DATA  — /analytics/data
# ════════════════════════════════════════════════
@app.get("/analytics/data", dependencies=[Depends(auth)])
def analytics_data():
    conn = get_db()
    cutoff24 = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()

    total   = conn.execute("SELECT COUNT(*) FROM request_log").fetchone()[0]
    success = conn.execute("SELECT COUNT(*) FROM request_log WHERE success=1").fetchone()[0]
    error   = conn.execute("SELECT COUNT(*) FROM request_log WHERE success=0").fetchone()[0]
    uniq_ip = conn.execute("SELECT COUNT(DISTINCT ip) FROM request_log").fetchone()[0]
    avg_lat = conn.execute("SELECT AVG(latency_ms) FROM request_log").fetchone()[0]
    avg_lat = round(avg_lat, 1) if avg_lat else 0
    err_rate = round(error / total * 100, 1) if total else 0.0

    # uptime from first log
    first = conn.execute("SELECT ts FROM request_log ORDER BY id ASC LIMIT 1").fetchone()
    uptime_s = 0
    if first:
        try:
            ft = datetime.fromisoformat(first["ts"].replace("Z",""))
            if ft.tzinfo is None:
                ft = ft.replace(tzinfo=timezone.utc)
            uptime_s = int((datetime.now(timezone.utc) - ft).total_seconds())
        except Exception:
            uptime_s = 0

    # hourly buckets last 24h
    hourly_raw = conn.execute("""
        SELECT strftime('%H', ts) as hr,
               COUNT(*) as hits,
               SUM(success) as s,
               SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) as e
        FROM request_log WHERE ts > ?
        GROUP BY hr ORDER BY hr
    """, (cutoff24,)).fetchall()
    hourly = [{"label": r["hr"]+":00", "hits": r["hits"],
               "success": r["s"] or 0, "error": r["e"] or 0}
              for r in hourly_raw]

    # top endpoints
    ep_raw = conn.execute("""
        SELECT endpoint,
               COUNT(*) as hits,
               SUM(success) as s,
               SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) as e,
               AVG(latency_ms) as avg_lat,
               MIN(latency_ms) as min_lat,
               MAX(latency_ms) as max_lat
        FROM request_log
        GROUP BY endpoint ORDER BY hits DESC LIMIT 20
    """).fetchall()
    endpoints = [{
        "name": r["endpoint"], "hits": r["hits"],
        "success": r["s"] or 0, "error": r["e"] or 0,
        "avgLatencyMs": round(r["avg_lat"] or 0, 1),
        "minLatency":   r["min_lat"] or 0,
        "maxLatency":   r["max_lat"] or 0,
        "errorRate":    round((r["e"] or 0) / r["hits"] * 100, 1) if r["hits"] else 0
    } for r in ep_raw]

    # status codes
    sc_raw = conn.execute("""
        SELECT status_code as code, COUNT(*) as cnt
        FROM request_log GROUP BY code ORDER BY cnt DESC
    """).fetchall()
    status_dist = [{"code": str(r["code"]), "count": r["cnt"]} for r in sc_raw]

    # recent 40
    recent_raw = conn.execute(
        "SELECT * FROM request_log ORDER BY id DESC LIMIT 40"
    ).fetchall()
    recent = [{
        "time": r["ts"], "endpoint": r["endpoint"],
        "statusCode": r["status_code"], "latencyMs": r["latency_ms"],
        "success": bool(r["success"]), "ip": r["ip"] or "—",
        "keyLabel": r["key_label"] or "—"
    } for r in recent_raw]

    # per-key breakdown
    key_rows = conn.execute("SELECT * FROM api_keys ORDER BY total_used DESC").fetchall()
    keys_data = []
    for row in key_rows:
        d = maybe_reset(row, conn)
        d["remaining"] = max(0, d["daily_limit"] - d["used_today"])
        d["pct_used"]  = round(d["used_today"] / d["daily_limit"] * 100, 1) if d["daily_limit"] else 0
        keys_data.append(d)

    conn.close()
    return {
        "totalRequests": total,
        "totalSuccess":  success,
        "totalError":    error,
        "errorRate":     err_rate,
        "uniqueIps":     uniq_ip,
        "avgLatency":    avg_lat,
        "uptime":        uptime_s,
        "totalEndpoints": len(endpoints),
        "hourlyChart":   hourly,
        "topEndpoints":  endpoints,
        "statusDist":    status_dist,
        "recentRequests": recent,
        "keys":          keys_data,
    }

# ════════════════════════════════════════════════
#  SERVE HTML PAGES
# ════════════════════════════════════════════════
@app.get("/", response_class=HTMLResponse)
def home():
    return HTMLResponse(open(TEMPLATES / "analytics.html").read()
        .replace("<%= owner %>", "Admin")
        .replace("<%= channel %>", "Key Rotator")
        .replace("<%= totalEndpoints %>", "—"))

@app.get("/keys", response_class=HTMLResponse)
def keys_page():
    return HTMLResponse(open(TEMPLATES / "keys.html").read())

@app.get("/health")
def health(): return {"status": "ok", "ts": now()}
