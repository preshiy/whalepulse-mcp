// tests/regime.test.js
// Tests for regime classifier and divergence detector

const assert = require('assert');

// ── Copy core logic for isolated testing ─────────────────────

function classifyMVRV(mvrv) {
  if (mvrv === null) return 'unknown';
  if (mvrv < 1) return 'undervalued';
  if (mvrv < 2) return 'fair_value';
  if (mvrv < 3.5) return 'overheated';
  return 'extreme_greed';
}

function classifyRegime(netFlow7d, netFlow30d, cohortSignal) {
  const acc7d = netFlow7d > 0;
  const acc30d = netFlow30d > 0;
  const mag = Math.abs(netFlow7d);
  const whaleAcc = cohortSignal === 'strong_accumulation' || cohortSignal === 'mild_accumulation';

  if (acc7d && acc30d && whaleAcc && mag > 5000) return 'Strong Accumulation';
  if (acc7d && acc30d && mag > 5000) return 'Accumulation';
  if (acc7d && acc30d) return 'Mild Accumulation';
  if (!acc7d && !acc30d && !whaleAcc && mag > 5000) return 'Strong Distribution';
  if (!acc7d && !acc30d && mag > 5000) return 'Distribution';
  if (!acc7d && !acc30d) return 'Mild Distribution';
  return 'Neutral';
}

function detectDivergence(netFlow7d, priceChange7d) {
  const flowAcc = netFlow7d > 0;
  const priceUp = priceChange7d > 0;

  if (priceUp && !flowAcc) {
    const severity = Math.abs(priceChange7d) > 5 ? 'strong' : 'mild';
    return { detected: true, type: 'bearish', severity, note: 'Price rising but BTC leaving exchanges — potential distribution into strength' };
  }
  if (!priceUp && flowAcc) {
    const severity = Math.abs(priceChange7d) > 5 ? 'strong' : 'mild';
    return { detected: true, type: 'bullish', severity, note: 'Price falling but BTC being withdrawn from exchanges — potential accumulation on weakness' };
  }
  return { detected: false, type: 'none', severity: 'none', note: 'Flow direction aligns with price action' };
}

// ── Tests ─────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ FAIL: ${name}`);
    console.log(`     ${err.message}`);
    failed++;
  }
}

console.log('\n── Regime Classifier Tests ──────────────────────────────');

test('Strong Accumulation when flows positive, whale accumulating, magnitude > 5000', () => {
  assert.strictEqual(classifyRegime(10000, 8000, 'strong_accumulation'), 'Strong Accumulation');
});

test('Accumulation when flows positive, magnitude > 5000, whale distributing', () => {
  assert.strictEqual(classifyRegime(10000, 8000, 'strong_distribution'), 'Accumulation');
});

test('Mild Accumulation when flows positive but magnitude low', () => {
  assert.strictEqual(classifyRegime(1000, 500, 'mild_accumulation'), 'Mild Accumulation');
});

test('Strong Distribution when flows negative, whale distributing, magnitude > 5000', () => {
  assert.strictEqual(classifyRegime(-10000, -8000, 'strong_distribution'), 'Strong Distribution');
});

test('Distribution when flows negative, magnitude > 5000, whale accumulating', () => {
  assert.strictEqual(classifyRegime(-10000, -8000, 'strong_accumulation'), 'Distribution');
});

test('Mild Distribution when flows negative, magnitude low', () => {
  assert.strictEqual(classifyRegime(-1000, -500, 'mild_distribution'), 'Mild Distribution');
});

test('Neutral when 7d and 30d flows conflict', () => {
  assert.strictEqual(classifyRegime(5000, -3000, 'mild_accumulation'), 'Neutral');
});

console.log('\n── MVRV Zone Classifier Tests ───────────────────────────');

test('MVRV null returns unknown', () => {
  assert.strictEqual(classifyMVRV(null), 'unknown');
});

test('MVRV below 1 returns undervalued', () => {
  assert.strictEqual(classifyMVRV(0.85), 'undervalued');
});

test('MVRV 1 to 2 returns fair_value', () => {
  assert.strictEqual(classifyMVRV(1.5), 'fair_value');
});

test('MVRV 2 to 3.5 returns overheated', () => {
  assert.strictEqual(classifyMVRV(2.8), 'overheated');
});

test('MVRV above 3.5 returns extreme_greed', () => {
  assert.strictEqual(classifyMVRV(4.1), 'extreme_greed');
});

console.log('\n── Divergence Detector Tests ────────────────────────────');

test('Bearish strong divergence when price up > 5% and flow negative', () => {
  const result = detectDivergence(-8000, 7.5);
  assert.strictEqual(result.detected, true);
  assert.strictEqual(result.type, 'bearish');
  assert.strictEqual(result.severity, 'strong');
});

test('Bearish mild divergence when price up < 5% and flow negative', () => {
  const result = detectDivergence(-3000, 3.0);
  assert.strictEqual(result.detected, true);
  assert.strictEqual(result.type, 'bearish');
  assert.strictEqual(result.severity, 'mild');
});

test('Bullish strong divergence when price down > 5% and flow positive', () => {
  const result = detectDivergence(8000, -6.0);
  assert.strictEqual(result.detected, true);
  assert.strictEqual(result.type, 'bullish');
  assert.strictEqual(result.severity, 'strong');
});

test('Bullish mild divergence when price down < 5% and flow positive', () => {
  const result = detectDivergence(3000, -2.0);
  assert.strictEqual(result.detected, true);
  assert.strictEqual(result.type, 'bullish');
  assert.strictEqual(result.severity, 'mild');
});

test('No divergence when price and flow both positive', () => {
  const result = detectDivergence(8000, 5.0);
  assert.strictEqual(result.detected, false);
  assert.strictEqual(result.type, 'none');
});

test('No divergence when price and flow both negative', () => {
  const result = detectDivergence(-8000, -5.0);
  assert.strictEqual(result.detected, false);
  assert.strictEqual(result.type, 'none');
});

console.log('\n─────────────────────────────────────────────────────────');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);