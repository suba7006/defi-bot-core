/**
 * onchain-stats-core.js — Kristal Auto Core
 *
 * Calcolo depositi, fee, slippage dalla Safe API.
 * Chain-agnostic: riceve chainId e funziona su tutte le chain.
 *
 * FIX CENTRALE:
 * - outgoingRecipients include TUTTI gli indirizzi che ricevono token dal Safe
 * - Elimina il falso positivo di router/PM contati come depositi
 */

'use strict';

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const {
  fetchAllMultisigTx,
  fetchAllTransfers,
  groupTransfersByTx,
  groupNftTransfersByTx,
  buildOutgoingRecipients,
} = require('./safe-api');

const { getChainConfig, isStable } = require('./token-registry');

// ── Prezzi ────────────────────────────────────────────────────────────────

let _priceCache = null;
async function getPrices() {
  if (_priceCache && Date.now() - _priceCache.ts < 300000) return _priceCache;
  try {
    const [ethRes, btcRes] = await Promise.all([
      axios.get('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT', { timeout: 5000 }),
      axios.get('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', { timeout: 5000 }),
    ]);
    _priceCache = {
      eth: parseFloat(ethRes.data.price), weth: parseFloat(ethRes.data.price),
      btc: parseFloat(btcRes.data.price), wbtc: parseFloat(btcRes.data.price),
      bnb: 600, wbnb: 600,
      ts: Date.now(),
    };
  } catch(e) {
    _priceCache = { eth: 2000, weth: 2000, btc: 60000, wbtc: 60000, bnb: 600, wbnb: 600, ts: Date.now() };
  }
  return _priceCache;
}

/**
 * Converte un amount di token in USD usando prezzi Binance.
 */
function tokenUSD(symbol, amount, prices, chainId) {
  const s = (symbol || '').toUpperCase();
  const chainCfg = getChainConfig(chainId);

  // Stables sempre $1
  if (chainCfg.stables.includes(s)) return amount;

  // Token noti
  if (['WETH','ETH'].includes(s))  return amount * (prices.eth  || 2000);
  if (['WBTC','BTC','BTCB','CBBTC'].includes(s)) return amount * (prices.btc || 60000);
  if (['WBNB','BNB'].includes(s))  return amount * (prices.bnb  || 600);
  if (s === 'ARB')                  return amount * (prices.arb  || 0.5);

  return 0;
}

// ── Calcolo depositi ──────────────────────────────────────────────────────

/**
 * Calcola i depositi reali nel Safe da wallet esterni.
 * Esclude automaticamente tutti gli indirizzi che hanno ricevuto token dal Safe.
 *
 * @param {Array}  allTransfers
 * @param {string} safeAddr
 * @param {string} executorAddr
 * @param {number|string} chainId
 * @returns {{ totalDepositedUSD: number, deposits: Array }}
 */
function computeDeposits(allTransfers, safeAddr, executorAddr, chainId) {
  const chainCfg = getChainConfig(chainId);
  const outgoing = buildOutgoingRecipients(allTransfers, safeAddr, executorAddr);

  let totalDepositedUSD = 0;
  const deposits = [];

  for (const t of allTransfers) {
    if (t.type !== 'ERC20_TRANSFER') continue;
    if ((t.to || '').toLowerCase() !== safeAddr.toLowerCase()) continue;
    const from = (t.from || '').toLowerCase();
    if (outgoing.has(from)) continue; // router/PM — skip
    const sym = t.tokenInfo?.symbol || '';
    if (!chainCfg.stables.includes(sym.toUpperCase())) continue; // solo stable
    const dec    = t.tokenInfo?.decimals || 6;
    const amount = Number(t.value || 0) / 10 ** dec;
    if (amount < 1) continue;
    totalDepositedUSD += amount;
    deposits.push({
      date: t.executionDate?.slice(0, 10),
      token: sym, amount,
      from: t.from, txHash: t.transactionHash,
    });
  }

  return { totalDepositedUSD, deposits };
}

// ── Calcolo depositedByToken ──────────────────────────────────────────────

/**
 * Ricostruisce il capitale depositato per ogni tokenId LP.
 * Fonte: TX mint e increaseLiquidity sulla Safe API.
 *
 * @returns {Object} map tokenId → capitalUSD
 */
