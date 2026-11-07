"""FastAPI application for the read-only returns dashboard."""

from __future__ import annotations

from datetime import date
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from app.db import DatabaseError, close
from app.queries import Filters, QueryError, filter_options, load_bundle

ROOT = Path(__file__).resolve().parents[1]
STATIC_DIR = ROOT / "static"

app = FastAPI(title="Дашборд возвратов", version="0.1.0")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/", response_class=HTMLResponse)
def index() -> HTMLResponse:
    return HTMLResponse((STATIC_DIR / "index.html").read_text(encoding="utf-8"))


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "database_mode": "read_only"}


@app.get("/api/filters")
def filters() -> dict:
    try:
        return filter_options()
    except (DatabaseError, QueryError) as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/dashboard")
def dashboard(
    date_from: date,
    date_to: date,
    category_id: list[int] = Query(default=[]),
    seller_id: list[int] = Query(default=[]),
) -> dict:
    if date_from > date_to:
        raise HTTPException(status_code=422, detail="Начальная дата позже конечной.")
    try:
        return load_bundle(
            Filters(
                date_from=date_from,
                date_to=date_to,
                category_ids=tuple(sorted(set(category_id))),
                seller_ids=tuple(sorted(set(seller_id))),
            )
        )
    except (DatabaseError, QueryError) as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.on_event("shutdown")
def shutdown() -> None:
    close()
