require('dotenv').config();
const fetch = require('node-fetch');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const express = require('express');
const fs = require('fs');
const path = require('path');

// ── Utility ───────────────────────────────────────────────────
function extractAsset(input) {
  if (!input) return 'BTC';
  const upper = input.toString().toUpperCase();
  if (upper.includes('BTC') || upper.includes('BITCOIN')) return 'BTC';
  return 'BTC';
}

// ── Config ────────────────────────────────────────────────────
const BASE_URL = process.env.COINMETRICS_API_BASE;
const BITCOIN_DATA_TOKEN = process.env.BITCOIN_DATA_TOKEN;
const PORT = process.env.PORT || 3000;
const CACHE_DURATION_MS = 4 * 60 * 60 * 1000;

let cache = { data: null, timestamp: null };
let whaleCache = { data: null, timestamp: null };

// ── Fetch Whale Cohorts from bitcoin-data.com ─────────────────
async function fetchWhaleCohorts() {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 31);
  const startday = start.toISOString().split('T')[0];
  const endday = end.toISOString().split('T')[0];

  try {
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
    const cohort1k10k_7d  = parseFloat(data1k10k[Math.max(0, data1k10k.length - 8)].coinsAddr10Kto1Kbtc);
    const cohort1k10k_30d = parseFloat(data1k10k[0].coinsAddr10Kto1Kbtc);
    const cohort10k_now   = parseFloat(data10k[data10k.length - 1].coinsAddr10Kbtc);
    const cohort10k_7d    = parseFloat(data10k[Math.max(0, data10k.length - 8)].coinsAddr10Kbtc);
    const cohort10k_30d   = parseFloat(data10k[0].coinsAddr10Kbtc);

    const delta1k10k       = Math.round(cohort1k10k_now - cohort1k10k_7d);
    const delta10k         = Math.round(cohort10k_now   - cohort10k_7d);
    const netWhaleDelta    = delta1k10k + delta10k;
    const delta1k10k_30d   = Math.round(cohort1k10k_now - cohort1k10k_30d);
    const delta10k_30d     = Math.round(cohort10k_now   - cohort10k_30d);
    const netWhaleDelta30d = delta1k10k_30d + delta10k_30d;

    let cohortSignal;
    if (netWhaleDelta > 5000)       cohortSignal = 'strong_accumulation';
    else if (netWhaleDelta > 0)     cohortSignal = 'mild_accumulation';
    else if (netWhaleDelta < -5000) cohortSignal = 'strong_distribution';
    else                            cohortSignal = 'mild_distribution';

    const freshData = {
      cohort1k10k_now: Math.round(cohort1k10k_now),
      cohort10k_now:   Math.round(cohort10k_now),
      delta1k10k, delta10k, netWhaleDelta,
      delta1k10k_30d, delta10k_30d, netWhaleDelta30d,
      cohortSignal,
      totalWhaleHoldings: Math.round(cohort1k10k_now + cohort10k_now),
      cohort_stale: false
    };

    whaleCache.data = freshData;
    whaleCache.timestamp = Date.now();
    return freshData;

  } catch (err) {
    if (whaleCache.data) {
      console.error('bitcoin-data.com unavailable — serving stale whale cohort cache:', err.message);
      return { ...whaleCache.data, cohort_stale: true };
    }
    throw err;
  }
}

// ── Fetch BTC Metrics from CoinMetrics ───────────────────────
async function fetchAllMetrics() {
  const now = Date.now();
  if (cache.data && cache.timestamp && (now - cache.timestamp) < CACHE_DURATION_MS) {
    return { ...cache.data, from_cache: true };
  }

  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 65);
  const startStr = start.toISOString().split('T')[0];
  const endStr   = end.toISOString().split('T')[0];

  const url = `${BASE_URL}/timeseries/asset-metrics?assets=btc&metrics=FlowInExNtv,FlowOutExNtv,PriceUSD,AdrActCnt,CapMVRVCur&frequency=1d&start_time=${startStr}&end_time=${endStr}`;

  let cmResponse, whaleData;
  try {
    [cmResponse, whaleData] = await Promise.all([fetch(url), fetchWhaleCohorts()]);
  } catch (err) {
    if (cache.data) return { ...cache.data, from_cache: true, stale: true };
    throw err;
  }

  if (!cmResponse.ok) {
    if (cache.data) return { ...cache.data, from_cache: true, stale: true };
    throw new Error(`CoinMetrics API error: ${cmResponse.status}`);
  }

  const json = await cmResponse.json();
  const rows = json.data;
  if (!rows || rows.length < 14) throw new Error('Insufficient data from CoinMetrics');

  const last30  = rows.slice(-30);
  const last7   = rows.slice(-7);
  const prev7   = rows.slice(-14, -7);
  const prior30 = rows.slice(-60, -30);

  const netFlow7d = last7.reduce((sum, r) =>
    sum + (parseFloat(r.FlowOutExNtv || 0) - parseFloat(r.FlowInExNtv || 0)), 0);

  const netFlow30d = last30.reduce((sum, r) =>
    sum + (parseFloat(r.FlowOutExNtv || 0) - parseFloat(r.FlowInExNtv || 0)), 0);

  const prevNetFlow7d = prev7.reduce((sum, r) =>
    sum + (parseFloat(r.FlowOutExNtv || 0) - parseFloat(r.FlowInExNtv || 0)), 0);

  const priorNetFlow30d = prior30.length >= 7 ? prior30.reduce((sum, r) =>
    sum + (parseFloat(r.FlowOutExNtv || 0) - parseFloat(r.FlowInExNtv || 0)), 0) : null;

  const priceNow    = parseFloat(last7[last7.length - 1].PriceUSD);
  const price7dAgo  = parseFloat(last7[0].PriceUSD);
  const priceChange7d = ((priceNow - price7dAgo) / price7dAgo) * 100;

  const addrNow   = parseFloat(last7[last7.length - 1].AdrActCnt);
  const addr7dAgo = parseFloat(last7[0].AdrActCnt);
  const addrChange7d = ((addrNow - addr7dAgo) / addr7dAgo) * 100;

  const mvrvRow = [...last7].reverse().find(r => r.CapMVRVCur && r.CapMVRVCur !== 'null');
  const mvrv    = mvrvRow ? parseFloat(mvrvRow.CapMVRVCur) : null;

  const totalInflow7d  = last7.reduce((s, r) => s + parseFloat(r.FlowInExNtv  || 0), 0);
  const totalOutflow7d = last7.reduce((s, r) => s + parseFloat(r.FlowOutExNtv || 0), 0);

  const deltaOfDeltas = priorNetFlow30d !== null
    ? Math.round(netFlow30d - priorNetFlow30d)
    : null;

  let trendDirection = 'stable';
  if (deltaOfDeltas !== null) {
    if (Math.abs(deltaOfDeltas) < 1000) trendDirection = 'stable';
    else if ((netFlow30d > 0 && deltaOfDeltas > 0) || (netFlow30d < 0 && deltaOfDeltas < 0)) trendDirection = 'accelerating';
    else trendDirection = 'reversing';
  }

  const exchangeFlowTrend = netFlow30d > prevNetFlow7d * 4
    ? 'increasing_outflow'
    : netFlow30d < prevNetFlow7d * 4
    ? 'decreasing_outflow'
    : 'stable';

  const currentDir     = netFlow7d > 0;
  const priorDir       = prevNetFlow7d > 0;
  const regimeShiftFlag = currentDir !== priorDir;

  const result = {
    netFlow7d:      Math.round(netFlow7d),
    netFlow30d:     Math.round(netFlow30d),
    prevNetFlow7d:  Math.round(prevNetFlow7d),
    priorNetFlow30d: priorNetFlow30d !== null ? Math.round(priorNetFlow30d) : null,
    deltaOfDeltas,
    trendDirection,
    exchangeFlowTrend,
    regimeShiftFlag,
    totalInflow7d:  Math.round(totalInflow7d),
    totalOutflow7d: Math.round(totalOutflow7d),
    priceNow:       Math.round(priceNow),
    priceChange7d:  parseFloat(priceChange7d.toFixed(2)),
    addrChange7d:   parseFloat(addrChange7d.toFixed(2)),
    mvrv: mvrv ? parseFloat(mvrv.toFixed(3)) : null,
    mvrvZone: classifyMVRV(mvrv),
    ...whaleData,
    lastUpdated: new Date().toISOString()
  };

  cache.data      = result;
  cache.timestamp = now;
  return { ...result, from_cache: false, stale: false };
}

