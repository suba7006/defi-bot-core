/**
 * token-registry.js — Kristal Auto Core
 * Fonte unica di verità per indirizzi token per chain.
 */

const path = require('path');
const fs   = require('fs');

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

function getTokenAddress(symbol, chainId) {
  const config = getChainConfig(chainId);
  const token = config.approvedTokens[(symbol || '').toUpperCase()];
  return token?.address || null;
}

function isApprovedToken(address, chainId) {
  const config = getChainConfig(chainId);
  const addr = (address || '').toLowerCase();
  return Object.values(config.approvedTokens).some(t =>
    t.address.toLowerCase() === addr
  );
}

function getTokenSymbol(address, chainId) {
  const config = getChainConfig(chainId);
  const addr = (address || '').toLowerCase();
  for (const [sym, token] of Object.entries(config.approvedTokens)) {
    if (token.address.toLowerCase() === addr) return sym;
  }
  return null;
}

function isStable(symbolOrAddress, chainId) {
  const config = getChainConfig(chainId);
  const upper = (symbolOrAddress || '').toUpperCase();
  if (config.stables.includes(upper)) return true;
  const sym = getTokenSymbol(symbolOrAddress, chainId);
  if (sym && config.stables.includes(sym)) return true;
  return false;
}

function getSwapFeeOverride(tokenAddress, chainId) {
  const config = getChainConfig(chainId);
  return config.swapFeeOverride[(tokenAddress || '').toLowerCase()] || null;
}

function getSwapRouterOverride(tokenAddress, chainId) {
  const config = getChainConfig(chainId);
  return config.swapRouterOverride[(tokenAddress || '').toLowerCase()] || null;
}

function isBlockedPair(pair, chainId) {
  const config = getChainConfig(chainId);
  const p = (pair || '').toUpperCase();
  return (config.blockedPairs || []).some(bp => {
    const parts = bp.toUpperCase().split('/');
    return p.includes(parts[0]) && p.includes(parts[1]);
  });
}

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
