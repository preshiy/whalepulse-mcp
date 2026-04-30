require('dotenv').config();
const fetch = require('node-fetch');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const BASE_URL = process.env.COINMETRICS_API_BASE;
const BITCOIN_DATA_TOKEN = process.env.BITCOIN_DATA_TOKEN;
const CACHE_DURATION_MS = 4 * 60 * 60 * 1000;

let cache = { data: null, timestamp: null };

// ── Fetch Whale Cohorts from bitcoin-data.com ────────────────
async function fetchWhaleCohorts() {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 8);
  const startday = start.toISOString().split('T')[0];
  const endday = end.toISOString().split('T')[0];

  const [res1k10k, res10k] = await Promise.all([
    fetch(`https://api.bitcoin-data.com/v1/coins-addr-10K-1K-BTC?startday=${startday}&endday=${endday}&token=${BITCOIN_DATA_TOKEN}`),
    fetch(`https://api.bitcoin-data.com/v1/coins-addr-10K-BTC?startday=${startday}&endday=${endday}&token=${BITCOIN_DATA_TOKEN}`)
  ]);

  if (!res1k10k.ok || !res10k.ok) throw new Error('bitcoin-data.com API error');

  const data1k10k = await res1k10k.json();
  const data10k = await res10k.json();

  if (!Array.isArray(data1k10k) || !Array.isArray(data10k) || data1k10k.length < 2 || data10k.length < 2) {
    throw new Error('Insufficient whale cohort data');
  }

  const cohort1k10k_now = parseFloat(data1k10k[data1k10k.length - 1].coinsAddr10Kto1Kbtc);
  const cohort1k10k_7d = parseFloat(data1k10k[0].coinsAddr10Kto1Kbtc);
  const cohort10k_now = parseFloat(data10k[data10k.length - 1].coinsAddr10Kbtc);
  const cohort10k_7d = parseFloat(data10k[0].coinsAddr10Kbtc);

  const delta1k10k = Math.round(cohort1k10k_now - cohort1k10k_7d);
  const delta10k = Math.round(cohort10k_now - cohort10k_7d);
  const netWhaleDelta = delta1k10k + delta10k;

  let cohortSignal;
  if (netWhaleDelta > 5000) cohortSignal = 'strong_accumulation';
  else if (netWhaleDelta > 0) cohortSignal = 'mild_accumulation';
  else if (netWhaleDelta < -5000) cohortSignal = 'strong_distribution';
  else cohortSignal = 'mild_distribution';

  return {
    cohort1k10k_now: Math.round(cohort1k10k_now),
    cohort10k_now: Math.round(cohort10k_now),
    delta1k10k,
    delta10k,
    netWhaleDelta,
    cohortSignal,
    totalWhaleHoldings: Math.round(cohort1k10k_now + cohort10k_now)
  };
}