// ── MVRV Zone Classifier ──────────────────────────────────────
function classifyMVRV(mvrv) {
  if (mvrv === null) return 'unknown';
  if (mvrv < 1)     return 'undervalued';
  if (mvrv < 2)     return 'fair_value';
  if (mvrv < 3.5)   return 'overheated';
  return 'extreme_greed';
}

// ── Regime Classifier ─────────────────────────────────────────
function classifyRegime(netFlow7d, netFlow30d, cohortSignal) {
  const acc7d    = netFlow7d > 0;
  const acc30d   = netFlow30d > 0;
  const mag      = Math.abs(netFlow7d);
  const whaleAcc = cohortSignal === 'strong_accumulation' || cohortSignal === 'mild_accumulation';

  if (acc7d !== acc30d) {
    const primary   = acc7d ? 'Mild Accumulation' : 'Mild Distribution';
    const secondary = acc7d ? 'Mild Distribution' : 'Mild Accumulation';
    return { primary, secondary, boundary: true, note: 'Signal sits between two states - short and long term flows conflict' };
  }

  if (acc7d && acc30d && !whaleAcc && mag > 5000) return 'Conflicted - Exchange Outflow but Whale Distribution';
  if (acc7d && acc30d && mag > 5000)             return 'Accumulation';
  if (acc7d && acc30d)                           return 'Mild Accumulation';
  if (!acc7d && !acc30d && !whaleAcc && mag > 5000) return 'Strong Distribution';
  if (!acc7d && !acc30d && mag > 5000)           return 'Distribution';
  if (!acc7d && !acc30d)                         return 'Mild Distribution';
  return 'Neutral';
}

// ── Divergence Detector ───────────────────────────────────────
function detectDivergence(netFlow7d, priceChange7d, cohortSignal) {
  const cohortAcc  = cohortSignal === 'strong_accumulation' || cohortSignal === 'mild_accumulation';
  const cohortDist = cohortSignal === 'strong_distribution' || cohortSignal === 'mild_distribution';
  const flowAcc    = netFlow7d > 0;

  if (flowAcc && cohortDist) {
    const severity = cohortSignal === 'strong_distribution' ? 'strong' : 'moderate';
    return { detected: true, type: 'bearish', severity, note: 'Exchange outflows suggest accumulation but whale cohorts are reducing holdings - composite signal is bearish. Do not size up on exchange flow alone.' };
  }
  if (!flowAcc && cohortAcc) {
    const severity = cohortSignal === 'strong_accumulation' ? 'strong' : 'moderate';
    return { detected: true, type: 'bullish', severity, note: 'Exchange inflows suggest distribution but whale cohorts are accumulating - smart money may be absorbing sell pressure.' };
  }

  const priceUp = priceChange7d > 0;
  if (priceUp && !flowAcc) {
    const absPct   = Math.abs(priceChange7d);
    const severity = absPct > 10 ? 'strong' : absPct > 5 ? 'moderate' : 'mild';
    return { detected: true, type: 'bearish', severity, note: 'Price rising but BTC leaving exchanges - potential distribution into strength' };
  }
  if (!priceUp && flowAcc) {
    const absPct   = Math.abs(priceChange7d);
    const severity = absPct > 10 ? 'strong' : absPct > 5 ? 'moderate' : 'mild';
    return { detected: true, type: 'bullish', severity, note: 'Price falling but BTC being withdrawn from exchanges - potential accumulation on weakness' };
  }
  return { detected: false, type: 'none', severity: 'none', note: 'Flow direction aligns with price action and whale cohort signal' };
}