function computeDepositedByToken(txs, transfersByTx, nftByTx, safeAddr, prices, chainId) {
  const depositedByToken = {};

  const mintTxs = txs.filter(t => t.dataDecoded?.method === 'mint');
  for (const tx of mintTxs) {
    const nfts    = (nftByTx[tx.transactionHash] || []).filter(n =>
      (n.to || '').toLowerCase() === safeAddr.toLowerCase()
    );
    if (!nfts.length) continue;
    const tokenId = String(nfts[0].tokenId || nfts[0].tokenAddress);
    if (!tokenId) continue;

    const outgoing = (transfersByTx[tx.transactionHash] || []).filter(t =>
      (t.from || '').toLowerCase() === safeAddr.toLowerCase() && t.type === 'ERC20_TRANSFER'
    );
    let capitalUSD = 0;
    for (const t of outgoing) {
      const dec = t.tokenInfo?.decimals || 18;
      capitalUSD += tokenUSD(t.tokenInfo?.symbol, Number(t.value || 0) / 10 ** dec, prices, chainId);
    }
    if (capitalUSD > 0) depositedByToken[tokenId] = (depositedByToken[tokenId] || 0) + capitalUSD;
  }

  const increaseTxs = txs.filter(t => t.dataDecoded?.method === 'increaseLiquidity');
  for (const tx of increaseTxs) {
    const p0      = tx.dataDecoded?.parameters?.[0];
    if (!p0) continue;
    const tokenId = Array.isArray(p0.value) ? String(p0.value[0]) : String(p0.value);
    if (!tokenId || tokenId === 'undefined') continue;

    const outgoing = (transfersByTx[tx.transactionHash] || []).filter(t =>
      (t.from || '').toLowerCase() === safeAddr.toLowerCase() && t.type === 'ERC20_TRANSFER'
    );
    let capitalUSD = 0;
    for (const t of outgoing) {
      const dec = t.tokenInfo?.decimals || 18;
      capitalUSD += tokenUSD(t.tokenInfo?.symbol, Number(t.value || 0) / 10 ** dec, prices, chainId);
    }
    if (capitalUSD > 0) depositedByToken[tokenId] = (depositedByToken[tokenId] || 0) + capitalUSD;
  }

  return depositedByToken;
}

// ── Calcolo fee ───────────────────────────────────────────────────────────

/**
 * Calcola le fee harvestate per ogni tokenId noto.
 */
function computeFees(txs, transfersByTx, depositedByToken, safeAddr, prices, chainId) {
  const decreaseTxs    = txs.filter(t => t.dataDecoded?.method === 'decreaseLiquidity');
  const collectTxs     = txs.filter(t => t.dataDecoded?.method === 'collect');
  const decreaseBlocks = new Set(decreaseTxs.map(t => t.blockNumber));

  let totalFeesHarvestedUSD = 0;
  const feesByTokenId = {};
  const feeEvents     = [];

  for (const tx of collectTxs) {
    const paramVal = tx.dataDecoded?.parameters?.[0]?.value;
    const tokenId  = Array.isArray(paramVal) ? String(paramVal[0]) : (paramVal ? String(paramVal) : null);
    if (!tokenId || depositedByToken[tokenId] == null) continue;

    const incoming = (transfersByTx[tx.transactionHash] || []).filter(t =>
      (t.to || '').toLowerCase() === safeAddr.toLowerCase() && t.type === 'ERC20_TRANSFER'
    );

    let isCloseCollect = false;
    for (const db of decreaseBlocks) {
      if (Math.abs(tx.blockNumber - db) <= 30) { isCloseCollect = true; break; }
    }

    let grossUSD = 0;
    for (const t of incoming) {
      const dec    = t.tokenInfo?.decimals || 18;
      const amount = Number(t.value || 0) / 10 ** dec;
      grossUSD += tokenUSD(t.tokenInfo?.symbol, amount, prices, chainId);
    }

    const capitalReturned = isCloseCollect ? (depositedByToken[tokenId] || 0) : 0;
    const feeUSD = Math.max(0, grossUSD - capitalReturned);

    if (feeUSD > 0) {
      totalFeesHarvestedUSD += feeUSD;
      feesByTokenId[tokenId] = (feesByTokenId[tokenId] || 0) + feeUSD;
      feeEvents.push({ date: tx.executionDate?.slice(0,10), tokenId, feeUSD, txHash: tx.transactionHash });
    }
  }

  return { totalFeesHarvestedUSD, feesByTokenId, feeEvents };
}

