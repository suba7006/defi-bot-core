/**
 * executor-core.js — Kristal Auto Core
 * Logica executor condivisa per tutti i bot.
 * Estendi questa classe nel bot specifico con openPosition/closePosition.
 *
 * Fix inclusi:
 * - _getSwapRouter(dex): router corretto per dex
 * - SWAP_FEE_OVERRIDE: WETH usa fee:500 su ARB
 * - USDC skip swap: non tenta di comprare USDC
 * - amount0Min/amount1Min = 0n nell'increase
 */

const { ethers } = require('ethers');
const config = require('./config');
const { getTokenPrices, getTokenUsdPrice } = require('./prices');

const POSITION_MANAGER_ABI = [
  'function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) external payable returns (uint256 amount0, uint256 amount1)',
  'function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) external payable returns (uint256 amount0, uint256 amount1)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function increaseLiquidity((uint256 tokenId, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) external payable returns (uint128 liquidity, uint256 amount0, uint256 amount1)',
];

const ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
];

const POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function tickSpacing() view returns (int24)',
];

const FACTORY_ABI = [
  'function getPool(address,address,uint24) view returns (address)',
];

const SAFE_ABI = [
  'function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes memory signatures) payable returns (bool success)',
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
];

const UNISWAP_ROUTER = ethers.getAddress('0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45');
const PANCAKE_ROUTER  = ethers.getAddress('0x32226588378236fd0c7c4053999f88ac0e5cac77');

const USDT = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9';
const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const STABLE_POOL_FEE = 100;
const RANGE_BY_FEE = { 100: 0.06, 500: 0.10, 2500: 0.15, 10000: 0.20 };

// ✅ Fee override per swap: WETH su ARB usa pool fee:500 (più liquida)
const SWAP_FEE_OVERRIDE = {
  '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': 500, // WETH
};

function getSwapFeeTier(targetToken, positionFeeTier) {
  const override = SWAP_FEE_OVERRIDE[targetToken.toLowerCase()];
  if (override) {
    console.log(`[Executor] Fee override swap: ${positionFeeTier} → ${override} per ${targetToken.slice(0,10)}`);
    return override;
  }
  return positionFeeTier;
}
const ETH_PRICE_APPROX = 2000;

function applySlippage(amount) {
  const slippage = config.MAX_SLIPPAGE || 0.02;
  const factor = BigInt(Math.floor((1 - slippage) * 10000));
  return amount * factor / 10000n;
}

class ExecutorCore {
  constructor() {
    this.provider = new ethers.JsonRpcProvider(config.RPC_URL);
    this.botWallet = new ethers.Wallet(config.BOT_PRIVATE_KEY, this.provider);
    this.pancakeFactory = new ethers.Contract(config.PANCAKE_V3_FACTORY, FACTORY_ABI, this.provider);
    this.uniswapFactory = new ethers.Contract(config.UNISWAP_V3_FACTORY, FACTORY_ABI, this.provider);
    this.dryRun = config.DRY_RUN;
    if (this.dryRun) console.log('[Executor] DRY RUN MODE attivo');
  }

  async _resolveDex(poolAddress, token0, token1, fee) {
    try { const p = await this.pancakeFactory.getPool(token0, token1, fee); if (p && p.toLowerCase() === poolAddress.toLowerCase()) return 'PancakeSwap'; } catch(e) {}
    try { const p = await this.uniswapFactory.getPool(token0, token1, fee); if (p && p.toLowerCase() === poolAddress.toLowerCase()) return 'Uniswap'; } catch(e) {}
    try { const p = await this.pancakeFactory.getPool(token1, token0, fee); if (p && p.toLowerCase() === poolAddress.toLowerCase()) return 'PancakeSwap'; } catch(e) {}
    try { const p = await this.uniswapFactory.getPool(token1, token0, fee); if (p && p.toLowerCase() === poolAddress.toLowerCase()) return 'Uniswap'; } catch(e) {}
    return 'Uniswap';
  }

