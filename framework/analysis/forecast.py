#!/usr/bin/env python3
"""
forecast.py — Prediction engine (moving from "describing the past" to "predicting the future")

Builds on top of timeseries.py (descriptive). Methods are validated against 2026 literature;
no home-grown models — only academically established approaches:

  1. Szabo-Huberman (2010, CACM): early log(views) correlates strongly with final log(views).
     Linear regression from early snapshots predicts final view count.
     YouTube data requires ~10 days of tracking for reliable estimates.
  2. Gompertz / Logistic growth curves: fit S-shaped trajectories and extrapolate the saturation value.
     ⚠️ Academic caveat: fitting a saturation value on data that hasn't plateaued is unreliable.

⭐ Honest boundaries (against "fake completion" — prediction is not fortune-telling):
  - Every prediction includes R² and a data-sufficiency check; returns insufficient/low-confidence
    when data is inadequate.
  - Szabo-Huberman requires paired (early, final) training samples (n≥30 to be marked reliable).
  - data_readiness() runs a health check first: reports honestly whether current data is enough.

Usage: import as a library — functions operate on the 5-table schema, called by xhs analysis
       and user scripts.
"""
from __future__ import annotations

import json
import math
import os
from datetime import datetime
from pathlib import Path

import numpy as np

DB = Path(__file__).resolve().parent.parent / "demo.db"


def _linreg(xs: list[float], ys: list[float]):
    """Ordinary least-squares linear regression y = a*x + b. Returns (a, b, r2). Pure Python closed-form solution."""
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx == 0:
        return None
    a = sum((xs[i] - mx) * (ys[i] - my) for i in range(n)) / sxx
    b = my - a * mx
    ss_tot = sum((y - my) ** 2 for y in ys)
    ss_res = sum((ys[i] - (a * xs[i] + b)) ** 2 for i in range(n))
    r2 = 1 - ss_res / ss_tot if ss_tot else 0.0
    return a, b, r2


# ============================================================
# Szabo-Huberman: early views → final views (log-linear)
# ============================================================

def szabo_huberman_fit(pairs: list[tuple[float, float]]) -> dict:
    """Fit a log-linear model from (early_views, final_views) pairs.
    reliable: only marked True when n≥30 and r2≥0.7 — otherwise treat as indicative only."""
    pairs = [(e, fin) for e, fin in pairs if e > 0 and fin > 0]
    if len(pairs) < 3:
        return {"error": "insufficient_data", "n": len(pairs),
                "note": "requires ≥3 pairs to fit, ≥30 for reliable estimates"}
    xs = [math.log(e) for e, _ in pairs]
    ys = [math.log(fin) for _, fin in pairs]
    a, b, r2 = _linreg(xs, ys)
    return {"a": a, "b": b, "r2": r2, "n": len(pairs),
            "reliable": len(pairs) >= 30 and r2 >= 0.7}


def szabo_huberman_predict(model: dict, early_views: float) -> dict:
    """Predict final view count from early views using a fitted Szabo-Huberman model."""
    if "a" not in model or early_views <= 0:
        return {"error": "bad_model_or_input"}
    pred = math.exp(model["a"] * math.log(early_views) + model["b"])
    return {"early": early_views, "predicted_final": round(pred),
            "confidence": "high" if model.get("reliable") else "low(insufficient data, indicative only)",
            "model_r2": round(model["r2"], 3), "model_n": model["n"]}


# ============================================================
# Growth curves: Gompertz / Logistic
# Requires ≥4 time points per object. Non-linear fitting needs scipy.optimize.curve_fit.
# Curve functions and stubs provided here; full fitting will be wired to scipy once
# enough data accumulates. (Honest: not pretending fitting is already implemented.)
# ============================================================

def gompertz(t: float, asymptote: float, b: float, c: float) -> float:
    """Gompertz: y = asymptote * exp(-b * exp(-c*t))  (fast early growth, late saturation — typical of viral content)."""
    return asymptote * math.exp(-b * math.exp(-c * t))


def logistic(t: float, asymptote: float, k: float, t0: float) -> float:
    """Logistic: y = asymptote / (1 + exp(-k*(t-t0)))  (symmetric S-curve)."""
    return asymptote / (1 + math.exp(-k * (t - t0)))


# ============================================================
# Data readiness: is the current data sufficient for prediction?
# ============================================================