// ── Gas e slippage per tokenId ────────────────────────────────────────────

/**
 * Attribuisce gas e slippage a ciascun tokenId in base ai TX executor.
 * - mint/increaseLiquidity/decreaseLiquidity/collect → gas al tokenId del TX
 * - exactInputSingle (swap) → gas+slippage al mint/increase successivo entro 15 blocchi
 * - swap non abbinati entro 15 blocchi → scartati (non contaminano altri tokenId)
 */
function computeGasAndSlippagePerToken(txs, transfersByTx, nftByTx, safeAddr, prices, chainId) {
  const chainCfg    = getChainConfig(chainId);
  const nativePrice = chainCfg.nativeToken === 'BNB' ? (prices.bnb || 600) : (prices.eth || 2000);
  const safeAddrLow = safeAddr.toLowerCase();

  const gasPerToken      = {};
  const slippagePerToken = {};

  // Ordina per blockNumber crescente
  const sorted = [...txs].sort((a, b) => (a.blockNumber || 0) - (b.blockNumber || 0));

  // Coda swap pendenti non ancora abbinati { block, gasUSD, slipUSD }
  const pendingSwaps = [];

  for (const tx of sorted) {
    const method = tx.dataDecoded?.method;
    const gasUSD = Number(tx.fee || 0) / 1e18 * nativePrice;
    const block  = tx.blockNumber || 0;

    // Scarta swap troppo vecchi (>15 blocchi senza position TX successiva)
    while (pendingSwaps.length && block - pendingSwaps[0].block > 15) {
      pendingSwaps.shift();
    }

    if (method === 'exactInputSingle') {
      const txTransfers = transfersByTx[tx.transactionHash] || [];
      const sent     = txTransfers.filter(t => (t.from||'').toLowerCase() === safeAddrLow && t.type === 'ERC20_TRANSFER');
      const received = txTransfers.filter(t => (t.to||'').toLowerCase()   === safeAddrLow && t.type === 'ERC20_TRANSFER');
      let slipUSD = 0;
      for (const s of sent) {
        if (!chainCfg.stables.includes((s.tokenInfo?.symbol||'').toUpperCase())) continue;
        const sentAmt = Number(s.value||0) / 10**(s.tokenInfo?.decimals||6);
        for (const r of received) {
          if (chainCfg.stables.includes((r.tokenInfo?.symbol||'').toUpperCase())) continue;
          const recUSD = tokenUSD(r.tokenInfo?.symbol, Number(r.value||0) / 10**(r.tokenInfo?.decimals||18), prices, chainId);
          const slip   = sentAmt - recUSD;
          if (slip > 0 && slip / sentAmt < 0.30) slipUSD += slip;
        }
      }
      pendingSwaps.push({ block, gasUSD, slipUSD });

    } else if (method === 'mint') {
      const nfts    = (nftByTx[tx.transactionHash] || []).filter(n => (n.to||'').toLowerCase() === safeAddrLow);
      if (!nfts.length) continue;
      const tokenId = String(nfts[0].tokenId || nfts[0].tokenAddress);
      gasPerToken[tokenId] = (gasPerToken[tokenId] || 0) + gasUSD;
      for (const s of pendingSwaps) {
        gasPerToken[tokenId]      = (gasPerToken[tokenId]      || 0) + s.gasUSD;
        slippagePerToken[tokenId] = (slippagePerToken[tokenId] || 0) + s.slipUSD;
      }
      pendingSwaps.length = 0;

    } else if (method === 'increaseLiquidity') {
      const p0 = tx.dataDecoded?.parameters?.[0];
      if (!p0) continue;
      const tokenId = Array.isArray(p0.value) ? String(p0.value[0]) : String(p0.value);
      if (!tokenId || tokenId === 'undefined') continue;
      gasPerToken[tokenId] = (gasPerToken[tokenId] || 0) + gasUSD;
      for (const s of pendingSwaps) {
        gasPerToken[tokenId]      = (gasPerToken[tokenId]      || 0) + s.gasUSD;
        slippagePerToken[tokenId] = (slippagePerToken[tokenId] || 0) + s.slipUSD;
      }
      pendingSwaps.length = 0;

    } else if (method === 'decreaseLiquidity') {
      const p0 = tx.dataDecoded?.parameters?.[0];
      if (!p0) continue;
      const tokenId = Array.isArray(p0.value) ? String(p0.value[0]) : String(p0.value);
      if (!tokenId || tokenId === 'undefined') continue;
      gasPerToken[tokenId] = (gasPerToken[tokenId] || 0) + gasUSD;

    } else if (method === 'collect') {
      const pv      = tx.dataDecoded?.parameters?.[0]?.value;
      const tokenId = Array.isArray(pv) ? String(pv[0]) : (pv ? String(pv) : null);
      if (!tokenId) continue;
      gasPerToken[tokenId] = (gasPerToken[tokenId] || 0) + gasUSD;
    }
  }

  return { gasPerToken, slippagePerToken };
}