  _getPMAddress(dex) {
    return dex === 'PancakeSwap' ? config.PANCAKE_V3_POSITION_MANAGER : config.UNISWAP_V3_POSITION_MANAGER;
  }

  // ✅ FIX: accetta dex come parametro
  _getSwapRouter(dex) {
    return dex === 'PancakeSwap' ? PANCAKE_ROUTER : UNISWAP_ROUTER;
  }

  async _resolvePMForToken(tokenId, expectedDex, expectedToken0, expectedToken1) {
    const pmPancakeAddr = config.PANCAKE_V3_POSITION_MANAGER;
    const pmUniAddr = config.UNISWAP_V3_POSITION_MANAGER;

    if (expectedDex === 'Uniswap') {
      const pm = new ethers.Contract(pmUniAddr, POSITION_MANAGER_ABI, this.provider);
      try { const pos = await pm.positions(tokenId); if (pos.liquidity === 0n) return { pos, dex: 'Uniswap', pmAddress: pmUniAddr, alreadyClosed: true }; return { pos, dex: 'Uniswap', pmAddress: pmUniAddr }; } catch(e) { return { pos: null, dex: 'Uniswap', pmAddress: pmUniAddr, alreadyClosed: true }; }
    }
    if (expectedDex === 'PancakeSwap') {
      const pm = new ethers.Contract(pmPancakeAddr, POSITION_MANAGER_ABI, this.provider);
      try { const pos = await pm.positions(tokenId); if (pos.liquidity === 0n) return { pos, dex: 'PancakeSwap', pmAddress: pmPancakeAddr, alreadyClosed: true }; return { pos, dex: 'PancakeSwap', pmAddress: pmPancakeAddr }; } catch(e) { return { pos: null, dex: 'PancakeSwap', pmAddress: pmPancakeAddr, alreadyClosed: true }; }
    }

    const [pmPancake, pmUni] = [
      new ethers.Contract(pmPancakeAddr, POSITION_MANAGER_ABI, this.provider),
      new ethers.Contract(pmUniAddr, POSITION_MANAGER_ABI, this.provider),
    ];
    const [posCake, posUni] = await Promise.all([
      pmPancake.positions(tokenId).catch(() => null),
      pmUni.positions(tokenId).catch(() => null),
    ]);

    if (expectedToken0 && expectedToken1) {
      const t0 = expectedToken0.toLowerCase(), t1 = expectedToken1.toLowerCase();
      if (posUni && posUni.liquidity > 0n && posUni.token0.toLowerCase() === t0 && posUni.token1.toLowerCase() === t1) return { pos: posUni, dex: 'Uniswap', pmAddress: pmUniAddr };
      if (posCake && posCake.liquidity > 0n && posCake.token0.toLowerCase() === t0 && posCake.token1.toLowerCase() === t1) return { pos: posCake, dex: 'PancakeSwap', pmAddress: pmPancakeAddr };
    }

    if (posUni && posUni.liquidity > 0n) return { pos: posUni, dex: 'Uniswap', pmAddress: pmUniAddr };
    if (posCake && posCake.liquidity > 0n) return { pos: posCake, dex: 'PancakeSwap', pmAddress: pmPancakeAddr };
    return { pos: posUni || posCake, dex: 'Uniswap', pmAddress: pmUniAddr, alreadyClosed: true };
  }

