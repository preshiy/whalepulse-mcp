require('dotenv').config();
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const BASE_URL = process.env.COINMETRICS_API_BASE;
const CACHE_DURATION_MS = 4 * 60 * 60 * 1000;

let cache = { data: null, timestamp: null };

async function fetchBTCMetrics() {
  const now = Date.now();
  if (cache.data && cache.timestamp && (now - cache.timestamp) < CACHE_DURATION_MS) {
    return { ...cache.data, from_cache: true };
  }

  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 35);
  const startStr = start.toISOString().split('T')[0];
  const endStr = end.toISOString().split('T')[0];

  const url = `${BASE_URL}/timeseries/asset-metrics?assets=btc&metrics=FlowInExNtv,FlowOutExNtv,PriceUSD,AdrActCnt&frequency=1d&start_time=${startStr}&end_time=${endStr}`;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`CoinMetrics API error: ${response.status}`);

  const json = await response.json();
  const rows = json.data;
  if (!rows || rows.length < 7) throw new Error('Insufficient data returned');

  const last30 = rows.slice(-30);
  const last7 = rows.slice(-7);
  const prev7 = rows.slice(-14, -7);

  const netFlow7d = last7.reduce((sum, r) => sum + (parseFloat(r.FlowOutExNtv || 0) - parseFloat(r.FlowInExNtv || 0)), 0);
  const netFlow30d = last30.reduce((sum, r) => sum + (parseFloat(r.FlowOutExNtv || 0) - parseFloat(r.FlowInExNtv || 0)), 0);
  const prevNetFlow7d = prev7.reduce((sum, r) => sum + (parseFloat(r.FlowOutExNtv || 0) - parseFloat(r.FlowInExNtv || 0)), 0);

  const priceNow = parseFloat(last7[last7.length - 1].PriceUSD);
  const price7dAgo = parseFloat(last7[0].PriceUSD);
  const priceChange7d = ((priceNow - price7dAgo) / price7dAgo) * 100;

  const addrNow = parseFloat(last7[last7.length - 1].AdrActCnt);
  const addr7dAgo = parseFloat(last7[0].AdrActCnt);
  const addrChange7d = ((addrNow - addr7dAgo) / addr7dAgo) * 100;

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
    lastUpdated: new Date().toISOString()
  };

  cache.data = result;
  cache.timestamp = now;
  return { ...result, from_cache: false };
}

function classifyRegime(netFlow7d, netFlow30d) {
  const isAccumulating7d = netFlow7d > 0;
  const isAccumulating30d = netFlow30d > 0;
  const magnitude7d = Math.abs(netFlow7d);

  if (isAccumulating7d && isAccumulating30d && magnitude7d > 5000) return 'Accumulation';
  if (isAccumulating7d && isAccumulating30d) return 'Mild Accumulation';
  if (!isAccumulating7d && !isAccumulating30d && magnitude7d > 5000) return 'Distribution';
  if (!isAccumulating7d && !isAccumulating30d) return 'Mild Distribution';
  return 'Neutral';
}

function detectDivergence(netFlow7d, priceChange7d) {
  const flowAccumulating = netFlow7d > 0;
  const priceRising = priceChange7d > 0;

  if (priceRising && !flowAccumulating) {
    const severity = Math.abs(priceChange7d) > 5 ? 'strong' : 'mild';
    return { detected: true, type: 'bearish', severity, note: 'Price rising but BTC leaving exchanges — potential distribution into strength' };
  }
  if (!priceRising && flowAccumulating) {
    const severity = Math.abs(priceChange7d) > 5 ? 'strong' : 'mild';
    return { detected: true, type: 'bullish', severity, note: 'Price falling but BTC withdrawn from exchanges — accumulation on weakness' };
  }
  return { detected: false, type: 'none', severity: 'none', note: 'Flow direction aligns with price action' };
}