// ── Fetch BTC Metrics from CoinMetrics ───────────────────────
async function fetchAllMetrics() {
  const now = Date.now();
  if (cache.data && cache.timestamp && (now - cache.timestamp) < CACHE_DURATION_MS) {
    return { ...cache.data, from_cache: true };
  }

  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 35);
  const startStr = start.toISOString().split('T')[0];
  const endStr = end.toISOString().split('T')[0];

  const url = `${BASE_URL}/timeseries/asset-metrics?assets=btc&metrics=FlowInExNtv,FlowOutExNtv,PriceUSD,AdrActCnt,CapMVRVCur&frequency=1d&start_time=${startStr}&end_time=${endStr}`;

  const [cmResponse, whaleData] = await Promise.all([
    fetch(url),
    fetchWhaleCohorts()
  ]);

  if (!cmResponse.ok) throw new Error(`CoinMetrics API error: ${cmResponse.status}`);

  const json = await cmResponse.json();
  const rows = json.data;
  if (!rows || rows.length < 14) throw new Error('Insufficient data from CoinMetrics');

  const last30 = rows.slice(-30);
  const last7 = rows.slice(-7);
  const prev7 = rows.slice(-14, -7);

  const netFlow7d = last7.reduce((sum, r) =>
    sum + (parseFloat(r.FlowOutExNtv || 0) - parseFloat(r.FlowInExNtv || 0)), 0);

  const netFlow30d = last30.reduce((sum, r) =>
    sum + (parseFloat(r.FlowOutExNtv || 0) - parseFloat(r.FlowInExNtv || 0)), 0);

  const prevNetFlow7d = prev7.reduce((sum, r) =>
    sum + (parseFloat(r.FlowOutExNtv || 0) - parseFloat(r.FlowInExNtv || 0)), 0);

  const priceNow = parseFloat(last7[last7.length - 1].PriceUSD);
  const price7dAgo = parseFloat(last7[0].PriceUSD);
  const priceChange7d = ((priceNow - price7dAgo) / price7dAgo) * 100;

  const addrNow = parseFloat(last7[last7.length - 1].AdrActCnt);
  const addr7dAgo = parseFloat(last7[0].AdrActCnt);
  const addrChange7d = ((addrNow - addr7dAgo) / addr7dAgo) * 100;

  const mvrvRow = [...last7].reverse().find(r => r.CapMVRVCur && r.CapMVRVCur !== 'null');
  const mvrv = mvrvRow ? parseFloat(mvrvRow.CapMVRVCur) : null;

  const totalInflow7d = last7.reduce((s, r) => s + parseFloat(r.FlowInExNtv || 0), 0);
  const totalOutflow7d = last7.reduce((s, r) => s + parseFloat(r.FlowOutExNtv || 0), 0);

  const result = {
    netFlow7d: Math.round(netFlow7d),
    netFlow30d: Math.round(netFlow30d),
    prevNetFlow7d: Math.round(prevNetFlow7d),
    totalInflow7d: Math.round(totalInflow7d),
    totalOutflow7d: Math.round(totalOutflow7d),
    priceNow: Math.round(priceNow),
    priceChange7d: parseFloat(priceChange7d.toFixed(2)),
    addrChange7d: parseFloat(addrChange7d.toFixed(2)),
    mvrv: mvrv ? parseFloat(mvrv.toFixed(3)) : null,
    mvrvZone: classifyMVRV(mvrv),
    ...whaleData,
    lastUpdated: new Date().toISOString()
  };

  cache.data = result;
  cache.timestamp = now;
  return { ...result, from_cache: false };
}

// ── MVRV Zone Classifier ─────────────────────────────────────
function classifyMVRV(mvrv) {
  if (mvrv === null) return 'unknown';
  if (mvrv < 1) return 'undervalued';
  if (mvrv < 2) return 'fair_value';
  if (mvrv < 3.5) return 'overheated';
  return 'extreme_greed';
}

// ── Regime Classifier ────────────────────────────────────────
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

// ── Divergence Detector ──────────────────────────────────────
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

// ── Conviction Scorer ────────────────────────────────────────
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