  async _ensureTokenBalance(targetToken, amountNeeded, dec, usdValue, feeTier, dex) {
    const tContract = new ethers.Contract(targetToken, ERC20_ABI, this.provider);
    const bal = await tContract.balanceOf(config.SAFE_ADDRESS);
    if (bal >= amountNeeded) return;
    // ✅ FIX: se target è USDC e non c'è abbastanza, usa quello che c'è — no swap
    if (targetToken.toLowerCase() === USDC.toLowerCase()) { console.log('[Executor] USDC insufficiente — uso balance disponibile'); return; }

    // ✅ FIX: usa dex per scegliere il router corretto
    const swapRouter = this._getSwapRouter(dex);
    const isTargetUsdt = targetToken.toLowerCase() === USDT.toLowerCase();
    const isTargetUsdc = targetToken.toLowerCase() === USDC.toLowerCase();

    if (isTargetUsdt || isTargetUsdc) {
      const sourceStable = isTargetUsdt ? USDC : USDT;
      const stableNeeded = ethers.parseUnits((usdValue * 1.02).toFixed(6), 6);
      const amountOutMin = applySlippage(stableNeeded);
      console.log(`[Executor] Swap stable→stable $${usdValue.toFixed(2)} | minOut:${ethers.formatUnits(amountOutMin,6)}`);
      await this._approveIfNeeded(sourceStable, stableNeeded, swapRouter);
      const swapData = new ethers.Interface(ROUTER_ABI).encodeFunctionData('exactInputSingle', [{
        tokenIn: sourceStable, tokenOut: targetToken, fee: STABLE_POOL_FEE,
        recipient: config.SAFE_ADDRESS, amountIn: stableNeeded,
        amountOutMinimum: amountOutMin, sqrtPriceLimitX96: 0n,
      }]);
      await this._executeSafeTx(swapRouter, swapData, 0n, 'swap_stable');
    } else {
      const usdcC = new ethers.Contract(USDC, ERC20_ABI, this.provider);
      const usdtC = new ethers.Contract(USDT, ERC20_ABI, this.provider);
      const [bU, bT] = await Promise.all([usdcC.balanceOf(config.SAFE_ADDRESS), usdtC.balanceOf(config.SAFE_ADDRESS)]);
      const stable = bU >= bT ? USDC : USDT;
      const stableNeeded = ethers.parseUnits((usdValue * 1.02).toFixed(6), 6);
      const amountOutMin = applySlippage(amountNeeded);
      const swapFeeTier = getSwapFeeTier(targetToken, feeTier);
      console.log(`[Executor] Swap stable→token $${usdValue.toFixed(2)} (fee:${swapFeeTier}) router:${dex} | minOut:${ethers.formatUnits(amountOutMin,dec)}`);
      await this._approveIfNeeded(stable, stableNeeded, swapRouter);
      const swapData = new ethers.Interface(ROUTER_ABI).encodeFunctionData('exactInputSingle', [{
        tokenIn: stable, tokenOut: targetToken, fee: swapFeeTier,
        recipient: config.SAFE_ADDRESS, amountIn: stableNeeded,
        amountOutMinimum: amountOutMin, sqrtPriceLimitX96: 0n,
      }]);
      await this._executeSafeTx(swapRouter, swapData, 0n, 'swap_to_token');
    }
    console.log('[Executor] Swap completato');
  }

