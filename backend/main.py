"""
AdBlock ML — Backend API
========================
FastAPI service handling:
  POST /events/batch   — receive labelled event batches from extensions
  GET  /model/latest   — return current model metadata + download URL
  GET  /health         — liveness probe

Run:
  pip install fastapi uvicorn sqlalchemy aiosqlite pydantic
  uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload

Environment variables:
  DATABASE_URL      — SQLite or PostgreSQL connection string
  MODEL_STORAGE_DIR — directory where .onnx model files are served from
  SECRET_KEY        — HMAC key for future request signing
  ALLOWED_ORIGINS   — comma-separated CORS origins
"""

import os
import hashlib
import json
import time
from pathlib import Path
from typing import Optional, List
from datetime import datetime

from fastapi import FastAPI, HTTPException, BackgroundTasks, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, validator
import uvicorn

# ─── Config ───────────────────────────────────────────────────────────────────

DATABASE_URL      = os.getenv('DATABASE_URL', 'sqlite+aiosqlite:///./adblock_ml.db')
MODEL_STORAGE_DIR = Path(os.getenv('MODEL_STORAGE_DIR', './models'))
ALLOWED_ORIGINS   = os.getenv('ALLOWED_ORIGINS', 'chrome-extension://,moz-extension://').split(',')

MODEL_STORAGE_DIR.mkdir(parents=True, exist_ok=True)

# ─── App ──────────────────────────────────────────────────────────────────────

app = FastAPI(
    title='AdBlock ML API',
    version='0.1.0',
    docs_url='/docs',
    redoc_url=None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=['GET', 'POST'],
    allow_headers=['Content-Type'],
)

# ─── DB (simple SQLite via raw sqlite3 — swap to SQLAlchemy for Postgres) ────

