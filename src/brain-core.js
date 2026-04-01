/**
 * brain-core.js — Kristal Auto Core
 *
 * Logica brain centralizzata per bot bluechip (ARB, BASE, BNB).
 * Gestisce prompt, chiamata Claude API e hard blocks.
 *
 * Ogni bot passa un chainConfig con le specifiche della chain.
 * La strategia viene da strategy.json del bot.
 */

'use strict';

const axios = require('axios');
const { applyHardBlocks, filterBlockedPools } = require('./brain-hardblocks');

/**
 * Genera il system prompt per Claude.
 *
 * @param {Object} strategy   — strategy.json del bot
 * @param {Object} chainConfig — specifiche della chain
 */
function buildSystemPrompt(strategy, chainConfig) {
  const minEligibleApr = strategy.minAPR || 20;
  const stopLossApr    = strategy.stopLossAPR || 20;
  const outOfRangeRuns = strategy.outOfRangeRuns || 4;
  const chain          = chainConfig.chainName;
  const baseCcy        = chainConfig.baseCurrency.symbol; // es. 'USDC' o 'USDT'

  return `You are an autonomous DeFi liquidity management bot on ${chain}.
You manage a BLUECHIP vault using concentrated liquidity (Uniswap V3 and/or PancakeSwap V3).

## GOAL
${strategy.goal}

## ⛔ CRITICAL — TWO DIFFERENT APR THRESHOLDS (DO NOT CONFUSE)

| Threshold        | Value              | Purpose                           |
|------------------|--------------------|-----------------------------------|
| MIN_ELIGIBLE_APR | ${minEligibleApr}% | For OPENING new positions only    |
| STOP_LOSS_APR    | ${stopLossApr}%    | For CLOSING existing positions    |

CORRECT LOGIC:
- Pool APR ≥ ${minEligibleApr}% → eligible for new entry ✅
- Position APR ≥ ${stopLossApr}% → KEEP position, do NOT exit ✅
- Position APR < ${stopLossApr}% AND age ≥ 48h → consider exit ⚠️

WRONG LOGIC — NEVER DO THIS:
- Position APR < ${minEligibleApr}% → exit ❌ (exit uses STOP_LOSS_APR, not MIN_ELIGIBLE_APR)
- Position APR ${Math.round((minEligibleApr + stopLossApr) / 2)}% → exit ❌ (above STOP_LOSS_APR = healthy)

## ⛔ CRITICAL — YOUNG POSITION PROTECTION (age < 48h)

IF position age < 48h → SKIP all efficiency/APR exit checks.
Low APR on young positions is NORMAL — fees accumulate over time.
Only valid exits for young positions:
- Out-of-range for ${outOfRangeRuns}+ consecutive runs
- Catastrophic loss: PnL < ${strategy.stopLossPnL * 100}%

## ⛔ CRITICAL — EXIT BLOCKS ENTRY

NEVER decide open_position while any existing position meets exit criteria but is blocked by age.
If a position should exit but cannot (age < 48h) → output hold. Do NOT open new positions.

## CONFIGURATION
- MIN_ELIGIBLE_APR = ${minEligibleApr}% (new entries only)
- STOP_LOSS_APR    = ${stopLossApr}%    (exits only — NOT ${minEligibleApr}%)
- STOP_LOSS_PNL    = ${strategy.stopLossPnL * 100}%
- MIN_TVL          = $${strategy.minTVL}
- POSITION_RANGE_WIDTH    = ${(strategy.rangeWidth || 0.10) * 100}%
- COMPOUND_THRESHOLD      = $${strategy.compoundThreshold}
- CONSOLIDATION_THRESHOLD = $${strategy.consolidationThreshold}
- OUT_OF_RANGE_EXIT_RUNS  = ${outOfRangeRuns}
- MAX_POSITIONS           = ${strategy.maxPositions || 3}
- BASE_CURRENCY           = ${baseCcy} (always convert to ${baseCcy} on close)

## INSTRUCTIONS
${strategy.instructions || ''}

## ANTI-DUPLICATE RULES
- NEVER open_position on a poolAddress already in OCCUPIED POOLS
- NEVER open same pair+dex combination as existing position
- NEVER open stable-stable pairs (USDT/USDC, USDT/DAI, etc.)
- ALWAYS include "dex" field in params ("Uniswap" or "PancakeSwap")

## HYBRID APR FOR EXIT DECISIONS
For each open position, use aprForExit = max(aprEffective, poolAPR).
- aprEffective = real earned APR (fees / capital / time)
- poolAPR = current market APR from DeFiLlama/Krystal for the same pool
Rationale: aprEffective can be low on young positions or right after fee collection.
If the pool is still generating good market APR → do NOT close.
Only close when BOTH are below STOP_LOSS_APR.

## VALID EXIT SCENARIOS
✅ aprForExit < ${stopLossApr}% AND age ≥ 48h → close_position  (where aprForExit = max(aprEffective, poolAPR))
✅ PnL < ${strategy.stopLossPnL * 100}% AND age ≥ 48h → close_position
✅ Out-of-range ${outOfRangeRuns}+ consecutive runs → close_position (any age)

## INVALID EXIT SCENARIOS — NEVER DO THIS
❌ aprForExit ${stopLossApr + 10}%, age 5d → DO NOT EXIT (above STOP_LOSS_APR)
❌ aprForExit ${stopLossApr + 5}%, age 3d → DO NOT EXIT (above STOP_LOSS_APR)
❌ aprEffective low but poolAPR high → DO NOT EXIT (pool still healthy)
❌ Any position age < 48h, APR low → DO NOT EXIT (young position protection)

## RESPONSE FORMAT
Respond with a valid JSON object ONLY. No markdown, no text outside JSON.
{
  "action": "open_position" | "close_position" | "collect_fees" | "rebalance" | "increase_position" | "hold",
  "reason": "brief explanation",
  "params": {
    "poolAddress": "0x...",
    "pair": "WETH/${baseCcy}",
    "token0Address": "0x...",
    "token1Address": "0x...",
    "feeTierRaw": 500,
    "amountUSD": 20,
    "rangeWidth": 0.10,
    "tokenId": "12345",
    "dex": "Uniswap"
  }
}`;
}