  async openPosition(params) {
    const { feeTierRaw, amountUSD, pair } = params;
    const poolAddress   = params.poolAddress   ? ethers.getAddress(params.poolAddress.toLowerCase())   : params.poolAddress;
    const token0Address = params.token0Address ? ethers.getAddress(params.token0Address.toLowerCase()) : params.token0Address;
    const token1Address = params.token1Address ? ethers.getAddress(params.token1Address.toLowerCase()) : params.token1Address;
    let dex = params.dex || null;
    if (!dex || (dex !== 'PancakeSwap' && dex !== 'Uniswap')) {
      dex = await this._resolveDex(poolAddress, token0Address, token1Address, feeTierRaw);
    }
    const pmAddress = this._getPMAddress(dex);
    const rangeTotal = params.rangeWidth || RANGE_BY_FEE[feeTierRaw] || 0.10;
    const rangeDown = params.rangeDown || (rangeTotal / 2);
    const rangeUp   = params.rangeUp   || (rangeTotal / 2);
    const ticksDown = Math.ceil(rangeDown / Math.log(1.0001));
    const ticksUp   = Math.ceil(rangeUp   / Math.log(1.0001));

    console.log(`[Executor] Apertura ${pair} $${amountUSD} su ${dex} | PM:${pmAddress.slice(0,10)}`);
    if (amountUSD > config.MAX_TX_VALUE_USD) throw new Error('Importo supera limite MAX_TX_VALUE_USD');

    try {
      const pool = new ethers.Contract(poolAddress, POOL_ABI, this.provider);
      const [slot0, tickSpacing] = await Promise.all([pool.slot0(), pool.tickSpacing()]);
      const currentTick = Number(slot0[1]);
      const spacing = Number(tickSpacing);
      const tickLower = Math.floor((currentTick - ticksDown) / spacing) * spacing;
      const tickUpper = Math.ceil((currentTick + ticksUp) / spacing) * spacing;

      const t0 = new ethers.Contract(token0Address, ERC20_ABI, this.provider);
      const t1 = new ethers.Contract(token1Address, ERC20_ABI, this.provider);
      const [dec0, dec1] = await Promise.all([t0.decimals(), t1.decimals()]);

      const prices = await getTokenPrices();
      const price0 = getTokenUsdPrice(token0Address, prices);
      const price1 = getTokenUsdPrice(token1Address, prices);
      if (!price0 || !price1) throw new Error(`Prezzo non disponibile: p0=${price0} p1=${price1}`);

      const half = amountUSD / 2;
      const amount0 = ethers.parseUnits((half / price0).toFixed(Math.min(8, Number(dec0))), dec0);
      const amount1 = ethers.parseUnits((half / price1).toFixed(Math.min(8, Number(dec1))), dec1);
      const deadline = Math.floor(Date.now() / 1000) + 300;

      if (this.dryRun) { console.log(`[Executor] DRY RUN mint ${pair}`); return { success: true, dryRun: true, tokenId: 'DRY_RUN' }; }

      // ✅ FIX: passa dex a _ensureTokenBalance
      await this._ensureTokenBalance(token0Address, amount0, Number(dec0), half, feeTierRaw, dex);
      await this._ensureTokenBalance(token1Address, amount1, Number(dec1), half, feeTierRaw, dex);

      const bal0Final = await t0.balanceOf(config.SAFE_ADDRESS);
      const bal1Final = await t1.balanceOf(config.SAFE_ADDRESS);
      const amount0Final = bal0Final < amount0 ? bal0Final : amount0;
      const amount1Final = bal1Final < amount1 ? bal1Final : amount1;

      await this._approveIfNeeded(token0Address, amount0Final, pmAddress);
      await this._approveIfNeeded(token1Address, amount1Final, pmAddress);

      const amount0Min = applySlippage(amount0Final);
      const amount1Min = applySlippage(amount1Final);

      const pm = new ethers.Contract(pmAddress, POSITION_MANAGER_ABI, this.botWallet);
      const mintData = pm.interface.encodeFunctionData('mint', [{
        token0: token0Address, token1: token1Address, fee: feeTierRaw,
        tickLower, tickUpper,
        amount0Desired: amount0Final, amount1Desired: amount1Final,
        amount0Min, amount1Min,
        recipient: config.SAFE_ADDRESS, deadline,
      }]);
      const tx = await this._executeSafeTx(pmAddress, mintData, 0n, 'open_position');
      console.log(`[Executor] Posizione aperta TX: ${tx.hash} su ${dex}`);
      return { success: true, txHash: tx.hash, dex };
    } catch(e) {
      console.error('[Executor] openPosition error:', e.message);
      return { success: false, error: e.message };
    }
  }