// ── Bull Phase Probability ────────────────────────────────────
function calcBullPhaseProbability(mvrvZone, cohortSignal, netFlow30d, trendDirection) {
  let score = 0;
  if (mvrvZone === 'undervalued') score += 30;
  else if (mvrvZone === 'fair_value') score += 20;
  else if (mvrvZone === 'overheated') score += 10;
  if (cohortSignal === 'strong_accumulation') score += 30;
  else if (cohortSignal === 'mild_accumulation') score += 15;
  if (netFlow30d > 0) score += 25;
  if (trendDirection === 'accelerating') score += 15;
  else if (trendDirection === 'stable') score += 5;
  return Math.min(100, score);
}

// ── Conviction Scorer ─────────────────────────────────────────
function scoreConviction(m, divergence) {
  let score = 50;

  const mag = Math.abs(m.netFlow7d);
  let exchangeFlowScore = 0;
  if (mag > 20000)      exchangeFlowScore = 25;
  else if (mag > 10000) exchangeFlowScore = 15;
  else if (mag > 5000)  exchangeFlowScore = 10;
  else if (mag > 1000)  exchangeFlowScore = 5;
  score += exchangeFlowScore;

  const sameDir = (m.netFlow7d > 0) === (m.netFlow30d > 0);
  if (sameDir) score += 15;
  if (Math.abs(m.netFlow7d) > Math.abs(m.prevNetFlow7d) && sameDir) score += 10;

  if (m.addrChange7d > 5)      score += 10;
  else if (m.addrChange7d > 0) score += 5;
  else                         score -= 5;

  let mvrvAdj = 0;
  if (m.mvrvZone === 'undervalued')   mvrvAdj =  10;
  else if (m.mvrvZone === 'fair_value')  mvrvAdj = 5;
  else if (m.mvrvZone === 'overheated')  mvrvAdj = -5;
  else if (m.mvrvZone === 'extreme_greed') mvrvAdj = -15;
  score += mvrvAdj;

  let cohortDeltaScore = 0;
  if (m.cohortSignal === 'strong_accumulation')   cohortDeltaScore =  20;
  else if (m.cohortSignal === 'mild_accumulation') cohortDeltaScore =  10;
  else if (m.cohortSignal === 'mild_distribution') cohortDeltaScore = -20;
  else if (m.cohortSignal === 'strong_distribution') cohortDeltaScore = -30;
  score += cohortDeltaScore;
if (m.cohortSignal === 'strong_distribution' && score > 50) score = 50;
  if (m.cohortSignal === 'strong_accumulation' && score < 50) score = 50;
  if (Math.abs(m.netWhaleDelta) > 20000)      score += 10;
  else if (Math.abs(m.netWhaleDelta) > 10000) score += 5;

  let divergencePenalty = 0;
  if (divergence.detected && divergence.severity === 'strong')   divergencePenalty = -15;
  else if (divergence.detected && divergence.severity === 'moderate') divergencePenalty = -10;
  else if (divergence.detected && divergence.severity === 'mild')     divergencePenalty = -7;
  score += divergencePenalty;

  const regimeScore = sameDir ? 15 : 0;

  return {
    total: Math.max(0, Math.min(100, Math.round(score))),
    breakdown: { cohort_delta_score: cohortDeltaScore, exchange_flow_score: exchangeFlowScore, regime_score: regimeScore, divergence_penalty: divergencePenalty }
  };
}

// ── Plain English Verdict ─────────────────────────────────────
function buildVerdict(regime, conviction, divergence, m) {
  const regimeLabel   = typeof regime === 'object' ? regime.primary : regime;
  const direction     = m.netFlow7d > 0 ? 'outflows exceeding inflows' : 'inflows exceeding outflows';
  const flowAmt       = Math.abs(m.netFlow7d).toLocaleString();
  const whaleDeltaAmt = Math.abs(m.netWhaleDelta).toLocaleString();
  const whaleDir      = m.netWhaleDelta > 0 ? 'added' : 'removed';
  const mvrvDesc      = { undervalued: 'historically cheap', fair_value: 'fairly valued', overheated: 'running hot', extreme_greed: 'in extreme greed territory' };

  let v = `BTC exchange flows show ${regimeLabel.toLowerCase()} signals this week, with ${direction} of approximately ${flowAmt} BTC over 7 days. `;
  v += `Whale addresses (1k–10k+ BTC) ${whaleDir} ${whaleDeltaAmt} BTC from their holdings this week. `;
  v += `Price is ${m.priceChange7d >= 0 ? 'up' : 'down'} ${Math.abs(m.priceChange7d)}% over the same period. `;
  if (m.mvrvZone !== 'unknown') v += `MVRV zone: ${m.mvrvZone.replace('_', ' ')} - market is ${mvrvDesc[m.mvrvZone]}. `;
  if (typeof regime === 'object' && regime.boundary) v += `[BOUNDARY] ${regime.note}. `;
  if (divergence.detected) v += `[DIVERGENCE DETECTED - ${divergence.type.toUpperCase()}]: ${divergence.note}. `;
  v += `Conviction score: ${conviction.total}/100. `;
  if (conviction.total >= 75)      v += 'Signal is strong - flows, whale cohorts, and trend are aligned.';
  else if (conviction.total >= 50) v += 'Signal is moderate - watch for confirmation.';
  else                             v += 'Signal is weak - mixed or conflicting flows.';
  return v;
}

