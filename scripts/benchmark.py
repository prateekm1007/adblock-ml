"""
Benchmark: AdBlock ML vs vanilla list-based blocking
=====================================================
Replays a set of captured requests through both approaches and reports:
  - Block rate comparison
  - ML-only catches (what lists missed)
  - False positive rate estimate
  - Latency overhead

Usage:
  python benchmark.py --requests data/captured_requests.json
  python benchmark.py --synthetic  # Test with synthetic data
"""

import json
import time
import argparse
import math
import re
from urllib.parse import urlparse


# ─── Minimal feature extractor (mirrors train_model.py) ────────────────────

AD_KEYWORDS = {
    'ad', 'ads', 'advert', 'banner', 'sponsor', 'tracking', 'analytics',
    'pixel', 'beacon', 'doubleclick', 'adsystem', 'adserver', 'pagead',
    'adunit', 'prebid', 'adsense', 'criteo', 'taboola', 'outbrain',
}

KNOWN_AD_DOMAINS = {
    'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
    'googletagmanager.com', 'google-analytics.com', 'adnxs.com',
    'criteo.com', 'criteo.net', 'taboola.com', 'outbrain.com',
    'pubmatic.com', 'rubiconproject.com', 'openx.net', 'openx.com',
    'scorecardresearch.com', 'quantserve.com', 'amazon-adsystem.com',
    'facebook.net', 'connect.facebook.net', 'moatads.com',
    'advertising.com', 'bidswitch.net', 'casalemedia.com',
    'indexexchange.com', 'sharethrough.com', 'triplelift.com',
}


def entropy(s):
    if not s or len(s) < 2:
        return 0.0
    freq = {}
    for c in s:
        freq[c] = freq.get(c, 0) + 1
    n = len(s)
    return -sum((v/n) * math.log2(v/n) for v in freq.values())


def list_would_block(url):
    """Simulate static list-based blocking."""
    try:
        parsed = urlparse(url)
        hostname = parsed.hostname or ''
        base = '.'.join(hostname.split('.')[-2:])

        if hostname in KNOWN_AD_DOMAINS or base in KNOWN_AD_DOMAINS:
            return True
        if re.search(r'/(ad|ads|advert|banner)/', url, re.I):
            return True
        if 'pagead' in url.lower():
            return True
        return False
    except Exception:
        return False


def heuristic_ml_score(url, is_third_party=False):
    """Simplified heuristic score (mirrors classifier.js _heuristicScore)."""
    score = 0
    url_lower = url.lower()

    # Known ad domains - strong signal
    try:
        hostname = urlparse(url).hostname or ''
        base = '.'.join(hostname.split('.')[-2:])
        if hostname in KNOWN_AD_DOMAINS or base in KNOWN_AD_DOMAINS:
            score += 0.55
    except Exception:
        pass

    kw_count = sum(1 for kw in AD_KEYWORDS if kw in url_lower)
    if kw_count >= 2:
        score += 0.35
    elif kw_count >= 1:
        score += 0.20

    try:
        parsed = urlparse(url)
        path_ent = entropy(parsed.path)
        query_ent = entropy(parsed.query)
    except Exception:
        path_ent = query_ent = 0

    if is_third_party:
        score += 0.10
    if path_ent > 3.5:
        score += 0.10
    if query_ent > 4.0:
        score += 0.10
    if re.search(r'/ads?/', url, re.I):
        score += 0.25
    if re.search(r'tracking|analytics|beacon|pixel|sponsor|prebid', url_lower):
        score += 0.20
    if re.search(r'utm_source|fbclid|gclid', url_lower):
        score += 0.15
    if len(re.findall(r'0x[0-9a-fA-F]+', url)) > 2:
        score += 0.10

    return min(1.0, score)


# ─── Synthetic test data ────────────────────────────────────────────────────

SYNTHETIC_REQUESTS = [
    # Should be blocked by lists
    {'url': 'https://doubleclick.net/ads/banner', 'label': 1, 'category': 'list_known'},
    {'url': 'https://googlesyndication.com/pagead/js/adsbygoogle.js', 'label': 1, 'category': 'list_known'},
    {'url': 'https://adnxs.com/ut/v3?pbjs=1', 'label': 1, 'category': 'list_known'},
    {'url': 'https://criteo.com/js/ld/publishertag.js', 'label': 1, 'category': 'list_known'},
    {'url': 'https://b.scorecardresearch.com/p?c1=2&c2=1234', 'label': 1, 'category': 'list_known'},

    # ML should catch these (lists miss them)
    {'url': 'https://news-analytics-xyz.com/tracking/pixel.gif?utm_source=organic', 'label': 1, 'category': 'ml_target'},
    {'url': 'https://cdn.firstpartyadvertising.co/banner_slot.js', 'label': 1, 'category': 'ml_target'},
    {'url': 'https://example.com/ad-insert?fbclid=abc&utm_campaign=retarget', 'label': 1, 'category': 'ml_target'},
    {'url': 'https://analytics-beacon-api.io/collect?v=1&tid=GA-99999', 'label': 1, 'category': 'ml_target'},
    {'url': 'https://sponsor-content.cdn.example.net/prebid_loader.js', 'label': 1, 'category': 'ml_target'},

    # Should NOT be blocked
    {'url': 'https://api.example.com/v2/products', 'label': 0, 'category': 'clean'},
    {'url': 'https://fonts.googleapis.com/css2?family=Roboto', 'label': 0, 'category': 'clean'},
    {'url': 'https://cdn.jsdelivr.net/npm/react@18/react.min.js', 'label': 0, 'category': 'clean'},
    {'url': 'https://example.com/api/search?q=laptop', 'label': 0, 'category': 'clean'},
    {'url': 'https://static.example.com/app.bundle.js', 'label': 0, 'category': 'clean'},
    {'url': 'https://maps.googleapis.com/maps/api/js', 'label': 0, 'category': 'clean'},
    {'url': 'https://images.example.com/product/001.jpg', 'label': 0, 'category': 'clean'},
    {'url': 'https://auth.example.com/oauth/token', 'label': 0, 'category': 'clean'},
]

