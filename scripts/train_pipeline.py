"""
AdBlock ML — Training Pipeline v2
===================================
Builds a labeled dataset from the events database, trains LightGBM,
exports to ONNX, and registers the new model with the backend.

Usage:
  pip install lightgbm scikit-learn pandas numpy onnx onnxmltools requests
  python scripts/train_pipeline.py --db adblock_ml.db --output models/

Steps:
  1. Load events from SQLite (or CSV fallback)
  2. Filter: keep events with feedback or high-confidence decisions
  3. Assign labels from feedback > model agreement > heuristic
  4. Balance classes (under-sample majority)
  5. Train LightGBM
  6. Evaluate (precision > recall — we prefer fewer false positives)
  7. Export to ONNX
  8. Register with backend (optional)
"""

import argparse
import json
import os
import sqlite3
import hashlib
import time
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report, roc_auc_score, precision_recall_fscore_support

# ─── Feature names — must match classifier.js ────────────────────────────────

FEATURE_NAMES = [
    'url_length', 'path_depth', 'query_param_count', 'has_numeric_id',
    'subdomain_depth', 'ad_keyword_count', 'has_tracker_param',
    'path_entropy', 'query_entropy', 'domain_length', 'is_cdn_domain', 'tld_type',
    'avg_identifier_length', 'short_identifier_ratio', 'bracket_dot_ratio',
    'string_literal_density', 'hex_literal_count', 'max_brace_depth',
    'eval_usage', 'fetch_count_in_script', 'beacon_count',
    'initiator_depth', 'sibling_request_count', 'is_third_party',
    'request_timing_zscore', 'late_injection', 'is_ml_eligible_type',
]
N_FEATURES = len(FEATURE_NAMES)

# ─── Label assignment ─────────────────────────────────────────────────────────

def assign_label(row):
    """
    Label priority:
      1. Explicit user feedback (most trusted)
      2. Model decision if high-confidence
      3. Drop ambiguous events
    """
    feedback = row.get('feedback')
    if feedback == 'fp':        return 0  # False positive → was clean
    if feedback == 'fn':        return 1  # False negative → was an ad
    if feedback == 'confirmed': return 1  # User confirmed block

    decision   = row.get('decision')
    prediction = row.get('prediction')

    # High-confidence model decision with no user feedback
    if decision == 'block' and prediction is not None and prediction >= 0.90:
        return 1
    if decision == 'allow' and prediction is not None and prediction <= 0.20:
        return 0

    return None  # Ambiguous — drop


# ─── Data loading ─────────────────────────────────────────────────────────────

def load_from_db(db_path: str) -> pd.DataFrame:
    print(f'Loading events from {db_path}')
    conn = sqlite3.connect(db_path)
    df   = pd.read_sql_query(
        'SELECT url_hash, domain_hash, features, prediction, decision, feedback '
        'FROM events WHERE features IS NOT NULL',
        conn
    )
    conn.close()
    print(f'  Loaded {len(df):,} events with features')
    return df


def load_from_csv(csv_path: str) -> pd.DataFrame:
    print(f'Loading from CSV: {csv_path}')
    return pd.read_csv(csv_path)


def prepare_dataset(df: pd.DataFrame):
    rows_X, rows_y = [], []
    skipped = 0

    for _, row in df.iterrows():
        label = assign_label(row)
        if label is None:
            skipped += 1
            continue

        features_raw = row.get('features')
        if features_raw is None:
            skipped += 1
            continue

        if isinstance(features_raw, str):
            try:    features = json.loads(features_raw)
            except: skipped += 1; continue
        elif isinstance(features_raw, list):
            features = features_raw
        else:
            skipped += 1
            continue

        if len(features) != N_FEATURES:
            # Pad or truncate to match expected shape
            features = (features + [0] * N_FEATURES)[:N_FEATURES]

        rows_X.append(features)
        rows_y.append(label)

    print(f'  Labeled: {len(rows_X):,} | Skipped (ambiguous): {skipped:,}')
    if not rows_X:
        raise ValueError('No labeled data — run more browsing sessions and ensure feedback is captured')

    X = np.array(rows_X, dtype=np.float32)
    y = np.array(rows_y, dtype=np.int32)
    print(f'  Class distribution: {np.bincount(y)} (0=clean, 1=ad)')
    return X, y


