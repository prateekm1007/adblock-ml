const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const metrics = require('./metrics');

const EXTENSION_PATH = path.resolve(__dirname, '..');
const SITES_PATH = path.join(__dirname, 'sites.json');
const RESULTS_DIR = path.join(__dirname, 'results');

const sites = JSON.parse(fs.readFileSync(SITES_PATH, 'utf8'));

async function measureSite(url, useExtension = false) {
  const result = {
    url,
    useExtension,
    totalRequests: 0,
    blockedRequests: 0,
    totalTrackers: 0,
    blockedTrackers: 0,
    jsErrors: 0,
    domNodes: 0,
    failedRequests: 0,
    loadTime: 0
  };

  let browser;

  if (useExtension) {
    browser = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-sandbox',
        '--disable-setuid-sandbox'
      ]
    });
  } else {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
  }

  const page = useExtension
    ? await browser.newPage()
    : await (await browser.newContext()).newPage();

  page.on('request', request => {
    const reqUrl = request.url();
    result.totalRequests++;
    if (metrics.isTracker(reqUrl)) {
      result.totalTrackers++;
    }
  });

  page.on('requestfailed', request => {
    result.failedRequests++;
    const reqUrl = request.url();
    if (metrics.isTracker(reqUrl)) {
      result.blockedTrackers++;
    }
  });

  page.on('response', response => {
    const status = response.status();
    const reqUrl = response.url();
    if (status === 0) {
      result.blockedRequests++;
      if (metrics.isTracker(reqUrl)) {
        result.blockedTrackers++;
      }
    }
  });

  page.on('pageerror', () => { result.jsErrors++; });
  page.on('console', msg => {
    if (msg.type() === 'error') result.jsErrors++;
  });

  try {
    const startTime = Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    result.loadTime = Date.now() - startTime;
    result.domNodes = await page.evaluate(() => document.querySelectorAll('*').length);
  } catch (error) {
    console.error(`    Error loading ${url}: ${error.message.split('\n')[0]}`);
    result.error = error.message;
  }

  await browser.close();
  return result;
}

async function runBenchmark() {
  console.log('AdBlockML Benchmark Runner\n');

  if (!fs.existsSync(RESULTS_DIR)) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
  }

  const results = {
    timestamp: new Date().toISOString(),
    categories: {},
    summary: {
      block_rate: 0,
      tracker_block_rate: 0,
      breakage_score: 0,
      ml_contribution: 0
    }
  };

  for (const [category, urls] of Object.entries(sites.categories)) {
    console.log(`\n[${category}]`);
    results.categories[category] = [];

    for (const url of urls) {
      console.log(`  Testing ${url}...`);
      console.log('    - Baseline...');
      const baseline = await measureSite(url, false);
      console.log('    - With extension...');
      const withExt = await measureSite(url, true);

      const siteMetrics = {
        url,
        block_rate:         metrics.calculateBlockRate(baseline, withExt),
        tracker_block_rate: metrics.calculateTrackerBlockRate(baseline, withExt),
        breakage_score:     metrics.calculateBreakageScore(baseline, withExt),
        baseline,
        withExtension: withExt
      };

      results.categories[category].push(siteMetrics);

      console.log(`      total_requests (baseline):  ${baseline.totalRequests}`);
      console.log(`      total_requests (extension): ${withExt.totalRequests}`);
      console.log(`      blocked_requests:           ${withExt.blockedRequests}`);
      console.log(`      total_trackers (baseline):  ${baseline.totalTrackers}`);
      console.log(`      blocked_trackers:           ${withExt.blockedTrackers}`);
      console.log(`      block_rate:                 ${(siteMetrics.block_rate * 100).toFixed(1)}%`);
      console.log(`      tracker_block_rate:         ${(siteMetrics.tracker_block_rate * 100).toFixed(1)}%`);
      console.log(`      breakage_score:             ${siteMetrics.breakage_score.toFixed(3)}`);
    }
  }

  let totalBlockRate = 0, totalTrackerBlockRate = 0, totalBreakageScore = 0, siteCount = 0;

  for (const category of Object.values(results.categories)) {
    for (const site of category) {
      totalBlockRate         += site.block_rate;
      totalTrackerBlockRate  += site.tracker_block_rate;
      totalBreakageScore     += site.breakage_score;
      siteCount++;
    }
  }

  results.summary.block_rate         = totalBlockRate / siteCount;
  results.summary.tracker_block_rate = totalTrackerBlockRate / siteCount;
  results.summary.breakage_score     = totalBreakageScore / siteCount;
  results.summary.ml_contribution    = 0;

  const thresholdCheck = metrics.checkThresholds(results.summary);
  results.thresholdCheck = thresholdCheck;

  const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
  const resultsPath = path.join(RESULTS_DIR, `results_${timestamp}.json`);
  fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));

  console.log(`\n${'='.repeat(70)}`);
  console.log('BENCHMARK SUMMARY');
  console.log('='.repeat(70));
  console.log(`block_rate:         ${(results.summary.block_rate * 100).toFixed(1)}%`);
  console.log(`tracker_block_rate: ${(results.summary.tracker_block_rate * 100).toFixed(1)}%`);
  console.log(`breakage_score:     ${results.summary.breakage_score.toFixed(3)}`);
  console.log(`ml_contribution:    ${(results.summary.ml_contribution * 100).toFixed(1)}%`);
  console.log(`\nResults saved to: ${resultsPath}`);

  if (thresholdCheck.pass) {
    console.log('\n✅ ALL THRESHOLDS PASSED');
  } else {
    console.log('\n❌ THRESHOLD FAILURES:');
    thresholdCheck.failures.forEach(f => console.log(`  - ${f}`));
  }

  process.exit(thresholdCheck.pass ? 0 : 1);
}

runBenchmark().catch(error => {
  console.error('Benchmark failed:', error);
  process.exit(1);
});