// ── Plain English Verdict ────────────────────────────────────
function buildVerdict(regime, conviction, divergence, m) {
  const direction = m.netFlow7d > 0 ? 'outflows exceeding inflows' : 'inflows exceeding outflows';
  const flowAmt = Math.abs(m.netFlow7d).toLocaleString();
  const whaleDeltaAmt = Math.abs(m.netWhaleDelta).toLocaleString();
  const whaleDir = m.netWhaleDelta > 0 ? 'added' : 'removed';
  const mvrvDesc = { undervalued: 'historically cheap', fair_value: 'fairly valued', overheated: 'running hot', extreme_greed: 'in extreme greed territory' };

  let v = `BTC exchange flows show ${regime.toLowerCase()} signals this week, with ${direction} of approximately ${flowAmt} BTC over 7 days. `;
  v += `Whale addresses (1k–10k+ BTC) ${whaleDir} ${whaleDeltaAmt} BTC from their holdings this week. `;
  v += `Price is ${m.priceChange7d >= 0 ? 'up' : 'down'} ${Math.abs(m.priceChange7d)}% over the same period. `;
  if (m.mvrvZone !== 'unknown') v += `MVRV zone: ${m.mvrvZone.replace('_', ' ')} — market is ${mvrvDesc[m.mvrvZone]}. `;
  if (divergence.detected) v += `⚠️ Divergence detected (${divergence.type}): ${divergence.note}. `;
  v += `Conviction score: ${conviction}/100. `;
  if (conviction >= 75) v += 'Signal is strong — flows, whale cohorts, and trend are aligned.';
  else if (conviction >= 50) v += 'Signal is moderate — watch for confirmation.';
  else v += 'Signal is weak — mixed or conflicting flows.';
  return v;
}

// ── MCP Server ───────────────────────────────────────────────
const server = new McpServer({ name: 'whalepulse', version: '1.0.0' });

// ── Tool 1: get_whale_regime ─────────────────────────────────
server.tool(
  'get_whale_regime',
  'Returns BTC exchange flow regime and whale cohort accumulation/distribution signal with conviction score and plain English verdict.',
  { asset: z.string().default('BTC').describe('Asset to analyze, default BTC') },
  async ({ asset }) => {
    try {
      const m = await fetchAllMetrics();
      const regime = classifyRegime(m.netFlow7d, m.netFlow30d, m.cohortSignal);
      const divergence = detectDivergence(m.netFlow7d, m.priceChange7d);
      const conviction = scoreConviction(m, divergence);
      const verdict = buildVerdict(regime, conviction, divergence, m);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            asset: asset.toUpperCase(),
            regime,
            conviction_score: conviction,
            exchange_net_flow_7d_btc: m.netFlow7d,
            exchange_net_flow_30d_btc: m.netFlow30d,
            flow_direction: m.netFlow7d > 0 ? 'outflow' : 'inflow',
            whale_cohorts: {
              cohort_1k_10k_btc: m.cohort1k10k_now,
              cohort_10k_plus_btc: m.cohort10k_now,
              delta_1k_10k_7d: m.delta1k10k,
              delta_10k_plus_7d: m.delta10k,
              net_whale_delta_7d: m.netWhaleDelta,
              cohort_signal: m.cohortSignal,
              total_whale_holdings_btc: m.totalWhaleHoldings
            },
            price_usd: m.priceNow,
            price_change_7d_pct: m.priceChange7d,
            mvrv: m.mvrv,
            mvrv_zone: m.mvrvZone,
            divergence,
            verdict,
            confidence: conviction >= 70 ? 'high' : conviction >= 45 ? 'medium' : 'low',
            data_freshness_hours: m.from_cache ? 4 : 0,
            last_updated: m.lastUpdated,
            sources: ['coinmetrics_community', 'bitcoin_data_api']
          }, null, 2)
        }]
      };
    } catch (err) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: true,
            message: err.message,
            fallback: 'Data temporarily unavailable. Please retry in a few minutes.'
          })
        }]
      };
    }
  }
);

