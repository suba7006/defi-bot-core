/**
 * executor-core.js — Kristal Auto Core
 *
 * Modulo condiviso per operazioni executor su Safe Wallet.
 * Gestisce swap, approve, Safe TX per tutte le chain.
 *
 * Ogni bot estende questa classe con openPosition/closePosition
 * specifici per la propria chain.
 */

'use strict';

const { ethers } = require('ethers');
const { getChainConfig, getSwapFeeOverride, getSwapRouterOverride, isStable } = require('./token-registry');

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
];

const ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
];

const SAFE_ABI = [
  'function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes memory signatures) payable returns (bool success)',
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
];

class ExecutorCore {
  /**
   * @param {object} config — config del bot (SAFE_ADDRESS, BOT_PRIVATE_KEY, RPC_URL, etc.)
   * @param {number|string} chainId — es. 42161, 'ARB'
   */
  constructor(config, chainId) {
    this.config    = config;
    this.chainCfg  = getChainConfig(chainId);
    this.chainId   = this.chainCfg.chainId;
    this.provider  = new ethers.JsonRpcProvider(config.RPC_URL);
    this.botWallet = new ethers.Wallet(config.BOT_PRIVATE_KEY, this.provider);
    this.dryRun    = config.DRY_RUN || false;

    if (this.dryRun) console.log(`[ExecutorCore ${this.chainCfg.chainName}] DRY RUN MODE`);
  }

  // ── Router helpers ────────────────────────────────────────────────────────

  /**
   * Restituisce il router address per il dex specificato.
   * @param {string} dex — 'Uniswap' | 'PancakeSwap'
   * @param {string} [targetToken] — se specificato, controlla SWAP_ROUTER_OVERRIDE
   */
  _getSwapRouter(dex, targetToken) {
    const contracts = this.chainCfg.contracts;

    // Override per token specifici (es. WETH su BASE → sempre Uniswap)
    if (targetToken) {
      const override = getSwapRouterOverride(targetToken, this.chainId);
      if (override) {
        console.log(`[ExecutorCore] Router override: ${dex} → ${override} per token ${targetToken.slice(0,10)}`);
        dex = override;
      }
    }

    return ethers.getAddress(
      dex === 'PancakeSwap' ? contracts.pancakeV3Router : contracts.uniswapV3Router
    );
  }

  /**
   * Restituisce il fee tier corretto per swap verso targetToken.
   * @param {string} targetToken
   * @param {number} positionFeeTier
   */
  _getSwapFeeTier(targetToken, positionFeeTier) {
    const override = getSwapFeeOverride(targetToken, this.chainId);
    if (override) {
      console.log(`[ExecutorCore] Fee tier override: ${positionFeeTier} → ${override} per ${targetToken.slice(0,10)}`);
      return override;
    }
    return positionFeeTier;
  }

  // ── Slippage helper ───────────────────────────────────────────────────────

  _applySlippage(amount) {
    const slippage = this.config.MAX_SLIPPAGE || 0.02;
    const factor = BigInt(Math.floor((1 - slippage) * 10000));
    return amount * factor / 10000n;
  }

  // ── Token balance e swap ──────────────────────────────────────────────────