  async increasePosition(tokenId, amountUSD) {
    console.log(`[Executor] Increase #${tokenId} $${amountUSD}`);
    try {
      let expectedDex = null, expectedToken0 = null, expectedToken1 = null;
      try { const db = require('./database'); const dbPos = db.getOpenPositions().find(p => String(p.tokenId) === String(tokenId)); if (dbPos) { expectedDex = dbPos.dex || null; expectedToken0 = dbPos.token0Address || null; expectedToken1 = dbPos.token1Address || null; } } catch(e) {}

      const { pos, dex, pmAddress, alreadyClosed } = await this._resolvePMForToken(tokenId, expectedDex, expectedToken0, expectedToken1);
      if (alreadyClosed) return { success: true, alreadyClosed: true };

      const t0 = new ethers.Contract(pos.token0, ERC20_ABI, this.provider);
      const t1 = new ethers.Contract(pos.token1, ERC20_ABI, this.provider);
      const [dec0, dec1] = await Promise.all([t0.decimals(), t1.decimals()]);
      const prices = await getTokenPrices();
      const price0 = getTokenUsdPrice(pos.token0, prices);
      const price1 = getTokenUsdPrice(pos.token1, prices);
      if (!price0 || !price1) throw new Error(`Prezzo non disponibile: p0=${price0} p1=${price1}`);

      const half = amountUSD / 2;
      const amount0 = ethers.parseUnits((half / price0).toFixed(Math.min(8, Number(dec0))), dec0);
      const amount1 = ethers.parseUnits((half / price1).toFixed(Math.min(8, Number(dec1))), dec1);
      const deadline = Math.floor(Date.now() / 1000) + 300;

      if (this.dryRun) return { success: true, dryRun: true };

      // ✅ FIX: passa dex a _ensureTokenBalance
      await this._ensureTokenBalance(pos.token0, amount0, Number(dec0), half, pos.fee, dex);
      await this._ensureTokenBalance(pos.token1, amount1, Number(dec1), half, pos.fee, dex);

      const bal0Final = await t0.balanceOf(config.SAFE_ADDRESS);
      const bal1Final = await t1.balanceOf(config.SAFE_ADDRESS);
      const amount0Final = bal0Final < amount0 ? bal0Final : amount0;
      const amount1Final = bal1Final < amount1 ? bal1Final : amount1;

      await this._approveIfNeeded(pos.token0, amount0Final, pmAddress);
      await this._approveIfNeeded(pos.token1, amount1Final, pmAddress);

      const amount0Min = 0n; // ✅ FIX: no slippage su increase — evita revert dopo swap
      const amount1Min = 0n;

      const pm = new ethers.Contract(pmAddress, POSITION_MANAGER_ABI, this.botWallet);
      const increaseData = pm.interface.encodeFunctionData('increaseLiquidity', [{
        tokenId, amount0Desired: amount0Final, amount1Desired: amount1Final,
        amount0Min, amount1Min, deadline,
      }]);
      const tx = await this._executeSafeTx(pmAddress, increaseData, 0n, 'increase_position');
      console.log(`[Executor] Increased TX: ${tx.hash} su ${dex}`);
      return { success: true, txHash: tx.hash };
    } catch(e) {
      console.error('[Executor] increasePosition error:', e.message);
      return { success: false, error: e.message };
    }
  }