// ── Tool 2: get_divergence_signal ────────────────────────────
server.tool(
  'get_divergence_signal',
  'Detects divergence between BTC price action and exchange flow direction — bullish or bearish signal.',
  { asset: z.string().default('BTC').describe('Asset to analyze, default BTC') },
  async ({ asset }) => {
    try {
      const m = await fetchAllMetrics();
      const divergence = detectDivergence(m.netFlow7d, m.priceChange7d);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            asset: asset.toUpperCase(),
            price_change_7d_pct: m.priceChange7d,
            exchange_net_flow_7d_btc: m.netFlow7d,
            flow_direction: m.netFlow7d > 0 ? 'outflow' : 'inflow',
            whale_cohort_signal: m.cohortSignal,
            net_whale_delta_7d: m.netWhaleDelta,
            mvrv: m.mvrv,
            mvrv_zone: m.mvrvZone,
            divergence_detected: divergence.detected,
            divergence_type: divergence.type,
            divergence_severity: divergence.severity,
            divergence_note: divergence.note,
            directional_bias: divergence.detected ? (divergence.type === 'bullish' ? 'bullish' : 'bearish') : 'neutral',
            confidence: divergence.severity === 'strong' ? 'high' : divergence.severity === 'mild' ? 'medium' : 'low',
            freshness_hours: m.from_cache ? 4 : 0,
            last_updated: m.lastUpdated,
            sources: ['coinmetrics_community', 'bitcoin_data_api']
          }, null, 2)
        }]
      };
    } catch (err) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: true, message: err.message })
        }]
      };
    }
  }
);

// ── Tool 3: get_conviction_score ─────────────────────────────
server.tool(
  'get_conviction_score',
  'Returns a 0-100 conviction score for BTC accumulation or distribution pressure with full signal breakdown.',
  { asset: z.string().default('BTC').describe('Asset to analyze, default BTC') },
  async ({ asset }) => {
    try {
      const m = await fetchAllMetrics();
      const regime = classifyRegime(m.netFlow7d, m.netFlow30d, m.cohortSignal);
      const divergence = detectDivergence(m.netFlow7d, m.priceChange7d);
      const conviction = scoreConviction(m, divergence);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            asset: asset.toUpperCase(),
            conviction_score: conviction,
            signal_breakdown: {
              flow_magnitude_score: Math.abs(m.netFlow7d) > 20000 ? 25 : Math.abs(m.netFlow7d) > 10000 ? 15 : Math.abs(m.netFlow7d) > 5000 ? 10 : 5,
              trend_consistency_score: (m.netFlow7d > 0) === (m.netFlow30d > 0) ? 15 : 0,
              acceleration_score: Math.abs(m.netFlow7d) > Math.abs(m.prevNetFlow7d) ? 10 : 0,
              address_activity_score: m.addrChange7d > 5 ? 10 : m.addrChange7d > 0 ? 5 : -5,
              mvrv_adjustment: m.mvrvZone === 'undervalued' ? 10 : m.mvrvZone === 'fair_value' ? 5 : m.mvrvZone === 'overheated' ? -5 : m.mvrvZone === 'extreme_greed' ? -15 : 0,
              whale_cohort_score: m.cohortSignal === 'strong_accumulation' ? 15 : m.cohortSignal === 'mild_accumulation' ? 8 : m.cohortSignal === 'mild_distribution' ? -8 : -15,
              whale_delta_bonus: Math.abs(m.netWhaleDelta) > 20000 ? 10 : Math.abs(m.netWhaleDelta) > 10000 ? 5 : 0,
              divergence_penalty: divergence.detected ? (divergence.severity === 'strong' ? -15 : -7) : 0
            },
            regime,
            mvrv: m.mvrv,
            mvrv_zone: m.mvrvZone,
            whale_cohort_signal: m.cohortSignal,
            net_whale_delta_7d: m.netWhaleDelta,
            verdict: conviction >= 75 ? 'Strong signal — high confidence' : conviction >= 50 ? 'Moderate signal — watch for confirmation' : 'Weak signal — mixed flows',
            confidence: conviction >= 70 ? 'high' : conviction >= 45 ? 'medium' : 'low',
            freshness_hours: m.from_cache ? 4 : 0,
            last_updated: m.lastUpdated,
            sources: ['coinmetrics_community', 'bitcoin_data_api']
          }, null, 2)
        }]
      };
    } catch (err) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: true, message: err.message })
        }]
      };
    }
  }
);

// ── Start Server ─────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('WhalePulse MCP server running...');
}

main().catch(console.error);