// ── TOOLS Array (with outputSchema + _meta) ───────────────────
// GAP 1 fixed: outputSchema declared on every tool
// GAP 5 fixed: _meta declared on every tool (surface, queryEligible, latencyClass, pricing, rateLimit)
const TOOLS = [
  {
    name: 'get_whale_regime',
    description: 'Returns BTC exchange flow regime and whale cohort accumulation/distribution signal with conviction score, trend analysis, and plain English verdict.',
    _meta: {
      surface: 'both',
      queryEligible: true,
      latencyClass: 'instant',
      pricing: { executeUsd: '0.001' },
      rateLimit: {
        maxRequestsPerMinute: 30,
        cooldownMs: 2000,
        maxConcurrency: 3,
        notes: 'Responses are cached up to 4 hours. Repeated calls within that window serve cached data instantly.'
      }
    },
    inputSchema: {
      type: 'object',
      properties: {
        asset:       { type: 'string', default: 'BTC', description: 'Asset to analyze, default BTC', examples: ['BTC'] },
        window_days: { type: 'number', default: 7,     description: 'Lookback window in days - 7 or 30', examples: [7, 30] }
      }
    },
    outputSchema: {
      type: 'object',
      properties: {
        asset:                          { type: 'string', description: 'Asset analyzed (e.g. BTC)' },
        window_days:                    { type: 'number', description: 'Lookback window in days (7 or 30)' },
        regime:                         { type: 'string', description: 'Current regime: Strong Accumulation, Accumulation, Mild Accumulation, Neutral, Mild Distribution, Distribution, or Strong Distribution' },
        regime_detail:                  { type: ['object', 'null'], description: 'Detailed regime object when boundary signal; null otherwise' },
        conviction_score:               { type: 'number', description: 'Signal conviction 0–100; ≥75 high, 45–74 medium, <45 low' },
        exchange_net_flow_7d_btc:       { type: 'number', description: 'Net BTC exchange flow 7d (positive = outflow = accumulation signal)' },
        exchange_net_flow_30d_btc:      { type: 'number', description: 'Net BTC exchange flow 30d' },
        exchange_net_flow_btc:          { type: 'number', description: 'Alias for exchange_net_flow_7d_btc' },
        exchange_flow_direction:        { type: 'string', description: 'outflow or inflow' },
        cohort_supply_delta_1k_btc:     { type: 'number', description: '7d BTC supply change for 1k–10k BTC addresses' },
        cohort_supply_delta_10k_btc:    { type: 'number', description: '7d BTC supply change for 10k+ BTC addresses' },
        cohort_supply_delta_current_30d:{ type: 'number', description: 'Combined net whale supply delta over 30 days' },
        cohort_delta_30d:               { type: 'number', description: 'Alias for cohort_supply_delta_current_30d' },
        cohort_supply_delta_prior_30d:  { type: ['number', 'null'], description: 'Prior 30d net exchange flow for trend comparison; null if insufficient history' },
        delta_of_deltas:                { type: ['number', 'null'], description: 'Acceleration: current 30d minus prior 30d flow' },
        trend_direction:                { type: 'string', description: 'stable, accelerating, or reversing' },
        exchange_flow_trend:            { type: 'string', description: 'increasing_outflow, decreasing_outflow, or stable' },
        regime_shift_flag:              { type: 'boolean', description: 'True if 7d and prior 7d flows switched direction' },
        whale_cohorts: {
          type: 'object',
          description: 'Whale address cohort breakdown from bitcoin-data.com',
          properties: {
            cohort_1k_10k_btc:      { type: 'number', description: 'Total BTC held by 1k–10k addresses' },
            cohort_10k_plus_btc:    { type: 'number', description: 'Total BTC held by 10k+ addresses' },
            delta_1k_10k_7d:        { type: 'number', description: '7d net supply change for 1k–10k cohort in BTC' },
            delta_10k_plus_7d:      { type: 'number', description: '7d net supply change for 10k+ cohort in BTC' },
            net_whale_delta_7d:     { type: 'number', description: 'Combined 7d net delta across both whale cohorts' },
            cohort_signal:          { type: 'string', description: 'strong_accumulation, mild_accumulation, mild_distribution, or strong_distribution' },
            total_whale_holdings_btc:{ type: 'number', description: 'Total BTC across both cohorts' }
          },
          required: ['cohort_1k_10k_btc', 'cohort_10k_plus_btc', 'net_whale_delta_7d', 'cohort_signal']
        },
        price_usd:         { type: 'number', description: 'Latest BTC price in USD' },
        price_change_7d_pct:{ type: 'number', description: 'BTC price change % over 7 days' },
        mvrv:              { type: ['number', 'null'], description: 'Market Value to Realized Value ratio; null if unavailable' },
        mvrv_zone:         { type: 'string', description: 'undervalued (<1), fair_value (1–2), overheated (2–3.5), or extreme_greed (>3.5)' },
        divergence: {
          type: 'object',
          description: 'Price/flow divergence signal',
          properties: {
            detected: { type: 'boolean', description: 'True if price and flow direction conflict' },
            type:     { type: 'string',  description: 'bullish, bearish, or none' },
            severity: { type: 'string',  description: 'mild, moderate, strong, or none' },
            note:     { type: 'string',  description: 'Plain English divergence explanation' }
          },
          required: ['detected', 'type', 'severity', 'note']
        },
        verdict:            { type: 'string',  description: 'Plain English summary of regime, whale activity, price action, and signal strength' },
        confidence:         { type: 'string',  description: 'high, medium, or low - derived from conviction_score' },
        risk_note:          { type: 'string',  description: 'Risk flag or confirmation note' },
        data_freshness_hours:{ type: 'number', description: '0 if freshly fetched; 4 if served from cache' },
        stale_cache:        { type: 'boolean', description: 'True if cache could not be refreshed' },
        last_updated:       { type: 'string',  description: 'ISO 8601 timestamp of last successful data fetch' },
        source_primary:     { type: 'string',  description: 'Primary data source identifier' },
        sources:            { type: 'array', items: { type: 'string' }, description: 'All data sources used' }
      },
      required: ['asset', 'regime', 'conviction_score', 'exchange_net_flow_7d_btc', 'whale_cohorts', 'price_usd', 'mvrv_zone', 'divergence', 'verdict', 'confidence']
    }
  },

  {
    name: 'get_divergence_signal',
    description: 'Detects divergence between BTC price action and exchange flow direction - bullish or bearish signal with severity rating.',
    _meta: {
      surface: 'both',
      queryEligible: true,
      latencyClass: 'instant',
      pricing: { executeUsd: '0.001' },
      rateLimit: {
        maxRequestsPerMinute: 30,
        cooldownMs: 2000,
        maxConcurrency: 3,
        notes: 'Responses cached up to 4 hours.'
      }
    },
    inputSchema: {
      type: 'object',
      properties: {
        asset: { type: 'string', default: 'BTC', description: 'Asset to analyze, default BTC', examples: ['BTC'] }
      }
    },
    outputSchema: {
      type: 'object',
      properties: {
        asset:                    { type: 'string', description: 'Asset analyzed' },
        price_delta_7d_pct:       { type: 'number', description: 'BTC price change % over 7 days' },
        exchange_inflow_7d_btc:   { type: 'number', description: 'Total BTC inflow to exchanges over 7 days' },
        exchange_net_flow_7d_btc: { type: 'number', description: 'Net exchange flow 7d (positive = outflow)' },
        exchange_flow_direction:  { type: 'string', description: 'outflow or inflow' },
        cohort_net_direction:     { type: 'string', description: 'accumulating or distributing - based on whale cohort net delta' },
        whale_cohort_signal:      { type: 'string', description: 'strong_accumulation, mild_accumulation, mild_distribution, or strong_distribution' },
        net_whale_delta_7d:       { type: 'number', description: 'Combined whale cohort 7d supply delta in BTC' },
        mvrv:                     { type: ['number', 'null'], description: 'MVRV ratio; null if unavailable' },
        mvrv_zone:                { type: 'string', description: 'undervalued, fair_value, overheated, or extreme_greed' },
        divergence_detected:      { type: 'boolean', description: 'True if price direction and flow direction conflict' },
        divergence_type:          { type: 'string',  description: 'bullish, bearish, or none' },
        divergence_severity:      { type: 'string',  description: 'mild, moderate, strong, or none' },
        divergence_flag:          { type: 'boolean', description: 'Alias for divergence_detected' },
        divergence_note:          { type: 'string',  description: 'Plain English explanation of the divergence signal' },
        directional_bias:         { type: 'string',  description: 'bullish, bearish, or neutral' },
        confidence:               { type: 'string',  description: 'high, medium, or low - based on divergence severity' },
        historical_precedent_count:{ type: 'number', description: 'Number of historical days in the comparison dataset' },
        freshness_hours:          { type: 'number', description: '0 if fresh, 4 if cached' },
        stale_cache:              { type: 'boolean' },
        last_updated:             { type: 'string', description: 'ISO 8601 timestamp' },
        source_primary:           { type: 'string' },
        sources:                  { type: 'array', items: { type: 'string' } }
      },
      required: ['asset', 'divergence_detected', 'divergence_type', 'divergence_severity', 'directional_bias', 'confidence']
    }
  },

  {
    name: 'get_conviction_score',
    description: 'Returns a 0–100 conviction score for BTC accumulation or distribution pressure with full signal breakdown.',
    _meta: {
      surface: 'both',
      queryEligible: true,
      latencyClass: 'instant',
      pricing: { executeUsd: '0.001' },
      rateLimit: {
        maxRequestsPerMinute: 30,
        cooldownMs: 2000,
        maxConcurrency: 3,
        notes: 'Responses cached up to 4 hours.'
      }
    },
    inputSchema: {
      type: 'object',
      properties: {
        asset: { type: 'string', default: 'BTC', description: 'Asset to analyze, default BTC', examples: ['BTC'] }
      }
    },
    outputSchema: {
      type: 'object',
      properties: {
        asset:            { type: 'string', description: 'Asset analyzed' },
        conviction_score: { type: 'number', description: 'Signal conviction 0–100; ≥75 strong, 50–74 moderate, <50 weak' },
        signal_breakdown: {
          type: 'object',
          description: 'Score component breakdown',
          properties: {
            cohort_delta_score:  { type: 'number', description: 'Points from whale cohort signal (-15 to +15)' },
            exchange_flow_score: { type: 'number', description: 'Points from flow magnitude (0 to +25)' },
            regime_score:        { type: 'number', description: 'Points from 7d/30d alignment (0 or +15)' },
            divergence_penalty:  { type: 'number', description: 'Penalty from price/flow divergence (0 to -15)' }
          },
          required: ['cohort_delta_score', 'exchange_flow_score', 'regime_score', 'divergence_penalty']
        },
        regime:             { type: 'string',  description: 'Current regime label' },
        mvrv:               { type: ['number', 'null'], description: 'MVRV ratio' },
        mvrv_zone:          { type: 'string',  description: 'undervalued, fair_value, overheated, or extreme_greed' },
        whale_cohort_signal:{ type: 'string',  description: 'strong_accumulation, mild_accumulation, mild_distribution, or strong_distribution' },
        net_whale_delta_7d: { type: 'number',  description: 'Combined whale cohort 7d supply change in BTC' },
        trend_direction:    { type: 'string',  description: 'stable, accelerating, or reversing' },
        regime_shift_flag:  { type: 'boolean', description: 'True if regime direction changed' },
        verdict:            { type: 'string',  description: 'Plain English conviction verdict' },
        confidence:         { type: 'string',  description: 'high, medium, or low' },
        freshness_hours:    { type: 'number' },
        stale_cache:        { type: 'boolean' },
        last_updated:       { type: 'string' },
        source_primary:     { type: 'string' },
        sources:            { type: 'array', items: { type: 'string' } }
      },
      required: ['asset', 'conviction_score', 'signal_breakdown', 'regime', 'mvrv_zone', 'verdict', 'confidence']
    }
  },

  {
    name: 'get_historical_precedents',
    description: 'Returns top 3 historical BTC regime matches closest to current conditions, with 30d and 90d price outcomes and bull phase probability.',
    _meta: {
      surface: 'both',
      queryEligible: true,
      latencyClass: 'instant',
      pricing: { executeUsd: '0.001' },
      rateLimit: {
        maxRequestsPerMinute: 15,
        cooldownMs: 4000,
        maxConcurrency: 2,
        notes: 'Reads local historical database; live metrics portion is cached up to 4 hours.'
      }
    },
    inputSchema: {
      type: 'object',
      properties: {
        asset: { type: 'string', default: 'BTC', description: 'Asset to analyze, default BTC', examples: ['BTC'] }
      }
    },
    outputSchema: {
      type: 'object',
      properties: {
        asset:                  { type: 'string', description: 'Asset analyzed' },
        current_regime:         { type: 'string', description: 'Current regime label used for matching' },
        current_mvrv_zone:      { type: 'string', description: 'Current MVRV zone' },
        current_net_flow_7d:    { type: 'number', description: 'Current 7d net exchange flow in BTC' },
        current_net_flow_30d:   { type: 'number', description: 'Current 30d net exchange flow in BTC' },
        current_cohort_supply_delta: { type: 'number', description: 'Current 7d whale cohort supply delta' },
        bull_phase_probability: { type: 'number', description: 'Score 0–100 estimating bull phase likelihood from current conditions' },
        historical_bull_phase_matches: {
          type: 'array',
          description: 'Top accumulation episodes with positive 90d outcomes, sorted by 90d gain',
          items: {
            type: 'object',
            properties: {
              date:                 { type: 'string', description: 'Historical snapshot date (YYYY-MM-DD)' },
              regime:               { type: 'string', description: 'Regime label at that date' },
              price_outcome_90d_pct:{ type: 'number', description: 'BTC price change % 90 days after this date' },
              price_outcome_30d_pct:{ type: 'number', description: 'BTC price change % 30 days after this date' }
            },
            required: ['date', 'regime', 'price_outcome_90d_pct', 'price_outcome_30d_pct']
          }
        },
        top_3_historical_matches: {
          type: 'array',
          description: 'Top 3 historical snapshots most similar to current conditions',
          items: {
            type: 'object',
            properties: {
              date:                  { type: 'string', description: 'Historical snapshot date (YYYY-MM-DD)' },
              regime:                { type: 'string', description: 'Regime at that date' },
              mvrv_zone:             { type: 'string', description: 'MVRV zone at that date' },
              net_flow_7d_btc:       { type: 'number', description: '7d net exchange flow at that date in BTC' },
              cohort_delta_at_time:  { type: 'number', description: 'Whale cohort delta at that date' },
              exchange_flow_at_time: { type: 'number', description: 'Exchange flow at that date' },
              price_at_time_usd:     { type: 'number', description: 'BTC price at that historical date in USD' },
              price_outcome_30d_pct: { type: 'number', description: 'BTC % return 30 days after this date' },
              price_outcome_90d_pct: { type: 'number', description: 'BTC % return 90 days after this date' },
              price_outcome_30d_usd: { type: 'number', description: 'BTC price 30 days after this date in USD' },
              price_outcome_90d_usd: { type: 'number', description: 'BTC price 90 days after this date in USD' },
              similarity_score:      { type: 'number', description: 'Similarity score 0–100 vs current conditions' }
            },
            required: ['date', 'regime', 'price_outcome_30d_pct', 'price_outcome_90d_pct', 'similarity_score']
          }
        },
        average_outcome_30d_pct: { type: 'number', description: 'Average 30d price outcome across top 3 matches' },
        average_outcome_90d_pct: { type: 'number', description: 'Average 90d price outcome across top 3 matches' },
        match_confidence_score:  { type: 'string', description: 'high (similarity ≥70), medium (≥50), or low (<50)' },
        summary:                 { type: 'string', description: 'Plain English summary of historical matches and outcomes' },
        plain_english_verdict:   { type: 'string', description: 'Alias for summary' },
        caveat_note:             { type: 'string', description: 'Standard caveat on past vs future outcomes' },
        freshness_hours:         { type: 'number' },
        last_updated:            { type: 'string' },
        source_primary:          { type: 'string' },
        sources:                 { type: 'array', items: { type: 'string' } }
      },
      required: ['asset', 'current_regime', 'top_3_historical_matches', 'bull_phase_probability', 'average_outcome_30d_pct', 'average_outcome_90d_pct', 'summary']
    }
  }
];

