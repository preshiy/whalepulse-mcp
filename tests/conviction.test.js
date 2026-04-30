// tests/conviction.test.js
// Tests for conviction scorer and cohort signal logic

const assert = require('assert');

function scoreConviction(m, divergence) {
  let score = 50;

  const mag = Math.abs(m.netFlow7d);
  if (mag > 20000) score += 25;
  else if (mag > 10000) score += 15;
  else if (mag > 5000) score += 10;
  else if (mag > 1000) score += 5;

  const sameDir = (m.netFlow7d > 0) === (m.netFlow30d > 0);
  if (sameDir) score += 15;

  if (Math.abs(m.netFlow7d) > Math.abs(m.prevNetFlow7d) && sameDir) score += 10;

  if (m.addrChange7d > 5) score += 10;
  else if (m.addrChange7d > 0) score += 5;
  else score -= 5;

  if (m.mvrvZone === 'undervalued') score += 10;
  else if (m.mvrvZone === 'fair_value') score += 5;
  else if (m.mvrvZone === 'overheated') score -= 5;
  else if (m.mvrvZone === 'extreme_greed') score -= 15;

  if (m.cohortSignal === 'strong_accumulation') score += 15;
  else if (m.cohortSignal === 'mild_accumulation') score += 8;
  else if (m.cohortSignal === 'mild_distribution') score -= 8;
  else if (m.cohortSignal === 'strong_distribution') score -= 15;

  if (Math.abs(m.netWhaleDelta) > 20000) score += 10;
  else if (Math.abs(m.netWhaleDelta) > 10000) score += 5;

  if (divergence.detected && divergence.severity === 'strong') score -= 15;
  else if (divergence.detected && divergence.severity === 'mild') score -= 7;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function noDivergence() {
  return { detected: false, type: 'none', severity: 'none' };
}

function strongDivergence() {
  return { detected: true, type: 'bearish', severity: 'strong' };
}

function mildDivergence() {
  return { detected: true, type: 'bearish', severity: 'mild' };
}

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

console.log('\n── Conviction Scorer Tests ──────────────────────────────');

test('Score stays within 0-100 range always', () => {
  const m = {
    netFlow7d: 999999, netFlow30d: 999999, prevNetFlow7d: 0,
    addrChange7d: 50, mvrvZone: 'undervalued',
    cohortSignal: 'strong_accumulation', netWhaleDelta: 999999
  };
  const score = scoreConviction(m, noDivergence());
  assert.ok(score >= 0 && score <= 100, `Score ${score} out of range`);
});

test('Score never goes below 0 under worst conditions', () => {
  const m = {
    netFlow7d: -999999, netFlow30d: -999999, prevNetFlow7d: 0,
    addrChange7d: -50, mvrvZone: 'extreme_greed',
    cohortSignal: 'strong_distribution', netWhaleDelta: -999999
  };
  const score = scoreConviction(m, strongDivergence());
  assert.ok(score >= 0, `Score ${score} went below 0`);
});

test('Strong accumulation conditions produce score above 70', () => {
  const m = {
    netFlow7d: 25000, netFlow30d: 20000, prevNetFlow7d: 15000,
    addrChange7d: 8, mvrvZone: 'undervalued',
    cohortSignal: 'strong_accumulation', netWhaleDelta: 25000
  };
  const score = scoreConviction(m, noDivergence());
  assert.ok(score > 70, `Expected score > 70, got ${score}`);
});

test('Strong distribution conditions score lower than strong accumulation', () => {
  const accumulation = {
    netFlow7d: 25000, netFlow30d: 20000, prevNetFlow7d: 15000,
    addrChange7d: 8, mvrvZone: 'undervalued',
    cohortSignal: 'strong_accumulation', netWhaleDelta: 25000
  };
  const distribution = {
    netFlow7d: -25000, netFlow30d: -20000, prevNetFlow7d: -15000,
    addrChange7d: -5, mvrvZone: 'extreme_greed',
    cohortSignal: 'strong_distribution', netWhaleDelta: -25000
  };
  const accScore = scoreConviction(accumulation, noDivergence());
  const distScore = scoreConviction(distribution, noDivergence());
  assert.ok(accScore > distScore, `Accumulation score ${accScore} should exceed distribution score ${distScore}`);
});

test('Strong divergence penalty applied when detected', () => {
  const m = {
    netFlow7d: 10000, netFlow30d: 8000, prevNetFlow7d: 5000,
    addrChange7d: 3, mvrvZone: 'fair_value',
    cohortSignal: 'mild_accumulation', netWhaleDelta: 5000
  };
  const scoreClean = scoreConviction(m, noDivergence());
  const scoreDiverged = scoreConviction(m, strongDivergence());
  assert.ok(scoreClean > scoreDiverged, 'Strong divergence should reduce score');
});

test('Mild divergence reduces score less than strong divergence', () => {
  const m = {
    netFlow7d: 10000, netFlow30d: 8000, prevNetFlow7d: 5000,
    addrChange7d: 3, mvrvZone: 'fair_value',
    cohortSignal: 'mild_accumulation', netWhaleDelta: 5000
  };
  const scoreStrong = scoreConviction(m, strongDivergence());
  const scoreMild = scoreConviction(m, mildDivergence());
  assert.ok(scoreMild > scoreStrong, 'Mild divergence should penalize less than strong');
});

test('MVRV undervalued adds 10 points vs unknown', () => {
  const base = {
    netFlow7d: 5000, netFlow30d: 5000, prevNetFlow7d: 3000,
    addrChange7d: 0, cohortSignal: 'mild_accumulation', netWhaleDelta: 3000
  };
  const scoreUnknown = scoreConviction({ ...base, mvrvZone: 'unknown' }, noDivergence());
  const scoreUndervalued = scoreConviction({ ...base, mvrvZone: 'undervalued' }, noDivergence());
  assert.strictEqual(scoreUndervalued - scoreUnknown, 10);
});

test('MVRV extreme_greed subtracts 15 points vs unknown', () => {
  const base = {
    netFlow7d: 5000, netFlow30d: 5000, prevNetFlow7d: 3000,
    addrChange7d: 0, cohortSignal: 'mild_accumulation', netWhaleDelta: 3000
  };
  const scoreUnknown = scoreConviction({ ...base, mvrvZone: 'unknown' }, noDivergence());
  const scoreGreed = scoreConviction({ ...base, mvrvZone: 'extreme_greed' }, noDivergence());
  assert.strictEqual(scoreUnknown - scoreGreed, 15);
});

test('Whale delta > 20000 scores higher than delta < 10000', () => {
  const base = {
    netFlow7d: 5000, netFlow30d: 5000, prevNetFlow7d: 3000,
    addrChange7d: 0, mvrvZone: 'fair_value', cohortSignal: 'mild_accumulation'
  };
  const scoreSmall = scoreConviction({ ...base, netWhaleDelta: 5000 }, noDivergence());
  const scoreLarge = scoreConviction({ ...base, netWhaleDelta: 25000 }, noDivergence());
  assert.ok(scoreLarge > scoreSmall, 'Larger whale delta should produce higher score');
});

console.log('\n── Cohort Signal Logic Tests ────────────────────────────');

function cohortSignal(netWhaleDelta) {
  if (netWhaleDelta > 5000) return 'strong_accumulation';
  if (netWhaleDelta > 0) return 'mild_accumulation';
  if (netWhaleDelta < -5000) return 'strong_distribution';
  return 'mild_distribution';
}

test('Net whale delta > 5000 = strong_accumulation', () => {
  assert.strictEqual(cohortSignal(10000), 'strong_accumulation');
});

test('Net whale delta 1 to 5000 = mild_accumulation', () => {
  assert.strictEqual(cohortSignal(3000), 'mild_accumulation');
});

test('Net whale delta < -5000 = strong_distribution', () => {
  assert.strictEqual(cohortSignal(-10000), 'strong_distribution');
});

test('Net whale delta -5000 to 0 = mild_distribution', () => {
  assert.strictEqual(cohortSignal(-3000), 'mild_distribution');
});

console.log('\n─────────────────────────────────────────────────────────');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);