/**
 * safe-api.js — Kristal Auto Core
 *
 * Helper unificato per fetch Safe Transaction Service API.
 * Gestisce retry, rate limiting, paginazione per tutte le chain.
 */

const axios = require('axios');
const { getChainConfig } = require('./token-registry');

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Fetch con retry automatico su 429 e timeout.
 */
async function fetchWithRetry(url, maxRetries = 3, headers = {}) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await axios.get(url, {
        timeout: 20000,
        headers: { 'Content-Type': 'application/json', ...headers },
      });
    } catch (e) {
      if (e.response?.status === 429 && attempt < maxRetries) {
        await sleep(attempt * 2000);
        continue;
      }
      throw e;
    }
  }
}

/**
 * Fetch tutte le pagine di una Safe API endpoint con paginazione.
 * @param {string} baseUrl — URL con parametri già inclusi
 * @param {number} delayMs — delay tra pagine (evita rate limit)
 * @returns {Array}
 */
async function fetchAllPages(baseUrl, delayMs = 300) {
  const results = [];
  let url = baseUrl;
  let page = 0;
  while (url) {
    if (page > 0) await sleep(delayMs);
    const res = await fetchWithRetry(url);
    results.push(...(res.data.results || []));
    url = res.data.next || null;
    page++;
  }
  return results;
}

/**
 * Fetch tutti i multisig transactions eseguiti con successo.
 * @param {string} safeAddress
 * @param {number|string} chainId
 * @returns {Array}
 */
async function fetchAllMultisigTx(safeAddress, chainId) {
  const config = getChainConfig(chainId);
  const base = config.safeApiTxService;
  const url = `${base}/api/v1/safes/${safeAddress}/multisig-transactions/?limit=100&ordering=executionDate`;
  const all = await fetchAllPages(url);
  const filtered = all.filter(t => t.isExecuted && t.isSuccessful);
  console.log(`[safe-api ${config.chainName}] ${filtered.length} TX eseguite`);
  return filtered;
}

/**
 * Fetch tutti i transfer (ERC20, ERC721, ETH nativo).
 * @param {string} safeAddress
 * @param {number|string} chainId
 * @returns {Array}
 */
async function fetchAllTransfers(safeAddress, chainId) {
  const config = getChainConfig(chainId);
  const base = config.safeApiTxService;
  const url = `${base}/api/v1/safes/${safeAddress}/transfers/?limit=100&ordering=executionDate`;
  const all = await fetchAllPages(url);
  console.log(`[safe-api ${config.chainName}] ${all.length} transfers`);
  return all;
}

/**
 * Fetch balance Safe (token + ETH nativo).
 * @param {string} safeAddress
 * @param {number|string} chainId
 * @returns {Array}
 */
async function fetchSafeBalances(safeAddress, chainId) {
  const config = getChainConfig(chainId);
  const base = config.safeApiBase;
  const url = `${base}/api/v1/safes/${safeAddress}/balances/?trusted=false&exclude_spam=true`;
  const res = await fetchWithRetry(url);
  return res.data || [];
}

/**
 * Raggruppa transfers per txHash per lookup rapido O(1).
 * @param {Array} transfers
 * @returns {Object} map txHash → Array<transfer>
 */
function groupTransfersByTx(transfers) {
  const map = {};
  for (const t of transfers) {
    if (!t.transactionHash) continue;
    if (!map[t.transactionHash]) map[t.transactionHash] = [];
    map[t.transactionHash].push(t);
  }
  return map;
}

/**
 * Raggruppa NFT ERC721 transfers per txHash.
 */
function groupNftTransfersByTx(transfers) {
  const map = {};
  for (const t of transfers) {
    if (t.type !== 'ERC721_TRANSFER') continue;
    if (!t.transactionHash) continue;
    if (!map[t.transactionHash]) map[t.transactionHash] = [];
    map[t.transactionHash].push(t);
  }
  return map;
}

/**
 * Costruisce il Set di indirizzi outgoing dal Safe.
 * Tutti gli indirizzi che hanno ricevuto token DAL Safe sono
 * router/PM/aggregatori — non possono essere depositor esterni.
 *
 * @param {Array} allTransfers
 * @param {string} safeAddr — lowercase
 * @param {string} executorAddr — lowercase
 * @returns {Set<string>}
 */
function buildOutgoingRecipients(allTransfers, safeAddr, executorAddr) {
  const set = new Set();
  for (const t of allTransfers) {
    if ((t.from || '').toLowerCase() !== safeAddr.toLowerCase()) continue;
    set.add((t.to || '').toLowerCase());
  }
  set.add(executorAddr.toLowerCase());
  return set;
}

module.exports = {
  fetchWithRetry,
  fetchAllPages,
  fetchAllMultisigTx,
  fetchAllTransfers,
  fetchSafeBalances,
  groupTransfersByTx,
  groupNftTransfersByTx,
  buildOutgoingRecipients,
};
