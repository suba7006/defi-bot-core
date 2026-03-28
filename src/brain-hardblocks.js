/**
 * brain-hardblocks.js — Kristal Auto Core
 *
 * Logica hard block centralizzata per tutti i bot.
 * Chiamata da ogni brain.js DOPO la decisione di Claude.
 * Garantisce che regole critiche non vengano mai violate.
 */

'use strict';

const { isBlockedPair } = require('./token-registry');

/**
 * Applica tutti gli hard block alla decisione di Claude.
 *
 * @param {Object} decision   — { action, reason, params }
 * @param {Object} state      — { positions, balance, topPools }
 * @param {Object} strategy   — strategy.json del bot
 * @param {number|string} chainId
 * @returns {Object} decision eventualmente modificata
 */
function applyHardBlocks(decision, state, strategy, chainId) {
  const positions  = state.positions || [];
  const idleUSD    = parseFloat(state.balance?.totalIdleUSD || 0);
  const maxPos     = strategy.maxPositions || 4;
  const consolidT  = strategy.consolidationThreshold || 35;

  // ── 1. blockedPairs: filtra pool con pair bloccati ──────────────────────
  if (['open_position', 'rebalance'].includes(decision.action) && decision.params?.pair) {
    const blocked = (strategy.blockedPairs || []).some(bp => {
      const parts = bp.toUpperCase().split('/');
      const pair  = (decision.params.pair || '').toUpperCase();
      return pair.includes(parts[0]) && pair.includes(parts[1]);
    });
    // Controlla anche tramite token-registry (chain-specific)
    const blockedByChain = chainId ? isBlockedPair(decision.params.pair, chainId) : false;
    if (blocked || blockedByChain) {
      console.log(`[hardblocks] ⛔ pair bloccato: ${decision.params.pair}`);
      return _hold(decision, `Hard block: pair ${decision.params.pair} permanentemente bloccato`);
    }
  }

  // ── 2. Max posizioni: se al limite, NON aprire nuove posizioni ──────────
  if (decision.action === 'open_position' && positions.length >= maxPos) {
    console.log(`[hardblocks] ⚠️ max posizioni: ${positions.length}/${maxPos}, idle $${idleUSD.toFixed(2)}`);
    // Se idle > threshold → increase sulla posizione migliore
    if (idleUSD >= consolidT) {
      const best = [...positions].sort((a,b) => (b.aprEffective||0) - (a.aprEffective||0))[0];
      if (best) {
        console.log(`[hardblocks] → increase #${best.tokenId} (${best.pair})`);
        return {
          action: 'increase_position',
          reason: `Hard block: max ${maxPos} posizioni. Aumento #${best.tokenId} (${best.pair})`,
          params: { tokenId: best.tokenId, amountUSD: Math.floor(idleUSD) },
        };
      }
    }
    return _hold(decision, `Hard block: max ${maxPos} posizioni, idle $${idleUSD.toFixed(2)} < $${consolidT}`);
  }

  // ── 3. Increase: solo se idle > consolidationThreshold ─────────────────
  if (decision.action === 'increase_position') {
    if (idleUSD < consolidT) {
      console.log(`[hardblocks] ⚠️ increase bloccato: idle $${idleUSD.toFixed(2)} < $${consolidT}`);
      return _hold(decision, `Hard block: idle $${idleUSD.toFixed(2)} < $${consolidT} — hold`);
    }
  }

  // ── 4. Posizione giovane < 2h: mai close o rebalance ───────────────────
  if (['close_position', 'rebalance'].includes(decision.action) && decision.params?.tokenId) {
    const pos = positions.find(p => String(p.tokenId) === String(decision.params.tokenId));
    if (pos && (pos.ageDays || 0) * 24 < 2) {
      console.log(`[hardblocks] ⚠️ posizione #${pos.tokenId} troppo giovane: ${((pos.ageDays||0)*24).toFixed(1)}h`);
      return _hold(decision, `Hard block: posizione #${pos.tokenId} età ${((pos.ageDays||0)*24).toFixed(1)}h < 2h`);
    }
  }

  // ── 5. Close giovane < 48h: solo rebalance permesso ────────────────────
  if (decision.action === 'close_position' && decision.params?.tokenId) {
    const pos = positions.find(p => String(p.tokenId) === String(decision.params.tokenId));
    if (pos && (pos.ageDays || 0) * 24 < 48) {
      console.log(`[hardblocks] ⚠️ close bloccato: posizione #${pos.tokenId} età ${((pos.ageDays||0)*24).toFixed(1)}h < 48h`);
      return _hold(decision, `Hard block: close vietato su posizione giovane < 48h`);
    }
  }

  return decision;
}

/**
 * Filtra le top pool rimuovendo i pair bloccati.
 * Da chiamare in _buildUserMessage prima di passare le pool a Claude.
 *
 * @param {Array}  topPools
 * @param {Object} strategy
 * @param {number|string} chainId
 * @returns {Array}
 */
function filterBlockedPools(topPools, strategy, chainId) {
  const blockedPairs = strategy.blockedPairs || [];

  return (topPools || []).filter(pool => {
    const pair = (pool.pair || '').toUpperCase();

    // Check strategy.json blockedPairs
    const blockedByStrategy = blockedPairs.some(bp => {
      const parts = bp.toUpperCase().split('/');
      return pair.includes(parts[0]) && pair.includes(parts[1]);
    });
    if (blockedByStrategy) return false;

    // Check chain-specific blockedPairs
    if (chainId && isBlockedPair(pair, chainId)) return false;

    return true;
  });
}

function _hold(decision, reason) {
  return { action: 'hold', reason, params: {} };
}

module.exports = { applyHardBlocks, filterBlockedPools };