def balance_dataset(X, y, max_ratio=3.0):
    """Under-sample majority class to at most max_ratio × minority."""
    n_pos = (y == 1).sum()
    n_neg = (y == 0).sum()
    limit = int(min(n_neg, n_pos) * max_ratio)

    if n_neg > limit:
        neg_idx = np.where(y == 0)[0]
        keep    = np.random.choice(neg_idx, limit, replace=False)
        pos_idx = np.where(y == 1)[0]
        idx     = np.concatenate([pos_idx, keep])
        np.random.shuffle(idx)
        X, y = X[idx], y[idx]
        print(f'  Balanced to {len(X):,} samples ({limit} clean, {n_pos} ad)')

    return X, y


# ─── Training ─────────────────────────────────────────────────────────────────

def train(X_train, y_train, X_val, y_val):
    try:
        import lightgbm as lgb
    except ImportError:
        print('lightgbm not installed — falling back to GradientBoosting')
        from sklearn.ensemble import GradientBoostingClassifier
        model = GradientBoostingClassifier(
            n_estimators=200, max_depth=5, learning_rate=0.05,
            subsample=0.8, max_features='sqrt', random_state=42,
        )
        model.fit(X_train, y_train)
        return model, 'sklearn_gbm'

    dtrain = lgb.Dataset(X_train, label=y_train, feature_name=FEATURE_NAMES)
    dval   = lgb.Dataset(X_val,   label=y_val,   reference=dtrain)

    params = {
        'objective':    'binary',
        'metric':       'binary_logloss',
        'learning_rate': 0.05,
        'num_leaves':   63,
        'max_depth':    6,
        'min_child_samples': 30,
        'feature_fraction': 0.8,
        'bagging_fraction': 0.8,
        'bagging_freq':  5,
        'lambda_l1':    0.1,
        'lambda_l2':    0.1,
        'is_unbalance': False,
        'verbose':      -1,
    }

    callbacks = [lgb.early_stopping(50, verbose=True), lgb.log_evaluation(50)]

    model = lgb.train(
        params, dtrain,
        num_boost_round=1000,
        valid_sets=[dval],
        callbacks=callbacks,
    )

    return model, 'lightgbm'


# ─── Evaluation ───────────────────────────────────────────────────────────────

def evaluate(model, X_test, y_test, model_type, threshold=0.78):
    if model_type == 'lightgbm':
        y_prob = model.predict(X_test)
    else:
        y_prob = model.predict_proba(X_test)[:, 1]

    y_pred = (y_prob >= threshold).astype(int)

    prec, rec, f1, _ = precision_recall_fscore_support(y_test, y_pred, average='binary')
    auc = roc_auc_score(y_test, y_prob)

    print('\n=== Evaluation ===')
    print(classification_report(y_test, y_pred, target_names=['clean', 'ad']))
    print(f'ROC-AUC: {auc:.4f}')
    print(f'Threshold={threshold} → Precision: {prec:.3f}  Recall: {rec:.3f}  F1: {f1:.3f}')

    if f1 < 0.80:
        print('\nWARNING: F1 below 0.80 — consider collecting more labeled data before deploying')

    # Feature importance
    if model_type == 'lightgbm':
        imp = sorted(zip(FEATURE_NAMES, model.feature_importance('gain')),
                     key=lambda x: x[1], reverse=True)
        print('\n=== Feature importance (top 10) ===')
        for name, val in imp[:10]:
            bar = '█' * int(val / max(v for _, v in imp) * 30)
            print(f'  {name:<35s} {bar}')

    return { 'auc': round(auc, 4), 'f1': round(f1, 4), 'precision': round(prec, 4), 'recall': round(rec, 4) }


# ─── ONNX export ──────────────────────────────────────────────────────────────

