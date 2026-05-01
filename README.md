# AdBlock ML

**uBO-compatible blocker + AdFlush ML classifier for requests static lists miss.**

## Architecture

```
Request arrives
      │
      ▼
┌─────────────────────────────────┐
│   DNR Static Rules (lists)      │  <1ms, no JS, handles 95%+ of blocks
│   easylist_dnr.json             │
│   easyprivacy_dnr.json          │
└──────────────┬──────────────────┘
               │ Passes through?
               ▼
┌─────────────────────────────────┐
│   Dynamic DNR Cache             │  <1ms, ML-confirmed blocks from prior sessions
│   ML-generated block rules      │
└──────────────┬──────────────────┘
               │ Still passes?
               ▼
┌─────────────────────────────────┐
│   AdFlush ML Classifier         │  <5ms, runs in service worker
│   27 features: URL + graph      │
│   GBM model (ONNX) or heuristic │
└──────────────┬──────────────────┘
               │ Score ≥ 0.78?
               ▼
        Add to Dynamic DNR cache
        (future requests blocked at browser level)
```

## Files

```
adblock-ml/
├── manifest.json
├── src/
│   ├── background/
│   │   ├── service-worker.js     # Core orchestration
│   │   ├── classifier.js         # AdFlush feature extraction + ONNX inference
│   │   ├── request-graph.js      # Per-tab request relationship tracking
│   │   ├── stats.js              # Block statistics
│   │   ├── dynamic-rules.js      # ML-generated DNR rules
│   │   └── list-manager.js       # List lookup for benchmark comparison
│   ├── content/
│   │   └── cosmetic.js           # Element hiding content script
│   └── popup/
│       ├── popup.html
│       ├── popup.css
│       └── popup.js
├── lists/
│   ├── easylist_dnr.json         # Stub — replace with full compiled lists
│   └── easyprivacy_dnr.json
└── scripts/
    ├── train_model.py            # GBM training → ONNX export
    └── benchmark.py              # ML vs list-only comparison
```

## Setup

### 1. Load extension (no build step required)

1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" → select the `adblock-ml/` directory
4. The extension loads immediately with heuristic ML (no trained model yet)

### 2. Replace stub lists with real EasyList

The `lists/` directory currently has minimal stub rules. For real blocking,
compile EasyList into DNR format:

```bash
# Install the filter compiler
npm install -g @gorhill/ubo-core

# Download lists
curl -O https://easylist.to/easylist/easylist.txt
curl -O https://easylist.to/easylist/easyprivacy.txt

# Compile to DNR JSON
# (Note: Chrome limits to 30,000 static rules total across all lists)
# Use uBlock Origin's own build tooling for best results
```

### 3. Train the ML model (optional but recommended)

Without a trained model, the classifier uses a hand-tuned heuristic
that works reasonably well but won't match published AdFlush F1 numbers.

```bash
cd scripts

# Install dependencies
pip install scikit-learn pandas numpy skl2onnx onnx joblib

# Validate the pipeline with synthetic data first
python train_model.py --synthetic --output ../src/ml/model.onnx

# Train on real data (capture requests using the extension's devtools logging)
python train_model.py --data data/captured_requests.csv --output ../src/ml/model.onnx
```

Then add `onnxruntime-web` to the extension:
```bash
npm pack onnxruntime-web
# Copy dist/ort.min.js to adblock-ml/vendor/ort.min.js
```

### 4. Run the benchmark

```bash
cd scripts
python benchmark.py --synthetic   # Test pipeline with synthetic data

# Or with real captured requests:
python benchmark.py --requests data/captured_requests.json
```

## Collecting Training Data

The benchmark popup has a "Run benchmark" button that compares ML vs list
decisions on recently observed requests. To collect labeled training data:

1. Browse normally for 20-30 minutes
2. Open DevTools → Network tab, filter by blocked requests
3. Export request URLs with labels (ad=1, clean=0)
4. Feed to `train_model.py`

## ML Classifier Details

**Features (27 total):**

| Group | Count | Key features |
|-------|-------|-------------|
| URL structural | 12 | Path depth, query entropy, ad keyword count, tracker params |
| JS AST approx | 9 | Identifier length, bracket/dot ratio, hex literals, eval usage |
| Request graph | 6 | Initiator depth, sibling count, 3rd-party, timing z-score |

**Model:** GradientBoostingClassifier (100 trees, depth 4)
- Target inference: <5ms including feature extraction
- Export: ONNX via skl2onnx for browser inference
- Fallback: hand-tuned heuristic if model not present

**Threshold:** 0.78 (conservative — prefer precision over recall to avoid breakage)

## Phase Roadmap

### Phase 1 — Current
- [x] DNR static rules (list-based blocking)
- [x] AdFlush ML classifier with 27 features
- [x] Dynamic DNR rule caching for ML-confirmed blocks
- [x] Request graph state tracking
- [x] Per-tab statistics and popup UI
- [x] Benchmark comparison vs list-only
- [ ] Full EasyList DNR compilation
- [ ] Trained ONNX model (needs labeled data)

### Phase 2 — Filter Generation Pipeline (Month 3-4)
- Backend LLM pipeline for automated filter rule generation
- Playwright test runner for rule validation
- Faster update loop for emerging ad patterns

### Phase 3 — Behavioral & Perceptual (Month 5-6)
- Anti-adblock detection (bait element monitoring)
- Lightweight CNN for cosmetic ML (native ad detection)
- Isolation Forest for script anomaly detection

## Known Limitations

- **YouTube SSAI**: Server-side ad injection is not addressable with network filtering.
  Rely on SponsorBlock-style timestamp databases for skip functionality.
- **MV3 blocking constraint**: Chrome MV3 doesn't allow blocking requests from JS
  in real-time. ML decisions add DNR rules for *future* requests. First-time
  requests to ML-detected ad domains are not blocked until the rule is cached.
- **Trained model**: The heuristic fallback is a reasonable approximation,
  but published AdFlush F1=0.975 requires training on real labeled request data.

## License

MIT