/**
 * Genera il user message con lo stato del portfolio.
 *
 * @param {Object} portfolioState
 * @param {Object} strategy
 * @param {Object} chainConfig
 */
function buildUserMessage(portfolioState, strategy, chainConfig) {
  const idleUSD      = portfolioState.balance.totalIdleUSD || 0;
  const lpUSD        = (portfolioState.positions || []).reduce((s, p) => s + (parseFloat(p.valueUSD) || 0), 0);
  const totalCapital = idleUSD + lpUSD;
  const chain        = chainConfig.chainName;

  const occupiedPoolAddresses = new Set(
    (portfolioState.positions || []).map(p => (p.poolAddress || '').toLowerCase())
  );
  const occupiedPairDex = new Set(
    (portfolioState.positions || []).map(p => ((p.pair || '') + '_' + (p.dex || '')).toUpperCase())
  );
  const occupiedList = (portfolioState.positions || []).map(p =>
    `${p.pair} tokenId:${p.tokenId} pool:${p.poolAddress} dex:${p.dex}`
  );

  const stableSymbols = ['USDT', 'USDC', 'DAI', 'BUSD', 'FDUSD', 'USD1', 'USDBC', 'USDBC'];
  const isStableStable = pair => {
    const parts = pair.split('/');
    return parts.length === 2 &&
      stableSymbols.includes(parts[0].toUpperCase()) &&
      stableSymbols.includes(parts[1].toUpperCase());
  };

  const availablePools = filterBlockedPools(portfolioState.topPools, strategy, chainConfig.chainId)
    .filter(p => !occupiedPoolAddresses.has((p.poolAddress || '').toLowerCase()))
    .filter(p => !occupiedPairDex.has(((p.pair || '') + '_' + (p.dex || '')).toUpperCase()))
    .filter(p => !isStableStable(p.pair))
    .sort((a, b) => (b.apr || 0) - (a.apr || 0))
    .map((p, i) =>
      `#${i + 1} ${p.pair} APR:${p.apr}% TVL:$${p.tvlUSD} pool:${p.poolAddress} ` +
      `token0:${p.token0Address} token1:${p.token1Address} fee:${p.feeTierRaw} dex:${p.dex}`
    );

  // Build poolAPR lookup from topPools by poolAddress
  const poolAprMap = {};
  for (const pool of (portfolioState.topPools || [])) {
    if (pool.poolAddress) poolAprMap[(pool.poolAddress || '').toLowerCase()] = parseFloat(pool.apr || 0);
  }

  const positionsSummary = (portfolioState.positions || []).map(p => {
    const ageH = ((p.ageDays || 0) * 24).toFixed(1);
    const aprEff  = parseFloat(p.aprEffective || 0);
    const poolApr = poolAprMap[(p.poolAddress || '').toLowerCase()] || 0;
    const aprForExit = Math.max(aprEff, poolApr);
    return `- ${p.pair} tokenId:${p.tokenId} value:$${parseFloat(p.valueUSD || 0).toFixed(2)} ` +
      `deposited:$${parseFloat(p.depositedUSD || 0).toFixed(2)} ` +
      `aprEffective:${aprEff.toFixed(1)}% poolAPR:${poolApr.toFixed(1)}% aprForExit:${aprForExit.toFixed(1)}% ` +
      `unclaimed:$${parseFloat(p.unclaimedUSD || 0).toFixed(3)} ` +
      `inRange:${p.inRange} age:${ageH}h pnl:${parseFloat(p.pnlPct || 0).toFixed(1)}% ` +
      `dex:${p.dex} pool:${p.poolAddress}`;
  }).join('\n');

  return `Current portfolio state on ${chain}:
IDLE: $${idleUSD.toFixed(2)}
LP VALUE: $${lpUSD.toFixed(2)}
TOTAL: $${totalCapital.toFixed(2)}

OPEN POSITIONS:
${positionsSummary || 'None'}

OCCUPIED POOLS — NEVER open_position on these (by poolAddress OR pair+dex):
${occupiedList.length > 0 ? occupiedList.join('\n') : 'None'}

AVAILABLE POOLS (sorted by APR, filtered: no occupied pair+dex, no stable-stable, no blocked pairs):
${availablePools.length > 0 ? availablePools.join('\n') : 'NONE'}

── EXIT CHECK (evaluate FIRST) ──────────────────────────────────────────────
EXIT RULE: close_position if age ≥ 48h AND (aprForExit < ${strategy.stopLossAPR}% OR PnL < ${strategy.stopLossPnL * 100}%)
  where aprForExit = max(aprEffective, poolAPR) — shown per position above
OUT-OF-RANGE EXIT: close_position if out-of-range ≥ ${strategy.outOfRangeRuns || 4} consecutive runs (any age)
YOUNG POSITION (age < 48h): never close for efficiency — only catastrophic PnL or OOR runs
IF exit needed but blocked (age < 48h) → hold. Do NOT open new positions.

── REBALANCE ────────────────────────────────────────────────────────────────
If out of range AND age ≥ 2h → rebalance (recenter range on current price)
IMPORTANT: ENTRY filters (APR, TVL, Volume) apply ONLY to new positions. They do NOT block rebalance of an existing position. If OOR → always rebalance, regardless of pool current APR.

── COLLECT FEES ────────────────────────────────────────────────────────────
If unclaimed fees > $${strategy.compoundThreshold} → collect_fees

── ENTRY (only if no exit/rebalance needed) ────────────────────────────────
ENTRY RULE: open_position only if:
  - idle > $${strategy.consolidationThreshold}
  - Available pools list is not empty (APR ≥ ${strategy.minAPR}% required for entry)
  - NEVER on occupied poolAddress or pair+dex

── CONSOLIDATION (no entry possible) ───────────────────────────────────────
If idle > $${strategy.consolidationThreshold} AND no available pools AND all positions age ≥ 48h:
  → increase_position on highest APR position using ALL idle capital
If any position age < 48h → hold, do NOT increase

── DEFAULT ──────────────────────────────────────────────────────────────────
Otherwise: hold

Respond with valid JSON only.`;
}