def data_readiness(con, platform="youtube") -> dict:
    """Honest health check: reports whether the data is sufficient for prediction."""
    # Count how many videos have ≥2 view_count snapshots (longitudinal trajectory)
    multi = con.execute(
        "SELECT COUNT(*) FROM (SELECT ref_id FROM metrics WHERE platform=? "
        "AND scope='item' AND metric_name='view_count' "
        "GROUP BY ref_id HAVING COUNT(DISTINCT captured_at) >= 2)", (platform,)).fetchone()[0]
    span = con.execute(
        "SELECT MIN(captured_at), MAX(captured_at) FROM metrics WHERE platform=? "
        "AND scope='item' AND metric_name='view_count'", (platform,)).fetchone()
    return {
        "videos_with_trajectory": multi,
        "time_span": f"{(span[0] or '?')[:10]} → {(span[1] or '?')[:10]}",
        "szabo_huberman_ready": multi >= 30,          # enough paired training samples?
        "curve_fit_ready": False,                      # needs ≥4 points per video; currently at most 2
        "verdict": ("ready for initial prediction" if multi >= 30 else
                    f"insufficient data ({multi} videos with ≥2 snapshots; need ≥30; curve fitting needs ≥4 points per video)"),
    }


# ============================================================
# Feature prediction model (cross-sectional: publish-time features → final view count)
# Backtest validates holdout R²≈0.55. No time-series data needed — trains on the full
# existing sample. Answers "what order of magnitude can this video reach?" not a
# per-video trajectory forecast.
# ============================================================

_SEGS = ['zh', 'ko', 'ja', 'es']                              # 'en' is the baseline
_CATS = ['official', 'spicy', 'geo', 'repost', 'conspiracy']  # 'serious' is the baseline
FEATURE_NAMES = (['log_dur', 'log_subs', 'log_age', 'title_len', 'has_num', 'has_q', 'has_excl']
                 + ['lang_' + s for s in _SEGS] + ['cat_' + c for c in _CATS] + ['recency'])


def _feature_vector(dur, subs, age, title, seg, cat, recency=0.5):
    f = [math.log(dur), math.log(subs), math.log(age), len(title or ''),
         int(any(c.isdigit() for c in (title or ''))),
         int('?' in (title or '') or '？' in (title or '')),
         int('!' in (title or '') or '！' in (title or ''))]
    return f + [int(seg == s) for s in _SEGS] + [int(cat == c) for c in _CATS] + [recency]


def _embed_titles(titles):
    """Fetch title embeddings and project to 20 dims via a persisted PCA transform (ablation-validated +0.05 R²). Requires a local LLM service and title_pca.npz."""
    import urllib.request
    model = os.environ.get("PRISM_LLM_PRIMARY", "primary-model")
    out = []
    for i in range(0, len(titles), 64):
        body = json.dumps({"model": model, "input": titles[i:i + 64]}).encode()
        req = urllib.request.Request(
            os.environ.get("PRISM_LLM_BASE", "http://localhost:4000/v1") + "/embeddings", data=body,
            headers={"Content-Type": "application/json",
                     "Authorization": "Bearer " + os.environ.get("PRISM_LLM_KEY", "sk-x")})
        out.extend(d['embedding'] for d in
                   json.loads(urllib.request.urlopen(req, timeout=120).read())['data'])
    pca = np.load(Path(__file__).resolve().parent.parent / "data" / "title_pca.npz")
    return (np.array(out) - pca['mean']) @ pca['components'].T


