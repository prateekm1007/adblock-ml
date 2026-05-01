"""
AdFlush GBM Classifier - Training Script
=========================================
Trains a GradientBoosting classifier on labeled ad/non-ad request data
and exports it to ONNX format for browser inference.

Usage:
  pip install scikit-learn pandas numpy skl2onnx onnx joblib requests
  python train_model.py --data data/requests.csv --output ../src/ml/model.onnx

Data format (requests.csv):
  label,url,type,initiator,timestamp,...
  1,https://doubleclick.net/ads/...,...
  0,https://example.com/api/data,...

If you don't have labeled data yet:
  python train_model.py --synthetic  # Generates synthetic data to validate the pipeline
"""

import argparse
import json
import re
import math
import numpy as np
import pandas as pd
from pathlib import Path
from urllib.parse import urlparse
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.model_selection import train_test_split, cross_val_score
from sklearn.metrics import classification_report, roc_auc_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
import joblib

# ─── Feature extraction (mirrors classifier.js) ────────────────────────────

AD_KEYWORDS = {
    'ad', 'ads', 'advert', 'advertisement', 'banner', 'sponsor',
    'tracking', 'analytics', 'pixel', 'beacon', 'doubleclick',
    'adsystem', 'adserver', 'pagead', 'adunit', 'prebid', 'dfp',
    'adsense', 'adroll', 'criteo', 'taboola', 'outbrain', 'mgid',
    'quantserve', 'scorecardresearch', 'rubiconproject', 'openx',
}

TRACKER_PARAMS = {
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'fbclid', 'gclid', 'msclkid', 'ttclid', '_ga', 'mc_eid',
}

CDN_PATTERNS = ['cdn', 'static', 'assets', 'media', 'img', 'files', 'cache']

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


def entropy(s: str) -> float:
    if not s or len(s) < 2:
        return 0.0
    freq = {}
    for c in s:
        freq[c] = freq.get(c, 0) + 1
    n = len(s)
    return -sum((v/n) * math.log2(v/n) for v in freq.values())


def count_ad_keywords(url: str) -> int:
    url_lower = url.lower()
    return min(sum(1 for kw in AD_KEYWORDS if kw in url_lower), 5)


def has_tracker_param(query: str) -> bool:
    if not query:
        return False
    params = {p.split('=')[0].lower() for p in query.split('&')}
    return bool(params & TRACKER_PARAMS)


def tld_type(hostname: str) -> int:
    tld = hostname.split('.')[-1].lower() if hostname else ''
    if tld in ('com', 'net', 'org'):
        return 0
    if tld in ('io', 'co', 'ai', 'app'):
        return 1
    return 2


def extract_features(row: dict) -> list:
    url = row.get('url', '')
    rtype = row.get('type', '')
    initiator = row.get('initiator', '')

    try:
        parsed = urlparse(url)
        path = parsed.path
        query = parsed.query
        hostname = parsed.hostname or ''
    except Exception:
        return [0.0] * len(FEATURE_NAMES)

    feats = [
        min(len(url), 500),                                      # url_length
        path.count('/'),                                          # path_depth
        len(query.split('&')) if query else 0,                   # query_param_count
        1 if re.search(r'/\d{5,}/', path) else 0,               # has_numeric_id
        hostname.count('.'),                                      # subdomain_depth
        count_ad_keywords(url),                                   # ad_keyword_count
        1 if has_tracker_param(query) else 0,                    # has_tracker_param
        entropy(path),                                            # path_entropy
        entropy(query),                                           # query_entropy
        min(len(hostname), 60),                                   # domain_length
        1 if any(p in hostname for p in CDN_PATTERNS) else 0,   # is_cdn_domain
        tld_type(hostname),                                       # tld_type

        # JS AST approximations (URL-based proxies for training)
        0.0,  # avg_identifier_length — needs source
        0.0,  # short_identifier_ratio
        len(re.findall(r'\[', url)) / max(url.count('.'), 1),   # bracket_dot_ratio
        0.0,  # string_literal_density
        len(re.findall(r'0x[0-9a-fA-F]+', url)),                # hex_literal_count
        0.0,  # max_brace_depth
        1 if 'eval' in url.lower() else 0,                       # eval_usage
        1 if 'fetch' in url.lower() else 0,                      # fetch_count_in_script
        1 if 'beacon' in url.lower() else 0,                     # beacon_count

        # Graph features (simplified — use what's in the row)
        min(row.get('initiator_depth', 0), 10),                  # initiator_depth
        min(row.get('sibling_count', 0), 20),                    # sibling_request_count
        1 if row.get('is_third_party', False) else 0,            # is_third_party
        row.get('timing_zscore', 0.0),                           # request_timing_zscore
        1 if row.get('late_injection', False) else 0,            # late_injection
        1 if rtype in ('script','xmlhttprequest','fetch','image') else 0,  # is_ml_eligible_type
    ]

    return feats


# ─── Synthetic data generation ──────────────────────────────────────────────