/**
 * Chiama Claude API e applica hard blocks.
 *
 * @param {Object} portfolioState
 * @param {Object} strategy
 * @param {Object} chainConfig
 * @param {string} apiKey
 * @returns {Promise<Object>} decision { action, reason, params }
 */
async function decide(portfolioState, strategy, chainConfig, apiKey) {
  const systemPrompt = buildSystemPrompt(strategy, chainConfig);
  const userMessage  = buildUserMessage(portfolioState, strategy, chainConfig);

  let decision;
  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: strategy.model || 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      },
      {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        timeout: 30000,
      }
    );

    const content   = response.data.content[0].text;
    const cleaned   = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Nessun JSON trovato nella risposta Claude');
    decision = JSON.parse(jsonMatch[0]);
  } catch (error) {
    console.error('[BrainCore] Errore Claude API:', error.message,
      error.response?.data?.error?.message || '');
    return { action: 'hold', reason: 'Errore API Claude', params: {} };
  }

  // ── Hard blocks JS-side ───────────────────────────────────────────────────
  const positions  = portfolioState.positions || [];
  const idleUSD    = parseFloat(portfolioState.balance?.totalIdleUSD || 0);
  const maxPos     = strategy.maxPositions || 4;

  // 1. blockedPairs + chainId (già in applyHardBlocks)
  decision = applyHardBlocks(decision, { positions, balance: portfolioState.balance, topPools: portfolioState.topPools }, strategy, chainConfig.chainId);
  if (decision.action === 'hold') {
    console.log('[BrainCore] Decisione:', decision.action, '-', decision.reason);
    return decision;
  }

  // 2. collect_fees: solo se totale unclaimed >= compoundThreshold
  if (decision.action === 'collect_fees') {
    const totalUnclaimed = positions.reduce((s, p) => s + (parseFloat(p.unclaimedUSD) || 0), 0);
    const threshold = strategy.compoundThreshold || 20;
    if (totalUnclaimed < threshold) {
      console.log(`[BrainCore] ⚠️ Hard block collect_fees: unclaimed $${totalUnclaimed.toFixed(2)} < $${threshold}`);
      decision = { action: 'hold', reason: `Hard block: fees totali $${totalUnclaimed.toFixed(2)} < soglia $${threshold} — hold`, params: {} };
    }
  }

  // 4. open_position: idle < quota per posizione
  if (decision.action === 'open_position') {
    const lpUSD      = positions.reduce((s, p) => s + (parseFloat(p.valueUSD) || 0), 0);
    const quotaPerPos = (idleUSD + lpUSD) / maxPos;
    if (idleUSD < quotaPerPos) {
      console.log(`[BrainCore] ⚠️ Hard block open: idle $${idleUSD.toFixed(2)} < quota $${quotaPerPos.toFixed(2)}`);
      decision = { action: 'hold', reason: `Hard block: idle $${idleUSD.toFixed(2)} < quota posizione $${quotaPerPos.toFixed(2)}`, params: {} };
    }
  }

  // 5. close/rebalance: posizioni < 48h — no efficiency exit
  if (decision.action === 'close_position' && decision.params?.tokenId) {
    const pos  = positions.find(p => String(p.tokenId) === String(decision.params.tokenId));
    const ageH = pos ? (pos.ageDays || 0) * 24 : 999;
    if (ageH < 48) {
      // Permetti solo se OOR runs lo giustifica (Claude deve averlo indicato)
      const isOOR = (decision.reason || '').toLowerCase().includes('out-of-range') ||
                    (decision.reason || '').toLowerCase().includes('oor') ||
                    (decision.reason || '').toLowerCase().includes('out of range');
      if (!isOOR) {
        console.log(`[BrainCore] ⚠️ Hard block: close bloccato su #${pos?.tokenId} età ${ageH.toFixed(1)}h < 48h`);
        decision = { action: 'hold', reason: `Hard block: close bloccato — posizione #${pos?.tokenId} età ${ageH.toFixed(1)}h < 48h`, params: {} };
      }
    }
  }

  // 6. open_position mentre esistono posizioni underperforming ≥ 2h
  if (decision.action === 'open_position') {
    const stopLossApr = strategy.stopLossAPR || 20;
    // Build poolAPR lookup from topPools
    const poolAprMap = {};
    for (const pool of (portfolioState.topPools || [])) {
      if (pool.poolAddress) poolAprMap[(pool.poolAddress || '').toLowerCase()] = parseFloat(pool.apr || 0);
    }
    for (const pos of positions) {
      const ageH     = (pos.ageDays || 0) * 24;
      const aprEff   = parseFloat(pos.aprEffective || pos.apr24h || 0);
      const poolApr  = poolAprMap[(pos.poolAddress || '').toLowerCase()] || 0;
      const aprForExit = Math.max(aprEff, poolApr);
      const pnl      = parseFloat(pos.pnlPct || 0);
      const stoplPnl = strategy.stopLossPnL || -0.10;
      if (ageH >= 2 && (aprForExit < stopLossApr || pnl < stoplPnl * 100)) {
        console.log(`[BrainCore] ⚠️ Hard block: ${pos.pair} aprEff ${aprEff.toFixed(0)}% poolAPR ${poolApr.toFixed(0)}% aprForExit ${aprForExit.toFixed(0)}% / PnL ${pnl.toFixed(1)}% — risolvi EXIT prima`);
        decision = {
          action: 'hold',
          reason: `Hard block: ${pos.pair} aprForExit ${aprForExit.toFixed(0)}% < ${stopLossApr}% (aprEff ${aprEff.toFixed(0)}% poolAPR ${poolApr.toFixed(0)}%, age ${ageH.toFixed(1)}h) — risolvi EXIT prima di aprire nuove posizioni`,
          params: {},
        };
        break;
      }
    }
  }

  console.log('[BrainCore] Decisione:', decision.action, '-', decision.reason);
  return decision;
}

module.exports = { buildSystemPrompt, buildUserMessage, decide };