function scoreConviction(netFlow7d, netFlow30d, prevNetFlow7d, addrChange7d, divergence) {
  let score = 50;
  const magnitude = Math.abs(netFlow7d);
  if (magnitude > 20000) score += 25;
  else if (magnitude > 10000) score += 15;
  else if (magnitude > 5000) score += 10;
  else if (magnitude > 1000) score += 5;

  if ((netFlow7d > 0) === (netFlow30d > 0)) score += 15;
  if (Math.abs(netFlow7d) > Math.abs(prevNetFlow7d) && (netFlow7d > 0) === (netFlow30d > 0)) score += 10;
  if (addrChange7d > 5) score += 10;
  else if (addrChange7d > 0) score += 5;
  else score -= 5;

  if (divergence.detected && divergence.severity === 'strong') score -= 15;
  else if (divergence.detected && divergence.severity === 'mild') score -= 7;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function buildVerdict(regime, conviction, divergence, netFlow7d, priceChange7d) {
  const direction = netFlow7d > 0 ? 'outflows exceeding inflows' : 'inflows exceeding outflows';
  const flowAmt = Math.abs(netFlow7d).toLocaleString();
  let verdict = `BTC exchange flows show ${regime.toLowerCase()} signals this week, with ${direction} of approximately ${flowAmt} BTC over 7 days. `;
  verdict += `Price is ${priceChange7d >= 0 ? 'up' : 'down'} ${Math.abs(priceChange7d)}% over the same period. `;
  if (divergence.detected) verdict += `Divergence detected (${divergence.type}): ${divergence.note}. `;
  verdict += `Conviction: ${conviction}/100. `;
  if (conviction >= 75) verdict += 'Signal is strong — flows and trend are aligned.';
  else if (conviction >= 50) verdict += 'Signal is moderate — watch for confirmation.';
  else verdict += 'Signal is weak — mixed or low-magnitude flows.';
  return verdict;
}

const server = new McpServer({ name: 'whalepulse', version: '1.0.0' });

server.tool(
  'get_whale_regime',
  'Returns BTC exchange flow regime — accumulation or distribution — with conviction score and plain English verdict.',
  { asset: z.string().default('BTC').describe('Asset to analyze, default BTC') },
  async ({ asset }) => {
    try {
      const metrics = await fetchBTCMetrics();
      const regime = classifyRegime(metrics.netFlow7d, metrics.netFlow30d);
      const divergence = detectDivergence(metrics.netFlow7d, metrics.priceChange7d);
      const conviction = scoreConviction(metrics.netFlow7d, metrics.netFlow30d, metrics.prevNetFlow7d, metrics.addrChange7d, divergence);
      const verdict = buildVerdict(regime, conviction, divergence, metrics.netFlow7d, metrics.priceChange7d);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            asset: asset.toUpperCase(),
            regime,
            conviction_score: conviction,
            exchange_net_flow_7d_btc: metrics.netFlow7d,
            exchange_net_flow_30d_btc: metrics.netFlow30d,
            flow_direction: metrics.netFlow7d > 0 ? 'outflow' : 'inflow',
            price_usd: metrics.priceNow,
            price_change_7d_pct: metrics.priceChange7d,
            divergence,
            verdict,
            confidence: conviction >= 70 ? 'high' : conviction >= 45 ? 'medium' : 'low',
            data_freshness_hours: metrics.from_cache ? 4 : 0,
            last_updated: metrics.lastUpdated,
            source: 'coinmetrics_community'
          }, null, 2)
        }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: true, message: err.message }) }] };
    }
  }
);

server.tool(
  'get_divergence_signal',
  'Detects divergence between BTC price action and exchange flow direction.',
  { asset: z.string().default('BTC').describe('Asset to analyze, default BTC') },
  async ({ asset }) => {
    try {
      const metrics = await fetchBTCMetrics();
      const divergence = detectDivergence(metrics.netFlow7d, metrics.priceChange7d);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            asset: asset.toUpperCase(),
            price_change_7d_pct: metrics.priceChange7d,
            exchange_net_flow_7d_btc: metrics.netFlow7d,
            flow_direction: metrics.netFlow7d > 0 ? 'outflow' : 'inflow',
            divergence_detected: divergence.detected,
            divergence_type: divergence.type,
            divergence_severity: divergence.severity,
            divergence_note: divergence.note,
            directional_bias: divergence.detected ? divergence.type : 'neutral',
            confidence: divergence.severity === 'strong' ? 'high' : divergence.severity === 'mild' ? 'medium' : 'low',
            freshness_hours: metrics.from_cache ? 4 : 0,
            source: 'coinmetrics_community'
          }, null, 2)
        }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: true, message: err.message }) }] };
    }
  }
);

server.tool(
  'get_conviction_score',
  'Returns a 0-100 conviction score for BTC exchange flow pressure with full signal breakdown.',
  { asset: z.string().default('BTC').describe('Asset to analyze, default BTC') },
  async ({ asset }) => {
    try {
      const metrics = await fetchBTCMetrics();
      const regime = classifyRegime(metrics.netFlow7d, metrics.netFlow30d);
      const divergence = detectDivergence(metrics.netFlow7d, metrics.priceChange7d);
      const conviction = scoreConviction(metrics.netFlow7d, metrics.netFlow30d, metrics.prevNetFlow7d, metrics.addrChange7d, divergence);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            asset: asset.toUpperCase(),
            conviction_score: conviction,
            signal_breakdown: {
              flow_magnitude_score: Math.abs(metrics.netFlow7d) > 20000 ? 25 : Math.abs(metrics.netFlow7d) > 10000 ? 15 : Math.abs(metrics.netFlow7d) > 5000 ? 10 : 5,
              trend_consistency_score: (metrics.netFlow7d > 0) === (metrics.netFlow30d > 0) ? 15 : 0,
              acceleration_score: Math.abs(metrics.netFlow7d) > Math.abs(metrics.prevNetFlow7d) ? 10 : 0,
              address_activity_score: metrics.addrChange7d > 5 ? 10 : metrics.addrChange7d > 0 ? 5 : -5,
              divergence_penalty: divergence.detected ? (divergence.severity === 'strong' ? -15 : -7) : 0
            },
            regime,
            verdict: conviction >= 75 ? 'Strong signal' : conviction >= 50 ? 'Moderate signal' : 'Weak signal',
            confidence: conviction >= 70 ? 'high' : conviction >= 45 ? 'medium' : 'low',
            freshness_hours: metrics.from_cache ? 4 : 0,
            source: 'coinmetrics_community'
          }, null, 2)
        }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: true, message: err.message }) }] };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('WhalePulse MCP server running...');
}

main().catch(console.error);