def generate_synthetic_data(n=5000) -> pd.DataFrame:
    """
    Generate synthetic labeled data to validate the training pipeline.
    Real training needs actual browsing data — this is just for testing.
    """
    rows = []

    # Ad/tracker URLs (label=1)
    ad_urls = [
        'https://doubleclick.net/ads/banner?gclid=abc123&utm_source=google',
        'https://googlesyndication.com/pagead/js/adsbygoogle.js',
        'https://adnxs.com/ut/v3/prebid?pbjs=1&ad_unit=banner_728x90',
        'https://static.criteo.net/js/ld/publishertag.prebid.js',
        'https://cdn.taboola.com/libtrc/impl.261-1-RELEASE.js',
        'https://ads.pubmatic.com/AdServer/js/pbmonitor.js',
        'https://track.example-analytics.co/collect?v=1&t=pageview&tid=UA-12345',
        'https://pixel.facebook.com/tr?id=12345&ev=PageView&noscript=1',
        'https://s.amazon-adsystem.com/iui3?d=forester-did&ex-fargs=%3Fid',
        'https://b.scorecardresearch.com/p?c1=2&c2=6035668&cv=2.0',
    ]

    # Clean URLs (label=0)
    clean_urls = [
        'https://api.example.com/v2/users/profile',
        'https://fonts.googleapis.com/css2?family=Roboto',
        'https://cdn.jsdelivr.net/npm/react@18/umd/react.production.min.js',
        'https://ajax.googleapis.com/ajax/libs/jquery/3.6.0/jquery.min.js',
        'https://www.example.com/api/search?q=python+tutorial',
        'https://static.example.com/assets/main.bundle.js',
        'https://images.example.com/products/img_001.jpg',
        'https://api.weather.gov/points/40.7128,-74.0060',
        'https://auth.example.com/oauth/token',
        'https://maps.googleapis.com/maps/api/js?key=AIza',
    ]

    rng = np.random.default_rng(42)

    for _ in range(n // 2):
        url = rng.choice(ad_urls)
        row = {
            'url': url,
            'type': rng.choice(['script', 'xmlhttprequest', 'image']),
            'initiator': 'https://example.com/index.html',
            'is_third_party': True,
            'timing_zscore': float(rng.uniform(1.5, 4.0)),
            'sibling_count': int(rng.integers(3, 15)),
            'initiator_depth': int(rng.integers(1, 4)),
            'late_injection': bool(rng.choice([True, False])),
            'label': 1,
        }
        rows.append(row)

    for _ in range(n // 2):
        url = rng.choice(clean_urls)
        row = {
            'url': url,
            'type': rng.choice(['script', 'fetch', 'image', 'main_frame']),
            'initiator': 'https://example.com/index.html',
            'is_third_party': bool(rng.choice([True, False], p=[0.3, 0.7])),
            'timing_zscore': float(rng.uniform(0.0, 1.0)),
            'sibling_count': int(rng.integers(0, 5)),
            'initiator_depth': int(rng.integers(0, 2)),
            'late_injection': False,
            'label': 0,
        }
        rows.append(row)

    return pd.DataFrame(rows)


# ─── Training ────────────────────────────────────────────────────────────────

def train(data_path: str | None, output_path: str, synthetic: bool = False):
    if synthetic or not data_path:
        print("Generating synthetic training data (2000 samples)...")
        df = generate_synthetic_data(2000)
        print(f"Generated {len(df)} samples ({df['label'].sum()} ads, {(df['label']==0).sum()} clean)")
    else:
        print(f"Loading data from {data_path}")
        df = pd.read_csv(data_path)

    # Extract features
    print("Extracting features...")
    X = np.array([extract_features(row) for _, row in df.iterrows()], dtype=np.float32)
    y = df['label'].values

    print(f"Feature matrix shape: {X.shape}")
    print(f"Label distribution: {np.bincount(y)}")

    # Train/test split
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y
    )

    # Model — GBM chosen for interpretability, fast inference, no GPU needed
    model = GradientBoostingClassifier(
        n_estimators=100,
        max_depth=4,
        learning_rate=0.1,
        subsample=0.8,
        max_features='sqrt',
        random_state=42,
        verbose=0,
    )

    print("Training GradientBoostingClassifier...")
    model.fit(X_train, y_train)

    # Evaluation
    y_pred = model.predict(X_test)
    y_prob = model.predict_proba(X_test)[:, 1]

    print("\n=== Evaluation ===")
    print(classification_report(y_test, y_pred, target_names=['clean', 'ad']))
    print(f"ROC-AUC: {roc_auc_score(y_test, y_prob):.4f}")

    # Feature importance
    print("\n=== Feature Importance (top 10) ===")
    importance = sorted(
        zip(FEATURE_NAMES, model.feature_importances_),
        key=lambda x: x[1],
        reverse=True
    )
    for name, imp in importance[:10]:
        bar = '█' * int(imp * 80)
        print(f"  {name:35s} {imp:.4f} {bar}")

    # Export to ONNX
    try:
        from skl2onnx import convert_sklearn
        from skl2onnx.common.data_types import FloatTensorType

        print(f"\nExporting to ONNX: {output_path}")
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)

        n_features = X.shape[1]
        initial_type = [('float_input', FloatTensorType([None, n_features]))]
        onnx_model = convert_sklearn(model, initial_types=initial_type)

        with open(output_path, 'wb') as f:
            f.write(onnx_model.SerializeToString())

        size_kb = len(onnx_model.SerializeToString()) / 1024
        print(f"Exported successfully. Size: {size_kb:.1f} KB")
    except ImportError:
        print("\nskl2onnx not installed. Saving sklearn model instead.")
        joblib.dump(model, output_path.replace('.onnx', '.joblib'))

    # Save feature names for JS alignment check
    meta_path = Path(output_path).parent / 'model_meta.json'
    with open(meta_path, 'w') as f:
        json.dump({
            'feature_names': FEATURE_NAMES,
            'n_features': len(FEATURE_NAMES),
            'model_type': 'gbm',
            'threshold': 0.78,
        }, f, indent=2)
    print(f"Model metadata: {meta_path}")

    return model


# ─── CLI ─────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Train AdFlush GBM classifier')
    parser.add_argument('--data', type=str, default=None, help='Path to CSV training data')
    parser.add_argument('--output', type=str, default='../src/ml/model.onnx')
    parser.add_argument('--synthetic', action='store_true',
                        help='Use synthetic data (for pipeline validation)')
    args = parser.parse_args()

    train(args.data, args.output, args.synthetic)
