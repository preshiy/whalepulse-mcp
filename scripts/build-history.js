// scripts/build-history.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');

const BASE_URL = 'community-api.coinmetrics.io';
const OUTPUT_PATH = path.join(__dirname, '../data/btc-history.json');
const DATA_DIR = path.join(__dirname, '../data');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── HTTPS GET helper ─────────────────────────────────────────
function httpsGet(urlPath) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: BASE_URL,
      path: urlPath,
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Failed to parse response')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Fetch full BTC history ───────────────────────────────────
async function fetchFullHistory() {
  console.log('Fetching BTC historical data from CoinMetrics...');

  const startStr = '2020-01-01';
  const endStr = new Date().toISOString().split('T')[0];
  const urlPath = `/v4/timeseries/asset-metrics?assets=btc&metrics=FlowInExNtv,FlowOutExNtv,PriceUSD,CapMVRVCur&frequency=1d&start_time=${startStr}&end_time=${endStr}&page_size=10000`;

  const json = await httpsGet(urlPath);
  const rows = json.data;
  console.log(`Fetched ${rows.length} days of BTC data`);
  return rows;
}

// ── Classify regime ──────────────────────────────────────────
function classifyRegime(netFlow7d, netFlow30d) {
  const acc7d = netFlow7d > 0;
  const acc30d = netFlow30d > 0;
  const mag = Math.abs(netFlow7d);

  if (acc7d !== acc30d) return 'Neutral';
  if (acc7d && acc30d && mag > 5000) return 'Strong Accumulation';
  if (acc7d && acc30d) return 'Mild Accumulation';
  if (!acc7d && !acc30d && mag > 5000) return 'Strong Distribution';
  if (!acc7d && !acc30d) return 'Mild Distribution';
  return 'Neutral';
}

// ── Classify MVRV ────────────────────────────────────────────
function classifyMVRV(mvrv) {
  if (!mvrv) return 'unknown';
  if (mvrv < 1) return 'undervalued';
  if (mvrv < 2) return 'fair_value';
  if (mvrv < 3.5) return 'overheated';
  return 'extreme_greed';
}

// ── Build precedent database ─────────────────────────────────
async function buildHistory() {
  const rows = await fetchFullHistory();
  const snapshots = [];

  for (let i = 30; i < rows.length; i++) {
    const window7 = rows.slice(i - 7, i);
    const window30 = rows.slice(i - 30, i);
    const current = rows[i];

    const netFlow7d = window7.reduce((sum, r) =>
      sum + (parseFloat(r.FlowOutExNtv || 0) - parseFloat(r.FlowInExNtv || 0)), 0);

    const netFlow30d = window30.reduce((sum, r) =>
      sum + (parseFloat(r.FlowOutExNtv || 0) - parseFloat(r.FlowInExNtv || 0)), 0);

    const priceNow = parseFloat(current.PriceUSD || 0);
    const mvrv = current.CapMVRVCur ? parseFloat(current.CapMVRVCur) : null;

    const row30d = rows[i + 30];
    const row90d = rows[i + 90];
    const priceOutcome30d = row30d ? parseFloat(row30d.PriceUSD || 0) : null;
    const priceOutcome90d = row90d ? parseFloat(row90d.PriceUSD || 0) : null;

    const pctChange30d = priceOutcome30d
      ? parseFloat(((priceOutcome30d - priceNow) / priceNow * 100).toFixed(2))
      : null;
    const pctChange90d = priceOutcome90d
      ? parseFloat(((priceOutcome90d - priceNow) / priceNow * 100).toFixed(2))
      : null;

    snapshots.push({
      date: current.time.split('T')[0],
      netFlow7d: Math.round(netFlow7d),
      netFlow30d: Math.round(netFlow30d),
      priceUSD: Math.round(priceNow),
      mvrv: mvrv ? parseFloat(mvrv.toFixed(3)) : null,
      mvrvZone: classifyMVRV(mvrv),
      regime: classifyRegime(netFlow7d, netFlow30d),
      priceOutcome30d: priceOutcome30d ? Math.round(priceOutcome30d) : null,
      priceOutcome90d: priceOutcome90d ? Math.round(priceOutcome90d) : null,
      pctChange30d,
      pctChange90d
    });
  }

  const complete = snapshots.filter(s => s.pctChange30d !== null && s.pctChange90d !== null);

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(complete, null, 2));
  console.log(`✅ Built ${complete.length} historical snapshots`);
  console.log(`✅ Saved to ${OUTPUT_PATH}`);
}

buildHistory().catch(err => {
  console.error('❌ Failed:', err.message);
  process.exit(1);
});