  /**
   * Assicura che il Safe abbia balance sufficiente di targetToken.
   * Se non sufficiente, esegue swap stable → targetToken.
   *
   * @param {string} targetToken  — address token da acquistare
   * @param {bigint} amountNeeded — quantità in wei necessaria
   * @param {number} dec          — decimali del token
   * @param {number} usdValue     — valore USD da swappare
   * @param {number} feeTier      — fee tier della posizione (può essere overridato)
   * @param {string} dex          — 'Uniswap' | 'PancakeSwap'
   */
  async _ensureTokenBalance(targetToken, amountNeeded, dec, usdValue, feeTier, dex) {
    const tContract = new ethers.Contract(targetToken, ERC20_ABI, this.provider);
    const bal = await tContract.balanceOf(this.config.SAFE_ADDRESS);
    if (bal >= amountNeeded) return; // già sufficiente

    const swapRouter  = this._getSwapRouter(dex, targetToken);
    const swapFeeTier = this._getSwapFeeTier(targetToken, feeTier);

    const chainStables = this.chainCfg.stables;
    const approvedTokens = this.chainCfg.approvedTokens;

    // Trova indirizzi stable della chain
    const stableAddresses = chainStables
      .map(s => approvedTokens[s]?.address?.toLowerCase())
      .filter(Boolean);

    const isTargetStable = stableAddresses.includes(targetToken.toLowerCase());

    if (isTargetStable) {
      // Swap stable → stable: sempre fee=100, indipendente dal fee tier della posizione
      const stableSwapFee = 100;
      const sourceStable = stableAddresses.find(a => a !== targetToken.toLowerCase());
      if (!sourceStable) return;
      const stableNeeded = ethers.parseUnits((usdValue * 1.02).toFixed(6), 6);
      const amountOutMin = 0n;
      console.log(`[ExecutorCore] Swap stable→stable $${usdValue.toFixed(2)} | router:${dex} | fee:${stableSwapFee}`);
      await this._approveIfNeeded(sourceStable, stableNeeded, swapRouter);
      const swapData = new ethers.Interface(ROUTER_ABI).encodeFunctionData('exactInputSingle', [{
        tokenIn: ethers.getAddress(sourceStable), tokenOut: ethers.getAddress(targetToken),
        fee: stableSwapFee, recipient: this.config.SAFE_ADDRESS,
        amountIn: stableNeeded, amountOutMinimum: amountOutMin, sqrtPriceLimitX96: 0n,
      }]);
      await this._executeSafeTx(swapRouter, swapData, 0n, 'swap_stable');
    } else {
      // Swap stable → token (es. USDC → WETH)
      // Scegli stable con balance maggiore
      let bestStable = null, bestBal = 0n;
      for (const stableAddr of stableAddresses) {
        try {
          const sc = new ethers.Contract(ethers.getAddress(stableAddr), ERC20_ABI, this.provider);
          const sb = await sc.balanceOf(this.config.SAFE_ADDRESS);
          if (sb > bestBal) { bestBal = sb; bestStable = stableAddr; }
        } catch(e) {}
      }
      if (!bestStable) return;

      const stableNeeded = ethers.parseUnits((usdValue * 1.02).toFixed(6), 6);
      const amountOutMin = 0n; // no sandwich risk sul mint
      console.log(`[ExecutorCore] Swap stable→token $${usdValue.toFixed(2)} (fee:${swapFeeTier}) | router:${dex}`);
      await this._approveIfNeeded(bestStable, stableNeeded, swapRouter);
      const swapData = new ethers.Interface(ROUTER_ABI).encodeFunctionData('exactInputSingle', [{
        tokenIn: ethers.getAddress(bestStable), tokenOut: ethers.getAddress(targetToken),
        fee: swapFeeTier, recipient: this.config.SAFE_ADDRESS,
        amountIn: stableNeeded, amountOutMinimum: amountOutMin, sqrtPriceLimitX96: 0n,
      }]);
      await this._executeSafeTx(swapRouter, swapData, 0n, 'swap_to_token');
    }
    const _postDelay = (this.chainCfg && this.chainCfg.postSwapDelay) || 3000;
    await new Promise(r => setTimeout(r, _postDelay));
    console.log('[ExecutorCore] Swap completato (delay ' + _postDelay + 'ms)');
  }

  // ── Approve ───────────────────────────────────────────────────────────────

  async _approveIfNeeded(tokenAddress, amount, spender) {
    const token     = new ethers.Contract(ethers.getAddress(tokenAddress), ERC20_ABI, this.provider);
    const allowance = await token.allowance(this.config.SAFE_ADDRESS, spender);
    if (allowance >= amount) return;
    console.log(`[ExecutorCore] Approve ${tokenAddress.slice(0,10)} → ${spender.slice(0,10)}`);
    const approveData = token.interface.encodeFunctionData('approve', [spender, ethers.MaxUint256]);
    await this._executeSafeTx(ethers.getAddress(tokenAddress), approveData, 0n, 'approve');
    console.log('[ExecutorCore] Approved');
  }

  // ── Safe TX ───────────────────────────────────────────────────────────────

  /**
   * Esegue una TX tramite il Safe multisig.
   * Firma con EIP-712 + v+4 adjustment per contract signature.
   */
  async _executeSafeTx(to, data, value = 0n, action = 'tx') {
    const safe  = new ethers.Contract(this.config.SAFE_ADDRESS, SAFE_ABI, this.botWallet);
    const nonce = await safe.nonce();

    const txHash = await safe.getTransactionHash(
      to, value, data, 0, 0n, 0n, 0n,
      ethers.ZeroAddress, ethers.ZeroAddress, nonce
    );

    const sig      = await this.botWallet.signMessage(ethers.getBytes(txHash));
    const sigBytes = ethers.getBytes(sig);
    sigBytes[64]   = sigBytes[64] + 4; // contract signature v+4
    const adjustedSig = ethers.hexlify(sigBytes);

    console.log(`[ExecutorCore] SafeTX nonce:${nonce} to:${to.slice(0,10)} action:${action}`);

    const tx = await safe.execTransaction(
      to, value, data, 0, 0n, 0n, 0n,
      ethers.ZeroAddress, ethers.ZeroAddress,
      adjustedSig, { gasLimit: 5000000 }
    );
    await tx.wait();

    // Salva gas nel DB se disponibile
    try {
      const db      = require('../../../src/database'); // path relativo al bot
      const receipt = await this.provider.getTransactionReceipt(tx.hash);
      if (receipt) {
        const gasUsed       = Number(receipt.gasUsed);
        const gasPrice      = Number(tx.gasPrice || receipt.effectiveGasPrice || 0n);
        const gasCostNative = (gasUsed * gasPrice) / 1e18;
        const nativePrice   = this.chainCfg.nativeToken === 'BNB' ? 600 : 2000;
        const gasCostUSD    = gasCostNative * nativePrice;
        db.saveGas(tx.hash, action, gasUsed, gasPrice.toString(), gasCostNative, gasCostUSD);
        console.log(`[ExecutorCore] Gas: ${gasUsed} | ${gasCostNative.toFixed(6)} ${this.chainCfg.nativeToken} | $${gasCostUSD.toFixed(4)}`);
      }
    } catch(e) { /* DB opzionale */ }

    return tx;
  }
}

module.exports = ExecutorCore;
