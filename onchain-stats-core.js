/**
 * token-registry.js — Kristal Auto Core
 *
 * Fonte unica di verità per indirizzi token per chain.
 * Usato da executor-core, onchain-stats-core, reader di ogni bot.
 */

const path = require('path');
const fs   = require('fs');

// Cache chain configs
const _configs = {};

function getChainConfig(chainIdOrName) {
  const key = String(chainIdOrName).toUpperCase();
  if (_configs[key]) return _configs[key];

  const nameMap = {
    '56': 'bnb', 'BNB': 'bnb',
    '42161': 'arb', 'ARB': 'arb',
    '8453': 'base', 'BASE': 'base',
    '1': 'eth', 'ETH': 'eth',
  };
  const fileName = nameMap[key];
  if (!fileName) throw new Error(`Chain non supportata: ${chainIdOrName}`);

  const configPath = path.join(__dirname, '..', 'chains', `${fileName}.json`);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  _configs[key] = config;
  _configs[String(config.chainId)] = config;
  _configs[config.chainName] = config;
  return config;
}

/**
 * Restituisce l'address di un token per chain.
 * @param {string} symbol — es. 'WETH', 'USDC'
 * @param {number|string} chainId — es. 42161, 'ARB'
 * @returns {string|null}
 */
function getTokenAddress(symbol, chainId) {
  const config = getChainConfig(chainId);
  const token = config.approvedTokens[(symbol || '').toUpperCase()];
  return token?.address || null;
}

/**
 * Verifica se un address è nella whitelist token approvati per chain.
 * @param {string} address
 * @param {number|string} chainId
 * @returns {boolean}
 */
function isApprovedToken(address, chainId) {
  const config = getChainConfig(chainId);
  const addr = (address || '').toLowerCase();
  return Object.values(config.approvedTokens).some(t =>
    t.address.toLowerCase() === addr
  );
}

/**
 * Restituisce il simbolo di un token dal suo address.
 * @param {string} address
 * @param {number|string} chainId
 * @returns {string|null}
 */
function getTokenSymbol(address, chainId) {
  const config = getChainConfig(chainId);
  const addr = (address || '').toLowerCase();
  for (const [sym, token] of Object.entries(config.approvedTokens)) {
    if (token.address.toLowerCase() === addr) return sym;
  }
  return null;
}

/**
 * Verifica se un token è una stablecoin per chain.
 */
function isStable(symbolOrAddress, chainId) {
  const config = getChainConfig(chainId);
  const upper = (symbolOrAddress || '').toUpperCase();
  // Prima prova per simbolo
  if (config.stables.includes(upper)) return true;
  // Poi per address
  const sym = getTokenSymbol(symbolOrAddress, chainId);
  if (sym && config.stables.includes(sym)) return true;
  return false;
}

/**
 * Restituisce fee tier override per swap verso targetToken su questa chain.
 * Usato da executor per WETH su BASE (fee:500 invece di fee:100).
 */
function getSwapFeeOverride(tokenAddress, chainId) {
  const config = getChainConfig(chainId);
  return config.swapFeeOverride[(tokenAddress || '').toLowerCase()] || null;
}

/**
 * Restituisce router override per swap verso targetToken su questa chain.
 * Usato da executor per WETH su BASE (Uniswap router invece di PancakeSwap).
 */
function getSwapRouterOverride(tokenAddress, chainId) {
  const config = getChainConfig(chainId);
  return config.swapRouterOverride[(tokenAddress || '').toLowerCase()] || null;
}

/**
 * Verifica se un pair è nella blockedPairs list per chain.
 */
function isBlockedPair(pair, chainId) {
  const config = getChainConfig(chainId);
  const p = (pair || '').toUpperCase();
  return (config.blockedPairs || []).some(bp => {
    const parts = bp.toUpperCase().split('/');
    return p.includes(parts[0]) && p.includes(parts[1]);
  });
}

/**
 * Restituisce tutti i token approvati per chain come Set di addresses lowercase.
 */
function getApprovedTokenSet(chainId) {
  const config = getChainConfig(chainId);
  return new Set(Object.values(config.approvedTokens).map(t => t.address.toLowerCase()));
}

module.exports = {
  getChainConfig,
  getTokenAddress,
  isApprovedToken,
  getTokenSymbol,
  isStable,
  getSwapFeeOverride,
  getSwapRouterOverride,
  isBlockedPair,
  getApprovedTokenSet,
};