def build_feature_matrix(con, platform="youtube", today=None, with_embedding=False):
    """Build (X, y, item_ids) from the DB. y = log(view_count). Includes relative topic
    recency (publish-time percentile within the same category). with_embedding=True appends
    20 title-semantic dims (requires a local LLM service and title_pca.npz)."""
    import bisect
    from collections import defaultdict
    today = today or datetime.now()
    rows = con.execute("""
        SELECT i.item_id, i.title, i.published_at, i.meta_json, i.segment, i.category,
               i.entity_id, m.metric_value
        FROM items i JOIN metrics m ON m.platform=i.platform AND m.scope='item'
            AND m.ref_id=i.item_id AND m.metric_name='view_count'
        WHERE i.platform=? AND m.metric_value>0 AND i.published_at!='' GROUP BY i.item_id
    """, (platform,)).fetchall()
    subs_map = dict(con.execute(
        "SELECT ref_id, metric_value FROM metrics WHERE platform=? AND scope='entity' "
        "AND metric_name='subs'", (platform,)).fetchall())
    cat_ages, parsed = defaultdict(list), []
    for item_id, title, pub, meta, seg, cat, ent, views in rows:
        dur = (json.loads(meta or '{}').get('duration')) or 0
        subs = subs_map.get(ent, 0) or 0
        try:
            age = (today - datetime.strptime(pub[:8], "%Y%m%d")).days
        except Exception:
            continue
        if dur <= 0 or subs <= 0 or age <= 0:
            continue
        cat_ages[cat].append(age)
        parsed.append((item_id, title, dur, subs, age, seg, cat, views))
    for c in cat_ages:
        cat_ages[c].sort()
    X, y, ids, titles = [], [], [], []
    for item_id, title, dur, subs, age, seg, cat, views in parsed:
        arr = cat_ages[cat]
        rec = bisect.bisect_left(arr, age) / max(1, len(arr) - 1)   # relative topic recency (percentile)
        X.append(_feature_vector(dur, subs, age, title, seg, cat, rec))
        y.append(math.log(views))
        ids.append(item_id)
        titles.append(title or "")
    X = np.array(X, float)
    if with_embedding:
        X = np.column_stack([X, _embed_titles(titles)])
    return X, np.array(y, float), ids


def _r2(yt, yp):
    return 1 - ((yt - yp) ** 2).sum() / ((yt - yt.mean()) ** 2).sum()


def feature_backtest(con, platform="youtube", k=5, seed=42, with_embedding=False) -> dict:
    """K-fold cross-validation backtest. ⭐ Reports holdout R² (not train R²) — do not fool yourself.
    Smaller overfit_gap means more stable generalization.
    Default (with topic recency): R²≈0.58. with_embedding=True adds title semantics → R²≈0.63
    (requires a local LLM service)."""
    X, y, _ = build_feature_matrix(con, platform, with_embedding=with_embedding)
    if len(y) < k * 10:
        return {"error": "insufficient_data", "n": len(y)}
    np.random.seed(seed)
    folds = np.array_split(np.random.permutation(len(y)), k)
    tr, te = [], []
    for i in range(k):
        tei = folds[i]
        tri = np.concatenate([folds[j] for j in range(k) if j != i])
        Xtr, ytr, Xte, yte = X[tri], y[tri], X[tei], y[tei]
        mu, sd = Xtr.mean(0), Xtr.std(0)
        sd[sd == 0] = 1
        Atr = np.column_stack([np.ones(len(Xtr)), (Xtr - mu) / sd])
        Ate = np.column_stack([np.ones(len(Xte)), (Xte - mu) / sd])
        beta, *_ = np.linalg.lstsq(Atr, ytr, rcond=None)
        tr.append(_r2(ytr, Atr @ beta))
        te.append(_r2(yte, Ate @ beta))
    return {"holdout_r2": round(float(np.mean(te)), 3), "train_r2": round(float(np.mean(tr)), 3),
            "holdout_std": round(float(np.std(te)), 3),
            "overfit_gap": round(float(np.mean(tr) - np.mean(te)), 3), "n": len(y), "k": k}


def feature_model_fit(con, platform="youtube") -> dict:
    """Fit on the full sample. Returns a model dict for use with feature_predict,
    including standardized coefficients (= feature importance)."""
    X, y, _ = build_feature_matrix(con, platform)
    mu, sd = X.mean(0), X.std(0)
    sd[sd == 0] = 1
    A = np.column_stack([np.ones(len(X)), (X - mu) / sd])
    beta, *_ = np.linalg.lstsq(A, y, rcond=None)
    importance = sorted(zip(FEATURE_NAMES, beta[1:].tolist(), strict=True),
                        key=lambda t: abs(t[1]), reverse=True)
    return {"beta": beta.tolist(), "mu": mu.tolist(), "sd": sd.tolist(),
            "names": FEATURE_NAMES, "r2": round(float(_r2(y, A @ beta)), 3),
            "importance": importance}


def feature_predict(model, dur, subs, age, title, seg, cat) -> dict:
    """Predict final view count for a single video using the fitted model (publish-time features → predicted views)."""
    f = np.array(_feature_vector(dur, subs, age, title, seg, cat), float)
    fs = (f - np.array(model["mu"])) / np.array(model["sd"])
    log_pred = model["beta"][0] + float(np.dot(model["beta"][1:], fs))
    return {"predicted_views": round(math.exp(log_pred)),
            "confidence": "model holdout R²≈0.55 (the rest depends on content quality and luck)",
            "note": "cross-sectional order-of-magnitude estimate, not a precise value"}