  async closePosition(tokenId) {
    console.log(`[Executor] Chiusura #${tokenId}`);
    try {
      let expectedDex = null, expectedToken0 = null, expectedToken1 = null;
      try { const db = require('./database'); const dbPos = db.getOpenPositions().find(p => String(p.tokenId) === String(tokenId)); if (dbPos) { expectedDex = dbPos.dex || null; expectedToken0 = dbPos.token0Address || null; expectedToken1 = dbPos.token1Address || null; } } catch(e) {}

      const { pos, dex, pmAddress, alreadyClosed } = await this._resolvePMForToken(tokenId, expectedDex, expectedToken0, expectedToken1);
      if (alreadyClosed) { console.log(`[Executor] Posizione #${tokenId} già chiusa`); return { success: true, alreadyClosed: true }; }

      const swapRouter = this._getSwapRouter(dex);
      const deadline = Math.floor(Date.now() / 1000) + 300;
      if (this.dryRun) return { success: true, dryRun: true };

      const pm = new ethers.Contract(pmAddress, POSITION_MANAGER_ABI, this.botWallet);

      const decreaseData = pm.interface.encodeFunctionData('decreaseLiquidity', [{
        tokenId, liquidity: pos.liquidity, amount0Min: 0n, amount1Min: 0n, deadline,
      }]);
      const txDecrease = await this._executeSafeTx(pmAddress, decreaseData, 0n, 'decrease_liquidity');

      const collectData = pm.interface.encodeFunctionData('collect', [{
        tokenId, recipient: config.SAFE_ADDRESS,
        amount0Max: BigInt('340282366920938463463374607431768211455'),
        amount1Max: BigInt('340282366920938463463374607431768211455'),
      }]);
      await this._executeSafeTx(pmAddress, collectData, 0n, 'collect_fees');

      const t0 = new ethers.Contract(pos.token0, ERC20_ABI, this.provider);
      const t1 = new ethers.Contract(pos.token1, ERC20_ABI, this.provider);
      const [bal0, bal1] = await Promise.all([t0.balanceOf(config.SAFE_ADDRESS), t1.balanceOf(config.SAFE_ADDRESS)]);

      if (pos.token0.toLowerCase() !== USDT.toLowerCase() && pos.token0.toLowerCase() !== USDC.toLowerCase() && bal0 > 0n) {
        await this._approveIfNeeded(pos.token0, bal0, swapRouter);
        const swapData = new ethers.Interface(ROUTER_ABI).encodeFunctionData('exactInputSingle', [{
          tokenIn: pos.token0, tokenOut: USDC, fee: pos.fee,
          recipient: config.SAFE_ADDRESS, amountIn: bal0,
          amountOutMinimum: applySlippage(bal0), sqrtPriceLimitX96: 0n,
        }]);
        await this._executeSafeTx(swapRouter, swapData, 0n, 'swap_to_usdc');
      }
      if (pos.token1.toLowerCase() !== USDT.toLowerCase() && pos.token1.toLowerCase() !== USDC.toLowerCase() && bal1 > 0n) {
        await this._approveIfNeeded(pos.token1, bal1, swapRouter);
        const swapData = new ethers.Interface(ROUTER_ABI).encodeFunctionData('exactInputSingle', [{
          tokenIn: pos.token1, tokenOut: USDC, fee: pos.fee,
          recipient: config.SAFE_ADDRESS, amountIn: bal1,
          amountOutMinimum: applySlippage(bal1), sqrtPriceLimitX96: 0n,
        }]);
        await this._executeSafeTx(swapRouter, swapData, 0n, 'swap_to_usdc');
      }
      if (pos.token0.toLowerCase() === USDT.toLowerCase() && bal0 > 0n) {
        await this._approveIfNeeded(pos.token0, bal0, swapRouter);
        const swapData = new ethers.Interface(ROUTER_ABI).encodeFunctionData('exactInputSingle', [{
          tokenIn: USDT, tokenOut: USDC, fee: STABLE_POOL_FEE,
          recipient: config.SAFE_ADDRESS, amountIn: bal0,
          amountOutMinimum: applySlippage(bal0), sqrtPriceLimitX96: 0n,
        }]);
        await this._executeSafeTx(swapRouter, swapData, 0n, 'usdt_to_usdc');
      }
      if (pos.token1.toLowerCase() === USDT.toLowerCase() && bal1 > 0n) {
        await this._approveIfNeeded(pos.token1, bal1, swapRouter);
        const swapData = new ethers.Interface(ROUTER_ABI).encodeFunctionData('exactInputSingle', [{
          tokenIn: USDT, tokenOut: USDC, fee: STABLE_POOL_FEE,
          recipient: config.SAFE_ADDRESS, amountIn: bal1,
          amountOutMinimum: applySlippage(bal1), sqrtPriceLimitX96: 0n,
        }]);
        await this._executeSafeTx(swapRouter, swapData, 0n, 'usdt_to_usdc');
      }

      console.log(`[Executor] Posizione #${tokenId} chiusa su ${dex}`);
      return { success: true, txHash: txDecrease.hash };
    } catch(e) {
      console.error('[Executor] closePosition error:', e.message);
      return { success: false, error: e.message };
    }
  }