def export_onnx(model, model_type: str, output_path: str) -> str:
    print(f'\nExporting to ONNX: {output_path}')

    if model_type == 'lightgbm':
        try:
            from onnxmltools import convert_lightgbm
            from onnxmltools.convert.common.data_types import FloatTensorType
            onnx_model = convert_lightgbm(
                model,
                initial_types=[('float_input', FloatTensorType([None, N_FEATURES]))],
                target_opset=12,
            )
        except ImportError:
            print('onnxmltools not found — saving LightGBM model as .txt instead')
            txt_path = output_path.replace('.onnx', '.txt')
            model.save_model(txt_path)
            print(f'Saved: {txt_path}')
            return txt_path
    else:
        from skl2onnx import convert_sklearn
        from skl2onnx.common.data_types import FloatTensorType
        onnx_model = convert_sklearn(
            model,
            initial_types=[('float_input', FloatTensorType([None, N_FEATURES]))],
        )

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    serialized = onnx_model.SerializeToString()

    with open(output_path, 'wb') as f:
        f.write(serialized)

    sha256 = hashlib.sha256(serialized).hexdigest()
    size_kb = len(serialized) / 1024
    print(f'Exported: {output_path} ({size_kb:.0f} KB, sha256={sha256[:16]}…)')
    return output_path, sha256


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='AdBlock ML training pipeline')
    parser.add_argument('--db',      default='adblock_ml.db',      help='Events SQLite DB')
    parser.add_argument('--csv',     default=None,                  help='CSV fallback (no DB)')
    parser.add_argument('--output',  default='models/',             help='Output directory')
    parser.add_argument('--version', default=None,                  help='Model version tag')
    parser.add_argument('--threshold', type=float, default=0.78,   help='Block threshold')
    parser.add_argument('--register', action='store_true',          help='Register with backend')
    parser.add_argument('--backend-url', default='http://localhost:8000')
    args = parser.parse_args()

    np.random.seed(42)

    # Load data
    if args.csv:
        df = load_from_csv(args.csv)
    elif Path(args.db).exists():
        df = load_from_db(args.db)
    else:
        print('Generating synthetic data for pipeline validation...')
        from train_model import generate_synthetic_data
        df = generate_synthetic_data(4000)

    # Prepare
    X, y = prepare_dataset(df)
    X, y = balance_dataset(X, y)

    X_train, X_temp, y_train, y_temp = train_test_split(X, y, test_size=0.3, random_state=42, stratify=y)
    X_val,   X_test, y_val,   y_test = train_test_split(X_temp, y_temp, test_size=0.5, random_state=42, stratify=y_temp)

    print(f'\nTrain: {len(X_train):,}  Val: {len(X_val):,}  Test: {len(X_test):,}')

    # Train
    print('\nTraining...')
    model, model_type = train(X_train, y_train, X_val, y_val)

    # Evaluate
    metrics = evaluate(model, X_test, y_test, model_type, args.threshold)

    # Export
    version = args.version or f"v{int(time.time())}"
    out_dir = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)
    onnx_path = str(out_dir / f'model_{version}.onnx')

    result = export_onnx(model, model_type, onnx_path)
    if isinstance(result, tuple):
        onnx_path, sha256 = result
    else:
        onnx_path = result; sha256 = ''

    # Write metadata
    meta = {
        'version':        version,
        'model_type':     model_type,
        'n_features':     N_FEATURES,
        'feature_names':  FEATURE_NAMES,
        'threshold':      args.threshold,
        'metrics':        metrics,
        'sha256':         sha256,
        'trained_at':     int(time.time()),
    }
    meta_path = out_dir / f'model_{version}_meta.json'
    meta_path.write_text(json.dumps(meta, indent=2))
    print(f'Metadata: {meta_path}')

    # Also write to src/ml/ for extension
    src_ml_dir = Path(__file__).parent.parent / 'src' / 'ml'
    src_ml_dir.mkdir(parents=True, exist_ok=True)
    import shutil
    shutil.copy2(onnx_path, src_ml_dir / 'model.onnx')
    (src_ml_dir / 'model_meta.json').write_text(json.dumps(meta, indent=2))
    print(f'Copied to src/ml/model.onnx')

    # Register with backend
    if args.register:
        import requests
        resp = requests.post(f"{args.backend_url}/admin/register-model", params={
            'version':    version,
            'filename':   Path(onnx_path).name,
            'sha256':     sha256,
            'threshold':  args.threshold,
            'rollout_pct': 10,
            'feature_schema': json.dumps({'n_features': N_FEATURES}),
        })
        if resp.ok:
            print(f'\nRegistered model {version} at 10% rollout')
        else:
            print(f'\nRegistration failed: {resp.status_code} {resp.text}')

    print('\nDone.')


if __name__ == '__main__':
    main()