// ── MCP Server Factory ───────────────────────────────────────
// Creates a fresh Server per /mcp request to avoid transport reuse errors
function createServer() {
  const srv = new Server(
    { name: 'whalepulse', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  srv.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS
  }));

  srv.setRequestHandler(CallToolRequestSchema, async (request) => {
    return dispatchTool(request.params.name, request.params.arguments || {});
  });

  return srv;
}

// Keep a singleton for SSE transport
const server = createServer();

// ── Tool Dispatch ─────────────────────────────────────────────
// GAP 2 fixed: every return now includes structuredContent
async function dispatchTool(name, args = {}) {
  try {
    switch (name) {

      case 'get_whale_regime': {
        const asset      = extractAsset(args.asset);
        const window_days = [7, 30].includes(args.window_days) ? args.window_days : 7;
        const m          = await fetchAllMetrics();
        const regime     = classifyRegime(m.netFlow7d, m.netFlow30d, m.cohortSignal);
        const divergence = detectDivergence(m.netFlow7d, m.priceChange7d, m.cohortSignal);
        const conviction = scoreConviction(m, divergence);
        const verdict    = buildVerdict(regime, conviction, divergence, m);

        const structured = {
          asset: asset.toUpperCase(),
          window_days,
          regime:        typeof regime === 'object' ? regime.primary : regime,
          regime_detail: typeof regime === 'object' ? regime : null,
          conviction_score: conviction.total,
          exchange_net_flow_7d_btc:        m.netFlow7d,
          exchange_net_flow_30d_btc:       m.netFlow30d,
          exchange_net_flow_btc:           m.netFlow7d,
          exchange_flow_direction:         m.netFlow7d > 0 ? 'outflow' : 'inflow',
          cohort_supply_delta_1k_btc:      m.delta1k10k,
          cohort_supply_delta_10k_btc:     m.delta10k,
          cohort_supply_delta_current_30d: m.netWhaleDelta30d,
          cohort_delta_30d:                m.netWhaleDelta30d,
          cohort_supply_delta_prior_30d:   m.priorNetFlow30d,
          delta_of_deltas:                 m.deltaOfDeltas,
          trend_direction:                 m.trendDirection,
          exchange_flow_trend:             m.exchangeFlowTrend,
          regime_shift_flag:               m.regimeShiftFlag,
          whale_cohorts: {
            cohort_1k_10k_btc:       m.cohort1k10k_now,
            cohort_10k_plus_btc:     m.cohort10k_now,
            delta_1k_10k_7d:         m.delta1k10k,
            delta_10k_plus_7d:       m.delta10k,
            net_whale_delta_7d:      m.netWhaleDelta,
            cohort_signal:           m.cohortSignal,
            total_whale_holdings_btc:m.totalWhaleHoldings
          },
          price_usd:          m.priceNow,
          price_change_7d_pct:m.priceChange7d,
          mvrv:               m.mvrv,
          mvrv_zone:          m.mvrvZone,
          divergence,
          verdict,
          confidence: conviction.total >= 70 ? 'high' : conviction.total >= 45 ? 'medium' : 'low',
          risk_note: divergence.detected
            ? `Divergence detected: ${divergence.note}. Exercise caution before sizing position.`
            : conviction.total < 50
            ? 'Signal is weak - consider waiting for stronger confirmation before sizing.'
            : 'No major risk flags detected at current signal strength.',
          data_freshness_hours: m.from_cache ? 4 : 0,
          stale_cache:   m.stale || false,
          cohort_stale: m.cohort_stale || false,
          last_updated:  m.lastUpdated,
          source_primary:'coinmetrics_community',
          sources:       ['coinmetrics_community', 'bitcoin_data_api']
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
          structuredContent: structured
        };
      }

      case 'get_divergence_signal': {
        const asset      = extractAsset(args.asset);
        const m          = await fetchAllMetrics();
        const divergence = detectDivergence(m.netFlow7d, m.priceChange7d, m.cohortSignal);

        const structured = {
          asset: asset.toUpperCase(),
          price_delta_7d_pct:       m.priceChange7d,
          exchange_inflow_7d_btc:   m.totalInflow7d,
          exchange_net_flow_7d_btc: m.netFlow7d,
          exchange_flow_direction:  m.netFlow7d > 0 ? 'outflow' : 'inflow',
          cohort_net_direction:     m.netWhaleDelta > 0 ? 'accumulating' : 'distributing',
          whale_cohort_signal:      m.cohortSignal,
          net_whale_delta_7d:       m.netWhaleDelta,
          mvrv:                     m.mvrv,
          mvrv_zone:                m.mvrvZone,
          divergence_detected:      divergence.detected,
          divergence_type:          divergence.type,
          divergence_severity:      divergence.severity,
          divergence_flag:          divergence.detected,
          divergence_note:          divergence.note,
          directional_bias:         divergence.detected ? (divergence.type === 'bullish' ? 'bullish' : 'bearish') : 'neutral',
          confidence:               divergence.severity === 'strong' ? 'high' : divergence.severity === 'moderate' ? 'medium' : divergence.severity === 'mild' ? 'medium' : 'low',
          historical_precedent_count: 2191,
          freshness_hours: m.from_cache ? 4 : 0,
          stale_cache:   m.stale || false,
          cohort_stale: m.cohort_stale || false,
          last_updated:  m.lastUpdated,
          source_primary:'coinmetrics_community',
          sources:       ['coinmetrics_community', 'bitcoin_data_api']
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
          structuredContent: structured
        };
      }

      case 'get_conviction_score': {
        const asset      = extractAsset(args.asset);
        const m          = await fetchAllMetrics();
        const regime     = classifyRegime(m.netFlow7d, m.netFlow30d, m.cohortSignal);
        const divergence = detectDivergence(m.netFlow7d, m.priceChange7d, m.cohortSignal);
        const conviction = scoreConviction(m, divergence);

        const structured = {
          asset: asset.toUpperCase(),
          conviction_score: conviction.total,
          signal_breakdown: {
            cohort_delta_score:  conviction.breakdown.cohort_delta_score,
            exchange_flow_score: conviction.breakdown.exchange_flow_score,
            regime_score:        conviction.breakdown.regime_score,
            divergence_penalty:  conviction.breakdown.divergence_penalty
          },
          regime:             typeof regime === 'object' ? regime.primary : regime,
          mvrv:               m.mvrv,
          mvrv_zone:          m.mvrvZone,
          whale_cohort_signal:m.cohortSignal,
          net_whale_delta_7d: m.netWhaleDelta,
          trend_direction:    m.trendDirection,
          regime_shift_flag:  m.regimeShiftFlag,
          verdict:   conviction.total >= 75 ? 'Strong signal - high confidence' : conviction.total >= 50 ? 'Moderate signal - watch for confirmation' : 'Weak signal - mixed flows',
          confidence:conviction.total >= 70 ? 'high' : conviction.total >= 45 ? 'medium' : 'low',
          freshness_hours: m.from_cache ? 4 : 0,
          stale_cache:   m.stale || false,
          cohort_stale: m.cohort_stale || false,
          last_updated:  m.lastUpdated,
          source_primary:'coinmetrics_community',
          sources:       ['coinmetrics_community', 'bitcoin_data_api']
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
          structuredContent: structured
        };
      }

      case 'get_historical_precedents': {
        const asset  = extractAsset(args.asset);
        const m      = await fetchAllMetrics();
        const regime = classifyRegime(m.netFlow7d, m.netFlow30d, m.cohortSignal);
        const currentRegime = typeof regime === 'object' ? regime.primary : regime;

        const historyPath = path.join(__dirname, 'data/btc-history.json');
        if (!fs.existsSync(historyPath)) {
          throw new Error('Historical database not found. Run: node scripts/build-history.js');
        }
        const history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));

        const scored = history.map(snap => {
          let similarity = 0;
          if (snap.regime === currentRegime) similarity += 40;
          if (snap.mvrvZone === m.mvrvZone)  similarity += 20;
          const flowDiff = Math.abs(snap.netFlow7d - m.netFlow7d);
          if (flowDiff < 1000)        similarity += 20;
          else if (flowDiff < 5000)   similarity += 15;
          else if (flowDiff < 10000)  similarity += 10;
          else if (flowDiff < 20000)  similarity += 5;
          if ((snap.netFlow30d > 0) === (m.netFlow30d > 0)) similarity += 20;
          return { ...snap, similarity_score: similarity };
        });

        const top3 = scored
          .sort((a, b) => b.similarity_score - a.similarity_score)
          .slice(0, 3);

        const bullPhaseMatches = history
          .filter(s => (s.regime === 'Strong Accumulation' || s.regime === 'Accumulation') && s.pctChange90d > 20)
          .sort((a, b) => b.pctChange90d - a.pctChange90d)
          .slice(0, 3);

        const bullPhaseProbability = calcBullPhaseProbability(m.mvrvZone, m.cohortSignal, m.netFlow30d, m.trendDirection);

        const avgOutcome30d = (top3.reduce((s, r) => s + r.pctChange30d, 0) / 3).toFixed(2);
        const avgOutcome90d = (top3.reduce((s, r) => s + r.pctChange90d, 0) / 3).toFixed(2);

        const summary =
          `The 3 most similar historical BTC regimes to current conditions occurred in ${top3.map(r => r.date).join(', ')}. ` +
          `Average price outcome: ${avgOutcome30d}% over 30 days, ${avgOutcome90d}% over 90 days. ` +
          `Current regime: ${currentRegime}. MVRV zone: ${m.mvrvZone}. Bull phase probability: ${bullPhaseProbability}%.`;

        const structured = {
          asset: asset.toUpperCase(),
          current_regime:              currentRegime,
          current_mvrv_zone:           m.mvrvZone,
          current_net_flow_7d:         m.netFlow7d,
          current_net_flow_30d:        m.netFlow30d,
          current_cohort_supply_delta: m.netWhaleDelta,
          bull_phase_probability:      bullPhaseProbability,
          historical_bull_phase_matches: bullPhaseMatches.map(r => ({
            date:                  r.date,
            regime:                r.regime,
            price_outcome_90d_pct: r.pctChange90d,
            price_outcome_30d_pct: r.pctChange30d
          })),
          top_3_historical_matches: top3.map(r => ({
            date:                  r.date,
            regime:                r.regime,
            mvrv_zone:             r.mvrvZone,
            net_flow_7d_btc:       r.netFlow7d,
            cohort_delta_at_time:  r.netFlow7d,
            exchange_flow_at_time: r.netFlow7d,
            price_at_time_usd:     r.priceUSD,
            price_outcome_30d_pct: r.pctChange30d,
            price_outcome_90d_pct: r.pctChange90d,
            price_outcome_30d_usd: r.priceOutcome30d,
            price_outcome_90d_usd: r.priceOutcome90d,
            similarity_score:      r.similarity_score
          })),
          average_outcome_30d_pct: parseFloat(avgOutcome30d),
          average_outcome_90d_pct: parseFloat(avgOutcome90d),
          match_confidence_score:  top3[0].similarity_score >= 70 ? 'high' : top3[0].similarity_score >= 50 ? 'medium' : 'low',
          summary,
          plain_english_verdict: summary,
          caveat_note: 'Historical matches are based on exchange flow regime and MVRV similarity. Past price outcomes do not guarantee future results.',
          freshness_hours: m.from_cache ? 4 : 0,
          last_updated:  m.lastUpdated,
          source_primary:'coinmetrics_community',
          sources:       ['coinmetrics_community', 'bitcoin_data_api', 'coinmetrics_historical_archive']
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
          structuredContent: structured
        };
      }

      default:
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: true, message: `Unknown tool: ${name}` }) }],
          isError: true
        };
    }

  } catch (err) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: true, message: err.message, fallback: 'Data temporarily unavailable. Please retry in a few minutes.' }) }],
      isError: true
    };
  }
}