  async collectFees(tokenId) {
    if (this.dryRun) return { success: true, dryRun: true };
    try {
      let expectedDex = null, expectedToken0 = null, expectedToken1 = null;
      try { const db = require('./database'); const dbPos = db.getOpenPositions().find(p => String(p.tokenId) === String(tokenId)); if (dbPos) { expectedDex = dbPos.dex || null; expectedToken0 = dbPos.token0Address || null; expectedToken1 = dbPos.token1Address || null; } } catch(e) {}
      const { pmAddress, alreadyClosed } = await this._resolvePMForToken(tokenId, expectedDex, expectedToken0, expectedToken1);
      if (alreadyClosed) return { success: true, alreadyClosed: true };
      const pm = new ethers.Contract(pmAddress, POSITION_MANAGER_ABI, this.botWallet);
      const collectData = pm.interface.encodeFunctionData('collect', [{
        tokenId, recipient: config.SAFE_ADDRESS,
        amount0Max: BigInt('340282366920938463463374607431768211455'),
        amount1Max: BigInt('340282366920938463463374607431768211455'),
      }]);
      const tx = await this._executeSafeTx(pmAddress, collectData, 0n, 'collect_fees');
      return { success: true, txHash: tx.hash };
    } catch(e) { return { success: false, error: e.message }; }
  }

  async _executeSafeTx(to, data, value, action = 'tx') {
    const safe = new ethers.Contract(config.SAFE_ADDRESS, SAFE_ABI, this.botWallet);
    const nonce = await safe.nonce();
    const txHash = await safe.getTransactionHash(to, value, data, 0, 0n, 0n, 0n, ethers.ZeroAddress, ethers.ZeroAddress, nonce);
    const sig = await this.botWallet.signMessage(ethers.getBytes(txHash));
    const sigBytes = ethers.getBytes(sig);
    sigBytes[64] = sigBytes[64] + 4;
    const adjustedSig = ethers.hexlify(sigBytes);
    console.log(`[Executor] SafeTX nonce:${nonce} to:${to.slice(0,10)} action:${action}`);
    const tx = await safe.execTransaction(to, value, data, 0, 0n, 0n, 0n, ethers.ZeroAddress, ethers.ZeroAddress, adjustedSig, { gasLimit: 5000000 });
    await tx.wait();
    try {
      const db = require('./database');
      const receipt = await this.provider.getTransactionReceipt(tx.hash);
      if (receipt) {
        const gasUsed = Number(receipt.gasUsed);
        const gasPrice = Number(tx.gasPrice || receipt.effectiveGasPrice || 0n);
        const gasCostNative = (gasUsed * gasPrice) / 1e18;
        let ethPrice = ETH_PRICE_APPROX;
        try { const prices = await getTokenPrices(); ethPrice = prices.weth || ETH_PRICE_APPROX; } catch(e) {}
        const gasCostUSD = gasCostNative * ethPrice;
        db.saveGas(tx.hash, action, gasUsed, gasPrice.toString(), gasCostNative, gasCostUSD);
        console.log(`[Executor] Gas: ${gasUsed} | ${gasCostNative.toFixed(6)} ETH | $${gasCostUSD.toFixed(4)}`);
      }
    } catch(e) { console.log('[Executor] saveGas error:', e.message); }
    return tx;
  }

  async _approveIfNeeded(tokenAddress, amount, spender) {
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);
    const allowance = await token.allowance(config.SAFE_ADDRESS, spender);
    if (allowance < amount) {
      console.log(`[Executor] Approve ${tokenAddress.slice(0,10)} → ${spender.slice(0,10)}`);
      const approveData = token.interface.encodeFunctionData('approve', [spender, ethers.MaxUint256]);
      await this._executeSafeTx(tokenAddress, approveData, 0n, 'approve');
      console.log('[Executor] Approved!');
    }
  }
}

module.exports = ExecutorCore;