// ── Calcolo slippage ──────────────────────────────────────────────────────

/**
 * Calcola lo slippage reale da swap stable → token.
 */
function computeSlippage(txs, transfersByTx, safeAddr, prices, chainId) {
  const chainCfg     = getChainConfig(chainId);
  const swapTxs      = txs.filter(t => t.dataDecoded?.method === 'exactInputSingle');
  let totalSlippage  = 0;
  const slippageEvents = [];

  for (const tx of swapTxs) {
    const txTransfers = transfersByTx[tx.transactionHash] || [];
    const sent     = txTransfers.filter(t => (t.from||'').toLowerCase()===safeAddr.toLowerCase() && t.type==='ERC20_TRANSFER');
    const received = txTransfers.filter(t => (t.to||'').toLowerCase()===safeAddr.toLowerCase()   && t.type==='ERC20_TRANSFER');

    for (const s of sent) {
      if (!chainCfg.stables.includes((s.tokenInfo?.symbol||'').toUpperCase())) continue;
      const sentAmt = Number(s.value||0) / 10**(s.tokenInfo?.decimals||6);
      for (const r of received) {
        if (chainCfg.stables.includes((r.tokenInfo?.symbol||'').toUpperCase())) continue;
        const recAmt = Number(r.value||0) / 10**(r.tokenInfo?.decimals||18);
        const recUSD = tokenUSD(r.tokenInfo?.symbol, recAmt, prices, chainId);
        const slip   = sentAmt - recUSD;
        if (slip > 0 && slip/sentAmt < 0.30) {
          totalSlippage += slip;
          slippageEvents.push({ date: tx.executionDate?.slice(0,10), tokenIn: s.tokenInfo?.symbol, tokenOut: r.tokenInfo?.symbol, sentUSD: sentAmt, recUSD, slippageUSD: slip });
        }
      }
    }
  }

  return { totalSlippageUSD: totalSlippage, slippageEvents };
}

// ── Entry point principale ────────────────────────────────────────────────

/**
 * Calcola tutte le statistiche on-chain per un vault.
 *
 * @param {string} safeAddress
 * @param {string} executorAddress
 * @param {number|string} chainId
 * @param {Array}  currentPositions — posizioni aperte dal reader
 * @param {number} vaultNowUSD      — valore attuale vault (idle + LP)
 * @param {string} cacheFile        — path file cache JSON
 * @returns {Object} stats completo
 */