// ── Express App ───────────────────────────────────────────────
// GAP 3 fixed: HTTP SSE transport replacing StdioServerTransport
// GAP 4 fixed: createContextMiddleware() properly loaded and applied
const app = express();

// Active SSE transports keyed by sessionId
const transports = {};

// CTX middleware placeholder - updated in main() before listen()
// Using a variable reference so the real middleware is in place
// before any connection arrives
let ctxMiddleware = (req, res, next) => next();

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', server: 'whalepulse', version: '1.0.0' });
});

// ── /mcp - StreamableHTTP transport (CTX auto-discovery) ────────
// Fresh server per request to avoid transport reuse issues
app.all('/mcp', (req, res, next) => ctxMiddleware(req, res, next), async (req, res) => {
  try {
    const srv = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined // stateless mode
    });
    await srv.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP transport error:', err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: err.message }, id: null });
    }
  }
});

// SSE endpoint - MCP clients connect here to open a streaming channel
app.get('/sse', async (req, res) => {
  const transport = new SSEServerTransport('/message', res);
  transports[transport.sessionId] = transport;
  res.on('close', () => {
    delete transports[transport.sessionId];
  });
  await server.connect(transport);
});

// Message endpoint - MCP clients POST JSON-RPC messages here
// CTX middleware intercepts tools/call for payment verification
app.post('/message', express.json(), (req, res, next) => ctxMiddleware(req, res, next), async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];
  if (!transport) {
    return res.status(400).json({ error: 'Session not found. Connect to /sse first.' });
  }
  await transport.handlePostMessage(req, res);
});

// ── Bootstrap ─────────────────────────────────────────────────
async function main() {
  // Load CTX security middleware before accepting connections
  try {
    const ctx = await import('@ctxprotocol/sdk');
    if (typeof ctx.createContextMiddleware === 'function') {
      ctxMiddleware = ctx.createContextMiddleware();
      console.error('✓ CTX security middleware active on /message');
    } else {
      console.error('⚠ CTX SDK loaded but createContextMiddleware not found - running without payment verification');
    }
  } catch (err) {
    console.error('⚠ CTX SDK load warning (non-fatal):', err.message);
  }

  app.listen(PORT, () => {
    console.error(`WhalePulse MCP server running on port ${PORT}`);
    console.error(`  SSE endpoint:     http://localhost:${PORT}/sse`);
    console.error(`  Message endpoint: http://localhost:${PORT}/message`);
    console.error(`  Health check:     http://localhost:${PORT}/health`);
  });
}

main().catch(console.error);
module.exports = { fetchAllMetrics };