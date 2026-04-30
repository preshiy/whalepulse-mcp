# WhalePulse

BTC exchange flow regime classifier with whale cohort intelligence.

Delivers a conviction-scored accumulation vs distribution verdict on demand — built for retail BTC investors sizing a position without a Glassnode seat.

## What It Does

One question answered: **"Are BTC exchange inflows or outflows dominating this week, and does that signal accumulation or distribution pressure before I size my position?"**

WhalePulse combines two free on-chain data sources into a composite signal with threshold logic, regime classification, and a 0-100 conviction score.

## Data Sources

- **CoinMetrics Community API** — exchange net flows, MVRV ratio, active addresses, price
- **bitcoin-data.com API** — whale address cohort balances at 1k–10k BTC and 10k+ BTC resolution

## Tools

### `get_whale_regime`
Returns BTC exchange flow regime classification with whale cohort signal, MVRV zone, divergence detection, and plain English verdict.

**Example response fields:**
- `regime` — Strong Accumulation / Accumulation / Mild Accumulation / Neutral / Mild Distribution / Distribution / Strong Distribution
- `conviction_score` — 0 to 100
- `exchange_net_flow_7d_btc` — net BTC leaving or entering exchanges over 7 days
- `whale_cohorts` — holdings and 7-day delta for 1k–10k and 10k+ BTC address cohorts
- `mvrv_zone` — undervalued / fair_value / overheated / extreme_greed
- `divergence` — detected, type, severity, note
- `verdict` — plain English summary
- `confidence` — high / medium / low

---

### `get_divergence_signal`
Detects divergence between BTC price action and exchange flow direction.

**Example response fields:**
- `divergence_detected` — true / false
- `divergence_type` — bullish / bearish / none
- `divergence_severity` — strong / mild / none
- `divergence_note` — plain English explanation
- `directional_bias` — bullish / bearish / neutral

---

### `get_conviction_score`
Returns a 0-100 conviction score with full signal breakdown showing contribution of each factor.

**Example response fields:**
- `conviction_score` — 0 to 100
- `signal_breakdown` — individual scores for flow magnitude, trend consistency, acceleration, address activity, MVRV adjustment, whale cohort score, whale delta bonus, divergence penalty
- `verdict` — Strong / Moderate / Weak signal

---

## Freshness

Data is cached for 4 hours. All three tools share a single cache — APIs are fetched once per 4-hour window regardless of call volume.

## Ambiguity Behavior

- Partial data from either source returns a graceful error with a retry message — no crashes
- MVRV returns `unknown` if field is unavailable — conviction score excludes that factor
- Whale cohort data requires minimum 2 data points — falls back to error if insufficient history returned

## Scope — v1

**In v1:**
- BTC only
- Exchange flow regime classification
- Whale cohort delta (1k–10k BTC and 10k+ BTC address buckets)
- MVRV zone classification
- Price divergence detection
- Conviction scoring
- 4-hour cached responses

**NOT in v1:**
- No altcoins
- No dashboards
- No alerts or monitoring feeds
- No individual wallet tracking
- No real-time streaming
- No portfolio management

## Setup

### Requirements
- Node.js 18+
- npm

### Install
```bash
npm install
```

### Environment
Create a `.env` file in the project root: