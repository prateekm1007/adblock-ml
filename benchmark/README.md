# AdBlockML Benchmark

Automated validation harness.

## Install

cd benchmark
npm install

## Run

npm test

## Metrics

- block_rate
- tracker_block_rate
- breakage_score
- ml_contribution

## Thresholds

- tracker_block_rate >= 10%
- breakage_score <= 0.05
- ml_contribution >= 5%

Results in results/ directory.