async function computeOnchainStats(safeAddress, executorAddress, chainId, currentPositions, vaultNowUSD, cacheFile, posHistoryFile) {
  const CACHE_TTL = 10 * 60 * 1000;
  const chainCfg  = getChainConfig(chainId);

  // Carica cache
  let _cache = null;
  if (cacheFile && fs.existsSync(cacheFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (parsed?.computedAt && Date.now() - new Date(parsed.computedAt).getTime() < CACHE_TTL) {
        console.log(`[onchain-stats ${chainCfg.chainName}] Cache hit`);
        // Ricalcola valori dipendenti da vaultNow (cambia ad ogni ciclo)
        const feesPendingUSD = (currentPositions || []).reduce((s,p) => s + parseFloat(p.feesUSD || p.unclaimedUSD || 0), 0);
        const totalFeesLifetime = (parsed.totalFeesHarvestedUSD || 0) + feesPendingUSD;
        const pnlMtM = (vaultNowUSD || 0) - (parsed.totalDepositedUSD || 0);
        const pnlNettoReale = pnlMtM + totalFeesLifetime - (parsed.totalGasUSD || 0) - (parsed.totalSlippageUSD || 0);
        const roiPct = (parsed.totalDepositedUSD || 0) > 0 ? pnlNettoReale / parsed.totalDepositedUSD * 100 : 0;
        return { ...parsed, vaultNowUSD, feesPendingUSD, totalFeesLifetime, pnlMtM, pnlNettoReale, roiPct, roiOnChain: roiPct, fromCache: true };
      }
    } catch(e) {}
  }

  console.log(`[onchain-stats ${chainCfg.chainName}] Fetch Safe API...`);

  const [txs, allTransfers, prices] = await Promise.all([
    fetchAllMultisigTx(safeAddress, chainId),
    fetchAllTransfers(safeAddress, chainId),
    getPrices(),
  ]);

  const transfersByTx = groupTransfersByTx(allTransfers);
  const nftByTx       = groupNftTransfersByTx(allTransfers);
  const safeAddrLow   = safeAddress.toLowerCase();

  // Gas totale
  let totalGasWei = 0n;
  for (const tx of txs) totalGasWei += BigInt(tx.fee || 0);
  const nativePrice  = chainCfg.nativeToken === 'BNB' ? (prices.bnb || 600) : (prices.eth || 2000);
  const totalGasUSD  = Number(totalGasWei) / 1e18 * nativePrice;

  // Depositi
  const { totalDepositedUSD, deposits } = computeDeposits(allTransfers, safeAddrLow, executorAddress, chainId);

  // Deposited by token
  const depositedByToken = computeDepositedByToken(txs, transfersByTx, nftByTx, safeAddrLow, prices, chainId);
  console.log(`[onchain-stats ${chainCfg.chainName}] depositedByToken: ${Object.keys(depositedByToken).length} tokenId`);

  // Fee — usa positions_history.json se disponibile (fonte più affidabile: USD reale al momento del collect)
  let totalFeesHarvestedUSD, feesByTokenId, feeEvents;
  if (posHistoryFile) {
    let posHistData = {};
    try { posHistData = JSON.parse(fs.readFileSync(posHistoryFile, 'utf8')); } catch {}
    totalFeesHarvestedUSD = 0;
    feesByTokenId = {};
    feeEvents = [];
    for (const [tid, pos] of Object.entries(posHistData)) {
      const fees = parseFloat(pos.feesCollected || 0);
      if (fees > 0) {
        totalFeesHarvestedUSD += fees;
        feesByTokenId[String(tid)] = fees;
        feeEvents.push({ date: (pos.closedAt || pos.openedAt || '').slice(0, 10), tokenId: tid, feeUSD: fees });
      }
    }
    console.log(`[onchain-stats ${chainCfg.chainName}] fee da positions_history: $${totalFeesHarvestedUSD.toFixed(4)} (${feeEvents.length} eventi)`);
  } else {
    ({ totalFeesHarvestedUSD, feesByTokenId, feeEvents } = computeFees(
      txs, transfersByTx, depositedByToken, safeAddrLow, prices, chainId
    ));
  }

  // Fee pendenti
  const feesPendingUSD = (currentPositions || []).reduce((s,p) =>
    s + parseFloat(p.feesUSD || p.unclaimedUSD || 0), 0);
  const totalFeesLifetime = totalFeesHarvestedUSD + feesPendingUSD;

  // Slippage
  const { totalSlippageUSD, slippageEvents } = computeSlippage(
    txs, transfersByTx, safeAddrLow, prices, chainId
  );

  // PnL
  const pnlMtM        = (vaultNowUSD || 0) - totalDepositedUSD;
  const pnlNettoReale = pnlMtM + totalFeesLifetime - totalGasUSD - totalSlippageUSD;
  const roiPct        = totalDepositedUSD > 0 ? (pnlNettoReale / totalDepositedUSD * 100) : 0;

  // APR
  const firstDeposit = deposits.length > 0
    ? deposits.reduce((a,b) => new Date(a.date) < new Date(b.date) ? a : b) : null;
  const startDate    = firstDeposit ? new Date(firstDeposit.date) : new Date();
  const daysActive   = Math.max(1, (Date.now() - startDate.getTime()) / (1000*86400));
  const aprLifetime  = totalDepositedUSD > 0 ? (totalFeesLifetime / totalDepositedUSD / daysActive * 365 * 100) : 0;
  const lpValueUSD   = (currentPositions || []).reduce((s,p) => s + parseFloat(p.valueUSD || 0), 0);

  // Gas e slippage per tokenId — attribuzione reale da TX executor
  const { gasPerToken, slippagePerToken } = computeGasAndSlippagePerToken(
    txs, transfersByTx, nftByTx, safeAddrLow, prices, chainId
  );

  // positionStats per card posizioni
  const positionStats  = {};
  let aprPonderatoNum  = 0, aprPonderatoDen = 0;

  for (const p of (currentPositions || [])) {
    const tid         = String(p.tokenId);
    let depositedUSD  = depositedByToken[tid] || 0;
    if (!depositedUSD) {
      try {
        const db    = require(process.cwd() + '/src/database');
        const dbPos = db.db.prepare('SELECT depositedUSD FROM positions WHERE tokenId=?').get(tid);
        depositedUSD = dbPos?.depositedUSD || 0;
      } catch(e) {}
    }
    const feesHarvested = feesByTokenId[tid] || 0;
    const feesPendPos   = parseFloat(p.feesUSD || p.unclaimedUSD || 0);
    const feesTotal     = feesHarvested + feesPendPos;
    const currentVal    = parseFloat(p.valueUSD || 0);
    const gasQ          = gasPerToken[tid] || 0;
    const slipQ         = slippagePerToken[tid] || 0;
    const posMtM        = depositedUSD > 0 ? currentVal - depositedUSD : 0;
    const posPnlNetto   = posMtM + feesTotal - gasQ - slipQ;
    const posPnlPct     = depositedUSD > 0 ? (posPnlNetto / depositedUSD * 100) : 0;

    let openedAt = new Date();
    try {
      const db    = require(process.cwd() + '/src/database');
      const dbPos = db.db.prepare('SELECT openedAt FROM positions WHERE tokenId=?').get(tid);
      if (dbPos?.openedAt) openedAt = new Date(dbPos.openedAt);
    } catch(e) {}

    const posAgeDays = Math.max(0.5, (Date.now() - openedAt.getTime()) / (1000*86400));
    const aprBase    = depositedUSD > 0 ? depositedUSD : currentVal;
    const posApr     = aprBase > 0 ? (feesTotal / aprBase / posAgeDays * 365 * 100) : 0;

    if (currentVal > 0 && posApr > 0) { aprPonderatoNum += posApr * currentVal; aprPonderatoDen += currentVal; }

    positionStats[tid] = {
      tokenId: tid, depositedUSD, currentValueUSD: currentVal,
      feesHarvestedUSD: feesHarvested, feesPendingUSD: feesPendPos, feesTotalUSD: feesTotal,
      gasQuotaUSD: gasQ, slippageQuotaUSD: slipQ, posMtM, posPnlNetto, posPnlPct, posApr, posAgeDays,
      source: `onchain-stats-core-${chainCfg.chainName}`,
    };
  }

  const aprPonderato = aprPonderatoDen > 0 ? (aprPonderatoNum / aprPonderatoDen) : aprLifetime;
  const dailyYield   = totalDepositedUSD * (aprPonderato / 100) / 365;
  const monthlyYield = dailyYield * 30;

  const result = {
    source: `onchain_safe_api_core_${chainCfg.chainName.toLowerCase()}`,
    computedAt: new Date().toISOString(),
    totalDepositedUSD, deposits,
    totalGasUSD, totalFeesHarvestedUSD, feesPendingUSD, totalFeesLifetime,
    feeEvents, feesByTokenId, depositedByToken,
    totalSlippageUSD, slippageEvents,
    vaultNowUSD, pnlMtM, pnlNettoReale, roiPct, roiOnChain: roiPct,
    aprLifetime, aprPonderato, dailyYield, monthlyYield, daysActive, lpValueUSD,
    positionStats,
  };

  // Salva cache solo se vaultNow > 0 (evita cache con dati vuoti al restart)
  if (cacheFile && vaultNowUSD > 0) {
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(result, (k,v) => typeof v==='bigint'?v.toString():v), 'utf8');
      console.log(`[onchain-stats ${chainCfg.chainName}] Cache salvata`);
    } catch(e) {}
  }

  console.log(`[onchain-stats ${chainCfg.chainName}] ✅ depositi: $${totalDepositedUSD.toFixed(2)} | fee: $${totalFeesLifetime.toFixed(4)} | gas: $${totalGasUSD.toFixed(4)}`);
  return result;
}

module.exports = { computeOnchainStats, computeDeposits, computeDepositedByToken, computeFees, computeSlippage, computeGasAndSlippagePerToken, tokenUSD, getPrices };