ML_THRESHOLD = 0.78


def run_benchmark(requests):
    results = {
        'total': len(requests),
        'labeled_ads': sum(1 for r in requests if r.get('label') == 1),
        'labeled_clean': sum(1 for r in requests if r.get('label') == 0),

        # List-based metrics
        'list_tp': 0,   # Correctly blocked ads
        'list_fp': 0,   # Incorrectly blocked clean
        'list_fn': 0,   # Missed ads

        # ML metrics
        'ml_tp': 0,
        'ml_fp': 0,
        'ml_fn': 0,

        # ML-only catches
        'ml_only': 0,   # ML caught, list missed

        # Latency
        'list_ms_total': 0.0,
        'ml_ms_total': 0.0,

        'per_request': [],
    }

    for req in requests:
        url = req['url']
        label = req.get('label', -1)  # -1 = unlabeled

        # List decision
        t0 = time.perf_counter()
        list_block = list_would_block(url)
        list_ms = (time.perf_counter() - t0) * 1000
        results['list_ms_total'] += list_ms

        # ML decision
        t0 = time.perf_counter()
        ml_score = heuristic_ml_score(url, req.get('is_third_party', False))
        ml_block = ml_score >= ML_THRESHOLD
        ml_ms = (time.perf_counter() - t0) * 1000
        results['ml_ms_total'] += ml_ms

        # Tally if labeled
        if label == 1:
            if list_block: results['list_tp'] += 1
            else: results['list_fn'] += 1
            if ml_block: results['ml_tp'] += 1
            else: results['ml_fn'] += 1
            if ml_block and not list_block:
                results['ml_only'] += 1
        elif label == 0:
            if list_block: results['list_fp'] += 1
            if ml_block: results['ml_fp'] += 1

        results['per_request'].append({
            'url': url[:80],
            'label': label,
            'list_block': list_block,
            'ml_score': round(ml_score, 3),
            'ml_block': ml_block,
            'category': req.get('category', ''),
        })

    return results


def print_report(r):
    labeled_ads = r['labeled_ads']
    labeled_clean = r['labeled_clean']

    def f1(tp, fp, fn):
        if tp + fp == 0 or tp + fn == 0:
            return 0.0
        prec = tp / (tp + fp)
        rec = tp / (tp + fn)
        return 2 * prec * rec / (prec + rec) if prec + rec > 0 else 0.0

    list_f1 = f1(r['list_tp'], r['list_fp'], r['list_fn'])
    ml_f1   = f1(r['ml_tp'],   r['ml_fp'],   r['ml_fn'])

    avg_list_ms = r['list_ms_total'] / max(r['total'], 1)
    avg_ml_ms   = r['ml_ms_total']   / max(r['total'], 1)

    print("\n" + "="*60)
    print(" ADBLOCK ML — BENCHMARK REPORT")
    print("="*60)
    print(f" Total requests:     {r['total']}")
    print(f" Labeled ads:        {labeled_ads}")
    print(f" Labeled clean:      {labeled_clean}")
    print()
    print(f"{'Metric':<28} {'Lists':>10} {'ML':>10}")
    print("-"*50)

    if labeled_ads:
        list_rec = r['list_tp'] / labeled_ads * 100 if labeled_ads else 0
        ml_rec   = r['ml_tp']   / labeled_ads * 100 if labeled_ads else 0
        print(f"{'Ad recall':<28} {list_rec:>9.1f}% {ml_rec:>9.1f}%")

    if labeled_clean:
        list_fpr = r['list_fp'] / labeled_clean * 100 if labeled_clean else 0
        ml_fpr   = r['ml_fp']   / labeled_clean * 100 if labeled_clean else 0
        print(f"{'False positive rate':<28} {list_fpr:>9.1f}% {ml_fpr:>9.1f}%")

    if labeled_ads or labeled_clean:
        print(f"{'F1 score':<28} {list_f1:>10.3f} {ml_f1:>10.3f}")

    print(f"{'Avg latency (ms)':<28} {avg_list_ms:>10.3f} {avg_ml_ms:>10.3f}")
    print()
    print(f" ML-only catches (lists missed): {r['ml_only']}")
    if labeled_ads:
        pct = r['ml_only'] / labeled_ads * 100
        print(f" Improvement over lists:         +{pct:.1f}% recall")

    print()
    print(" Per-request breakdown:")
    print(f"  {'URL':<45} {'Label':>5} {'List':>5} {'ML':>6} {'Catch':>8}")
    print("  " + "-"*75)
    for req in r['per_request']:
        ml_only = "★ ML" if req['ml_block'] and not req['list_block'] else ""
        list_sym = "✗" if req['list_block'] else " "
        ml_sym   = f"{req['ml_score']:.2f}"
        label_sym = {1: "AD", 0: "OK", -1: "??"}.get(req['label'], "??")
        print(f"  {req['url']:<45} {label_sym:>5} {list_sym:>5} {ml_sym:>6} {ml_only:>8}")

    print("="*60)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--requests', type=str, default=None)
    parser.add_argument('--synthetic', action='store_true')
    args = parser.parse_args()

    if args.requests:
        with open(args.requests) as f:
            requests = json.load(f)
    else:
        print("No --requests file provided. Running on synthetic test data.\n")
        requests = SYNTHETIC_REQUESTS

    results = run_benchmark(requests)
    print_report(results)