import sqlite3
DB_PATH = './adblock_ml.db'

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS events (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            url_hash    TEXT NOT NULL,
            domain_hash TEXT,
            features    TEXT,
            prediction  REAL,
            decision    TEXT,
            feedback    TEXT,
            client_ver  TEXT,
            received_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_events_domain ON events(domain_hash);
        CREATE INDEX IF NOT EXISTS idx_events_feedback ON events(feedback);
        CREATE INDEX IF NOT EXISTS idx_events_received ON events(received_at);

        CREATE TABLE IF NOT EXISTS models (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            version     TEXT NOT NULL UNIQUE,
            filename    TEXT NOT NULL,
            sha256      TEXT NOT NULL,
            feature_schema TEXT,
            threshold   REAL DEFAULT 0.78,
            rollout_pct INTEGER DEFAULT 100,
            created_at  INTEGER NOT NULL,
            active      INTEGER DEFAULT 0
        );
    """)
    conn.commit()
    conn.close()

init_db()

# ─── Schemas ──────────────────────────────────────────────────────────────────

class EventRecord(BaseModel):
    url_hash:    str = Field(..., min_length=8, max_length=64)
    domain_hash: Optional[str] = None
    features:    Optional[List[float]] = None
    prediction:  Optional[float] = None
    decision:    str
    feedback:    Optional[str] = None
    timestamp:   int

    @validator('decision')
    def valid_decision(cls, v):
        if v not in ('block', 'allow', 'dnr', 'cache'):
            raise ValueError(f'Invalid decision: {v}')
        return v

    @validator('feedback')
    def valid_feedback(cls, v):
        if v is not None and v not in ('fp', 'fn', 'confirmed'):
            raise ValueError(f'Invalid feedback: {v}')
        return v

    @validator('features')
    def valid_features(cls, v):
        if v is not None and len(v) > 100:
            raise ValueError('Too many features')
        return v


class BatchPayload(BaseModel):
    events:     List[EventRecord] = Field(..., max_items=500)
    client_ver: Optional[str] = None
    sent_at:    Optional[int] = None


class BatchResponse(BaseModel):
    received:   int
    rejected:   int
    batch_id:   str


class ModelMeta(BaseModel):
    version:      str
    sha256:       str
    download_url: str
    threshold:    float
    rollout_pct:  int
    feature_count: int

# ─── Endpoints ────────────────────────────────────────────────────────────────

@app.get('/health')
def health():
    return { 'status': 'ok', 'time': int(time.time()) }


@app.post('/events/batch', response_model=BatchResponse)
async def ingest_batch(payload: BatchPayload, request: Request, bg: BackgroundTasks):
    """
    Receive a batch of anonymised classification events from the extension.
    Only hashed URLs and feature vectors are accepted — no raw URLs.
    """
    received_at = int(time.time() * 1000)
    client_ver  = payload.client_ver or 'unknown'

    # Validate: reject if batch contains raw-looking URLs (shouldn't, but guard)
    valid, rejected = [], 0
    for ev in payload.events:
        # SHA-1 hashes are hex strings of 32-64 chars; raw URLs contain ://
        if '://' in ev.url_hash or len(ev.url_hash) < 8:
            rejected += 1
            continue
        valid.append(ev)

    if valid:
        bg.add_task(_persist_events, valid, client_ver, received_at)

    batch_id = hashlib.sha256(f"{received_at}{len(valid)}".encode()).hexdigest()[:12]
    return BatchResponse(received=len(valid), rejected=rejected, batch_id=batch_id)


@app.get('/model/latest', response_model=ModelMeta)
def get_latest_model():
    """
    Return metadata for the current active model.
    Extension uses this to check if an update is available.
    """
    conn = get_db()
    row  = conn.execute(
        'SELECT * FROM models WHERE active=1 ORDER BY created_at DESC LIMIT 1'
    ).fetchone()
    conn.close()

    if not row:
        raise HTTPException(status_code=404, detail='No active model')

    features = json.loads(row['feature_schema'] or '{}').get('n_features', 27)

    return ModelMeta(
        version      = row['version'],
        sha256       = row['sha256'],
        download_url = f"/model/download/{row['filename']}",
        threshold    = row['threshold'],
        rollout_pct  = row['rollout_pct'],
        feature_count= features,
    )


@app.get('/model/download/{filename}')
def download_model(filename: str):
    """Serve a model file. In production, redirect to S3 pre-signed URL instead."""
    from fastapi.responses import FileResponse
    path = MODEL_STORAGE_DIR / filename
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail='Model file not found')
    # Guard against path traversal
    if not str(path.resolve()).startswith(str(MODEL_STORAGE_DIR.resolve())):
        raise HTTPException(status_code=400)
    return FileResponse(str(path), media_type='application/octet-stream')


# ─── Admin helpers (not exposed in production) ───────────────────────────────

@app.post('/admin/register-model')
def register_model(
    version: str,
    filename: str,
    sha256: str,
    threshold: float = 0.78,
    rollout_pct: int = 10,
    feature_schema: str = '{"n_features": 27}',
):
    """
    Register a new model version. In production, require auth header.
    Starts at 10% rollout — increase manually after monitoring.
    """
    conn = get_db()
    # Deactivate current active model
    conn.execute('UPDATE models SET active=0 WHERE active=1')
    conn.execute(
        'INSERT OR REPLACE INTO models '
        '(version, filename, sha256, feature_schema, threshold, rollout_pct, created_at, active) '
        'VALUES (?,?,?,?,?,?,?,1)',
        (version, filename, sha256, feature_schema, threshold, rollout_pct, int(time.time()))
    )
    conn.commit()
    conn.close()
    return { 'ok': True, 'version': version, 'rollout_pct': rollout_pct }


@app.get('/admin/stats')
def admin_stats():
    """Basic ingestion stats for monitoring."""
    conn  = get_db()
    total = conn.execute('SELECT COUNT(*) FROM events').fetchone()[0]
    by_decision = dict(conn.execute(
        'SELECT decision, COUNT(*) FROM events GROUP BY decision'
    ).fetchall())
    by_feedback = dict(conn.execute(
        'SELECT feedback, COUNT(*) FROM events WHERE feedback IS NOT NULL GROUP BY feedback'
    ).fetchall())
    conn.close()
    return { 'total_events': total, 'by_decision': by_decision, 'by_feedback': by_feedback }


# ─── Background task ──────────────────────────────────────────────────────────

def _persist_events(events: list, client_ver: str, received_at: int):
    conn = get_db()
    rows = [
        (
            ev.url_hash,
            ev.domain_hash,
            json.dumps(ev.features) if ev.features else None,
            ev.prediction,
            ev.decision,
            ev.feedback,
            client_ver,
            received_at,
        )
        for ev in events
    ]
    conn.executemany(
        'INSERT INTO events '
        '(url_hash, domain_hash, features, prediction, decision, feedback, client_ver, received_at) '
        'VALUES (?,?,?,?,?,?,?,?)',
        rows,
    )
    conn.commit()
    conn.close()


# ─── Entry point ─────────────────────────────────────────────────────────────

if __name__ == '__main__':
    uvicorn.run('main:app', host='0.0.0.0', port=8000, reload=True)
