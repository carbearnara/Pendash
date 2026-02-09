// Pendash - Pendle Calculator with Live Market Data

const PENDLE_FEE = 0.05; // 5% fee on YT yield
const API_BASE = 'https://api-v2.pendle.finance/core';

// Aave V3 GraphQL Subgraph endpoints by chain
const AAVE_SUBGRAPHS = {
    1: 'https://api.thegraph.com/subgraphs/name/aave/protocol-v3',
    42161: 'https://api.thegraph.com/subgraphs/name/aave/protocol-v3-arbitrum',
};

// Morpho Blue API endpoint
const MORPHO_API = 'https://blue-api.morpho.org/graphql';

// Cache for lending markets data (5 minute TTL)
const lendingMarketsCache = {
    aave: new Map(),
    morpho: new Map(),
    lastFetch: 0,
    TTL: 5 * 60 * 1000 // 5 minutes
};

// Multiple CORS proxy options to try
const CORS_PROXIES = [
    (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
    (url) => `https://cors-anywhere.herokuapp.com/${url}`,
];

// RPC endpoints for different chains
const RPC_ENDPOINTS = {
    1: 'https://eth.llamarpc.com',
    42161: 'https://arb1.arbitrum.io/rpc',
    8453: 'https://mainnet.base.org',
    56: 'https://bsc-dataseed.binance.org',
    146: 'https://rpc.soniclabs.com',
    999: 'https://rpc.hyperliquid.xyz/evm',
    9745: 'https://rpc.berachain.com',
};

// Minimal ABIs for watermark checking
const SY_ABI = ['function exchangeRate() view returns (uint256)'];
const YT_ABI = ['function pyIndexStored() view returns (uint256)', 'function SY() view returns (address)'];

// Extended ABIs for detailed watermark info
const YT_EXTENDED_ABI = [
    'function pyIndexStored() view returns (uint256)',
    'function SY() view returns (address)',
    'function pyIndexCurrent() view returns (uint256)',
    'function expiry() view returns (uint256)'
];

// Cache for watermark status
const watermarkCache = new Map();

// Cache for watermark history
const watermarkHistoryCache = new Map();

// Known historical watermark events (documented incidents)
const KNOWN_WATERMARK_EVENTS = [
    {
        date: '2025-03-12',
        asset: 'HLP',
        event: 'Whale liquidation caused $4M loss to HLP vault',
        impact: 'Exchange rate dropped, potential below-watermark period',
        source: 'https://www.coindesk.com/markets/2025/03/12/hyperliquid-loses-usd4m-after-whale-s-over-usd200m-ether-trade-unwinds'
    },
    {
        date: '2025-12-31',
        asset: 'HLPe',
        chain: 999,
        event: 'HLPe yield dropped to 0% - 100% yield reduction',
        impact: 'Near-zero yield period detected, likely below watermark',
        yieldBefore: 0.60,
        yieldAfter: 0.00,
        source: 'Pendle historical data analysis'
    },
    {
        date: '2026-01-26',
        asset: 'hwHLP',
        chain: 999,
        event: 'hwHLP yield crashed 96% in single day',
        impact: 'Yield dropped from 13.39% to 0.54%, significant exchange rate impact',
        yieldBefore: 13.39,
        yieldAfter: 0.54,
        source: 'Pendle historical data analysis'
    },
    {
        date: '2026-01-28',
        asset: 'WHLP',
        chain: 999,
        event: 'WHLP yield crashed 75.7% followed by near-zero period',
        impact: 'Near-zero yield period Jan 28-30, 2026. Multiple days below watermark threshold',
        yieldBefore: 4.89,
        yieldAfter: 1.19,
        source: 'Pendle historical data analysis'
    }
];

// Cache for historical data
const historyCache = new Map();

// Cache for protocol verification data
const protocolApyCache = new Map();

// Protocol APY sources for on-chain verification
const PROTOCOL_APY_SOURCES = {
    // Lido - stETH/wstETH
    'stETH': {
        name: 'Lido',
        url: 'https://eth-api.lido.fi/v1/protocol/steth/apr/sma',
        parser: (data) => parseFloat(data?.data?.smaApr || 0) / 100,
        assets: ['stETH', 'wstETH']
    },
    // Rocket Pool - rETH
    'rETH': {
        name: 'Rocket Pool',
        url: 'https://api.rocketpool.net/api/mainnet/payload',
        parser: (data) => parseFloat(data?.rethAPR || 0) / 100,
        assets: ['rETH']
    },
    // Ethena - sUSDe/USDe
    'sUSDe': {
        name: 'Ethena',
        url: 'https://ethena.fi/api/yields/protocol-and-staking-yield',
        parser: (data) => parseFloat(data?.stakingYield?.value || 0) / 100,
        assets: ['sUSDe', 'USDe']
    },
    // EtherFi - weETH/eETH
    'weETH': {
        name: 'EtherFi',
        url: 'https://www.etherfi.bid/api/etherfi/apr',
        parser: (data) => parseFloat(data?.latest_aprs?.staking_apr || data?.apr || 0) / 100,
        assets: ['weETH', 'eETH', 'weETHs']
    },
    // Frax - sfrxETH
    'sfrxETH': {
        name: 'Frax',
        url: 'https://api.frax.finance/v2/frxeth/summary/latest',
        parser: (data) => parseFloat(data?.sfrxethApr || 0) / 100,
        assets: ['sfrxETH', 'frxETH']
    },
    // Coinbase - cbETH
    'cbETH': {
        name: 'Coinbase',
        url: 'https://api.exchange.coinbase.com/wrapped-assets/CBETH/',
        parser: (data) => parseFloat(data?.apy || 0),
        assets: ['cbETH']
    }
};

// Find protocol source for an asset
function findProtocolSource(assetName) {
    const upperName = (assetName || '').toUpperCase();
    for (const [key, source] of Object.entries(PROTOCOL_APY_SOURCES)) {
        for (const asset of source.assets) {
            if (upperName.includes(asset.toUpperCase())) {
                return { key, ...source };
            }
        }
    }
    return null;
}

// Fetch verified APY from protocol source
async function fetchProtocolApy(source) {
    if (protocolApyCache.has(source.key)) {
        return protocolApyCache.get(source.key);
    }

    try {
        let response = null;
        let data = null;

        // Try direct fetch first
        try {
            response = await fetch(source.url);
            if (response.ok) {
                data = await response.json();
            }
        } catch (e) {
            console.log(`Direct fetch failed for ${source.name}, trying proxy...`);
        }

        // Try with CORS proxy
        if (!data) {
            for (const proxyFn of CORS_PROXIES) {
                try {
                    response = await fetch(proxyFn(source.url));
                    if (response.ok) {
                        data = await response.json();
                        if (data) break;
                    }
                } catch (e) {
                    continue;
                }
            }
        }

        if (data) {
            const apy = source.parser(data);
            const result = { apy, source: source.name, timestamp: Date.now() };
            protocolApyCache.set(source.key, result);
            return result;
        }
    } catch (e) {
        console.error(`Failed to fetch ${source.name} APY:`, e);
    }
    return null;
}

// Fetch Aave V3 reserves data for a chain
async function fetchAaveReserves(chainId) {
    const cacheKey = `aave-${chainId}`;
    const now = Date.now();

    // Check cache
    if (lendingMarketsCache.aave.has(cacheKey)) {
        const cached = lendingMarketsCache.aave.get(cacheKey);
        if (now - cached.timestamp < lendingMarketsCache.TTL) {
            return cached.data;
        }
    }

    const subgraphUrl = AAVE_SUBGRAPHS[chainId];
    if (!subgraphUrl) return [];

    const query = `{
        reserves(first: 100, where: {isActive: true}) {
            id
            symbol
            name
            underlyingAsset
            usageAsCollateralEnabled
            baseLTVasCollateral
            reserveLiquidationThreshold
            variableBorrowRate
            stableBorrowRate
            availableLiquidity
            totalCurrentVariableDebt
        }
    }`;

    try {
        let response = null;
        let data = null;

        // Try direct fetch first
        try {
            response = await fetch(subgraphUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query })
            });
            if (response.ok) {
                data = await response.json();
            }
        } catch (e) {
            console.log(`Direct Aave fetch failed for chain ${chainId}, trying proxy...`);
        }

        // Try with CORS proxy
        if (!data) {
            for (const proxyFn of CORS_PROXIES) {
                try {
                    response = await fetch(proxyFn(subgraphUrl), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ query })
                    });
                    if (response.ok) {
                        data = await response.json();
                        if (data?.data?.reserves) break;
                    }
                } catch (e) {
                    continue;
                }
            }
        }

        if (data?.data?.reserves) {
            const reserves = data.data.reserves.map(r => ({
                symbol: r.symbol,
                name: r.name,
                underlyingAsset: r.underlyingAsset,
                usageAsCollateralEnabled: r.usageAsCollateralEnabled,
                ltv: parseFloat(r.baseLTVasCollateral) / 10000, // Convert from basis points
                liquidationThreshold: parseFloat(r.reserveLiquidationThreshold) / 10000,
                borrowRate: parseFloat(r.variableBorrowRate) / 1e27 * 100, // Convert from RAY to percentage
                platform: 'Aave V3'
            }));

            lendingMarketsCache.aave.set(cacheKey, { data: reserves, timestamp: now });
            return reserves;
        }
    } catch (e) {
        console.error('Failed to fetch Aave reserves:', e);
    }

    return [];
}

// Fetch Morpho Blue markets data
async function fetchMorphoMarkets(chainIds = [1]) {
    const cacheKey = `morpho-${chainIds.join('-')}`;
    const now = Date.now();

    // Check cache
    if (lendingMarketsCache.morpho.has(cacheKey)) {
        const cached = lendingMarketsCache.morpho.get(cacheKey);
        if (now - cached.timestamp < lendingMarketsCache.TTL) {
            return cached.data;
        }
    }

    const query = `{
        markets(first: 100, where: {whitelisted: true}) {
            id
            uniqueKey
            lltv
            collateralAsset {
                symbol
                name
                address
            }
            loanAsset {
                symbol
                name
                address
            }
            state {
                borrowApy
                supplyApy
                totalBorrowAssets
                totalSupplyAssets
            }
        }
    }`;

    try {
        let response = null;
        let data = null;

        // Try direct fetch first
        try {
            response = await fetch(MORPHO_API, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query })
            });
            if (response.ok) {
                data = await response.json();
            }
        } catch (e) {
            console.log('Direct Morpho fetch failed, trying proxy...');
        }

        // Try with CORS proxy
        if (!data) {
            for (const proxyFn of CORS_PROXIES) {
                try {
                    response = await fetch(proxyFn(MORPHO_API), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ query })
                    });
                    if (response.ok) {
                        data = await response.json();
                        if (data?.data?.markets) break;
                    }
                } catch (e) {
                    continue;
                }
            }
        }

        if (data?.data?.markets) {
            const markets = data.data.markets.map(m => ({
                id: m.uniqueKey,
                collateralSymbol: m.collateralAsset?.symbol || '',
                collateralName: m.collateralAsset?.name || '',
                collateralAddress: m.collateralAsset?.address || '',
                loanSymbol: m.loanAsset?.symbol || '',
                ltv: parseFloat(m.lltv) / 1e18, // Convert from wei
                borrowRate: (m.state?.borrowApy || 0) * 100, // Already a decimal
                platform: 'Morpho Blue'
            }));

            lendingMarketsCache.morpho.set(cacheKey, { data: markets, timestamp: now });
            return markets;
        }
    } catch (e) {
        console.error('Failed to fetch Morpho markets:', e);
    }

    return [];
}

// Known PT-Lending pairs with real market data
// These are verified PT collateral integrations on lending protocols
const KNOWN_PT_LENDING_PAIRS = {
    'sUSDe': {
        platform: 'Morpho Blue',
        ltv: 0.915,
        borrowRate: 5.5,
        borrowAsset: 'USDC',
        chains: [1]
    },
    'eUSDe': {
        platform: 'Morpho Blue',
        ltv: 0.86,
        borrowRate: 5.2,
        borrowAsset: 'USDC',
        chains: [1]
    },
    'USDe': {
        platform: 'Morpho Blue',
        ltv: 0.77,
        borrowRate: 5.0,
        borrowAsset: 'USDC',
        chains: [1]
    },
    'wstETH': {
        platform: 'Aave V3',
        ltv: 0.80,
        borrowRate: 2.5,
        borrowAsset: 'WETH',
        chains: [1, 42161]
    },
    'weETH': {
        platform: 'Aave V3',
        ltv: 0.725,
        borrowRate: 2.8,
        borrowAsset: 'WETH',
        chains: [1, 42161]
    },
    'ezETH': {
        platform: 'Morpho Blue',
        ltv: 0.77,
        borrowRate: 3.0,
        borrowAsset: 'WETH',
        chains: [1]
    },
    'rsETH': {
        platform: 'Morpho Blue',
        ltv: 0.77,
        borrowRate: 3.2,
        borrowAsset: 'WETH',
        chains: [1]
    },
};

// Calculate loop strategy metrics
function calculateLoopMetrics(ptFixedApy, ltv, borrowRate) {
    // Max leverage = 1 / (1 - LTV)
    const maxLeverage = 1 / (1 - ltv);
    // Safe leverage = 90% of max to avoid liquidation
    const safeLeverage = 1 + (maxLeverage - 1) * 0.9;

    // Effective APY = (PT_Fixed_APY × leverage) - (Borrow_Rate × (leverage - 1))
    const effectiveApy = (ptFixedApy * safeLeverage) - (borrowRate * (safeLeverage - 1));

    // APY boost vs regular PT
    const apyBoost = effectiveApy - ptFixedApy;

    // Liquidation buffer (how much PT can drop before liquidation)
    const liquidationBuffer = (1 - ltv) * 100;

    return {
        maxLeverage,
        safeLeverage,
        effectiveApy,
        apyBoost,
        liquidationBuffer,
        borrowRate,
        ltv
    };
}

// Find loop opportunity for a market
function findLoopOpportunity(market, chainId, aaveReserves, morphoMarkets) {
    const marketName = (market.name || market.proName || '').toUpperCase();

    // Get PT fixed APY
    const ptFixedApy = calculateFixedAPY(market.ptPrice, market.days);

    // Minimum PT APY threshold - need decent fixed yield for looping to make sense
    if (ptFixedApy < 3) return null;

    // First check known pairs (most reliable)
    for (const [assetName, pairData] of Object.entries(KNOWN_PT_LENDING_PAIRS)) {
        if (marketName.includes(assetName.toUpperCase()) && pairData.chains.includes(chainId)) {
            const metrics = calculateLoopMetrics(ptFixedApy, pairData.ltv, pairData.borrowRate);

            // Only return if APY boost is meaningful (>= 1.5%)
            if (metrics.apyBoost >= 1.5) {
                return {
                    platform: pairData.platform,
                    collateralSymbol: `PT-${assetName}`,
                    borrowSymbol: pairData.borrowAsset,
                    ...metrics,
                    isKnownPair: true
                };
            }
        }
    }

    // Check Aave reserves for PT collateral (bonus if API works)
    for (const reserve of aaveReserves) {
        const reserveSymbol = (reserve.symbol || '').toUpperCase();

        // Match PT symbol or underlying asset as collateral
        if (reserve.usageAsCollateralEnabled &&
            (reserveSymbol.includes(marketName) || reserveSymbol.includes('PT-' + marketName))) {

            // Find stablecoin borrow rates (USDC, USDT)
            const stablecoins = aaveReserves.filter(r =>
                ['USDC', 'USDT', 'DAI'].includes(r.symbol?.toUpperCase())
            );

            if (stablecoins.length > 0) {
                // Use lowest borrow rate
                const bestStable = stablecoins.reduce((best, current) =>
                    current.borrowRate < best.borrowRate ? current : best
                );

                const metrics = calculateLoopMetrics(ptFixedApy, reserve.ltv, bestStable.borrowRate);

                // Only return if APY boost is meaningful (>= 1.5%)
                if (metrics.apyBoost >= 1.5) {
                    return {
                        platform: reserve.platform,
                        collateralSymbol: reserve.symbol,
                        borrowSymbol: bestStable.symbol,
                        ...metrics
                    };
                }
            }
        }
    }

    // Check Morpho markets for PT collateral (bonus if API works)
    for (const morphoMarket of morphoMarkets) {
        const collateralSymbol = (morphoMarket.collateralSymbol || '').toUpperCase();

        // Match PT symbol or underlying asset as collateral
        if (collateralSymbol.includes(marketName) || collateralSymbol.includes('PT-' + marketName)) {
            const metrics = calculateLoopMetrics(ptFixedApy, morphoMarket.ltv, morphoMarket.borrowRate);

            // Only return if APY boost is meaningful (>= 1.5%)
            if (metrics.apyBoost >= 1.5) {
                return {
                    platform: morphoMarket.platform,
                    collateralSymbol: morphoMarket.collateralSymbol,
                    borrowSymbol: morphoMarket.loanSymbol,
                    ...metrics
                };
            }
        }
    }

    return null;
}

// Verify Pendle's underlying APY against protocol source
async function verifyUnderlyingApy(market) {
    const source = findProtocolSource(market.name);
    if (!source) {
        return { verified: false, reason: 'No protocol source available' };
    }

    const protocolData = await fetchProtocolApy(source);
    if (!protocolData) {
        return { verified: false, reason: `Could not fetch ${source.name} data` };
    }

    const pendleApy = market.underlyingApyPercent;
    const protocolApy = protocolData.apy * 100;
    const difference = Math.abs(pendleApy - protocolApy);
    const percentDiff = protocolApy > 0 ? (difference / protocolApy) * 100 : 0;

    return {
        verified: true,
        source: protocolData.source,
        protocolApy,
        pendleApy,
        difference,
        percentDiff,
        matches: percentDiff < 10, // Within 10% is considered matching
        timestamp: protocolData.timestamp
    };
}

// Analyze historical data for potential watermark breaches
// When underlying APY drops significantly or goes negative, it may indicate exchange rate issues
function analyzeWatermarkHistory(historyData, marketName) {
    if (!historyData || !historyData.rawData || historyData.rawData.length < 2) {
        return null;
    }

    const data = historyData.rawData;
    const analysis = {
        potentialBreaches: [],
        riskPeriods: [],
        maxDrawdown: 0,
        volatility: historyData.underlyingApy?.last90d?.stdDev || 0,
        knownEvents: []
    };

    // Check for known events related to this asset
    const upperName = (marketName || '').toUpperCase();
    const chainId = historyData.chainId;
    for (const event of KNOWN_WATERMARK_EVENTS) {
        const assetMatch = upperName.includes(event.asset.toUpperCase());
        const chainMatch = !event.chain || event.chain === chainId;
        if (assetMatch && chainMatch) {
            analysis.knownEvents.push(event);
        }
    }

    // Analyze historical underlying APY for sudden drops
    // A significant drop in underlying APY could indicate exchange rate issues
    let prevApy = null;
    let cumulativeReturn = 1;
    let peakReturn = 1;

    for (let i = 0; i < data.length; i++) {
        const point = data[i];
        const apy = (point.underlyingApy || 0) * 100;
        const date = point.timestamp?.split('T')[0] || '';

        // Track cumulative return proxy (simplified)
        const dailyReturn = apy / 365 / 100;
        cumulativeReturn *= (1 + dailyReturn);
        peakReturn = Math.max(peakReturn, cumulativeReturn);

        // Calculate drawdown
        const drawdown = (peakReturn - cumulativeReturn) / peakReturn * 100;
        analysis.maxDrawdown = Math.max(analysis.maxDrawdown, drawdown);

        if (prevApy !== null) {
            const change = apy - prevApy;
            const changePercent = prevApy !== 0 ? (change / prevApy) * 100 : 0;

            // Flag significant negative changes (>50% drop or negative APY)
            if (changePercent < -50 || apy < -1) {
                analysis.potentialBreaches.push({
                    date,
                    previousApy: prevApy,
                    newApy: apy,
                    change: changePercent,
                    severity: apy < 0 ? 'critical' : changePercent < -75 ? 'high' : 'medium'
                });
            }

            // Flag periods of very low or negative yield
            if (apy < 0.5 && prevApy >= 0.5) {
                analysis.riskPeriods.push({
                    startDate: date,
                    apy,
                    type: apy < 0 ? 'negative_yield' : 'near_zero_yield'
                });
            }
        }

        prevApy = apy;
    }

    // Determine overall watermark risk level
    if (analysis.potentialBreaches.some(b => b.severity === 'critical') || analysis.knownEvents.length > 0) {
        analysis.riskLevel = 'high';
        analysis.riskColor = 'var(--loss-color)';
    } else if (analysis.potentialBreaches.length > 0 || analysis.maxDrawdown > 5) {
        analysis.riskLevel = 'medium';
        analysis.riskColor = 'var(--warning-color)';
    } else {
        analysis.riskLevel = 'low';
        analysis.riskColor = 'var(--profit-color)';
    }

    return analysis;
}

// Fetch on-chain watermark data for a market
async function fetchOnChainWatermark(market, chainId) {
    const cacheKey = `${chainId}-${market.address}`;
    if (watermarkHistoryCache.has(cacheKey)) {
        return watermarkHistoryCache.get(cacheKey);
    }

    try {
        const rpcUrl = RPC_ENDPOINTS[chainId];
        if (!rpcUrl || typeof ethers === 'undefined') {
            return null;
        }

        // Extract addresses
        let ytAddress = market.yt;
        let syAddress = market.sy;
        if (typeof ytAddress === 'string' && ytAddress.includes('-')) {
            ytAddress = ytAddress.split('-')[1];
        }
        if (typeof syAddress === 'string' && syAddress.includes('-')) {
            syAddress = syAddress.split('-')[1];
        }

        if (!ytAddress || !syAddress) return null;

        const provider = new ethers.providers.JsonRpcProvider(rpcUrl);

        // Query YT for pyIndexStored
        const ytContract = new ethers.Contract(ytAddress, YT_ABI, provider);
        const pyIndexStored = await ytContract.pyIndexStored();

        // Query SY for current exchange rate
        const syContract = new ethers.Contract(syAddress, SY_ABI, provider);
        const exchangeRate = await syContract.exchangeRate();

        const pyIndexFloat = parseFloat(ethers.utils.formatUnits(pyIndexStored, 18));
        const exchangeRateFloat = parseFloat(ethers.utils.formatUnits(exchangeRate, 18));

        const ratio = pyIndexFloat > 0 ? exchangeRateFloat / pyIndexFloat : 1;
        const belowWatermark = exchangeRateFloat < pyIndexFloat;
        const percentFromWatermark = (ratio - 1) * 100;

        const result = {
            pyIndexStored: pyIndexFloat,
            currentExchangeRate: exchangeRateFloat,
            ratio,
            belowWatermark,
            percentFromWatermark,
            timestamp: Date.now()
        };

        watermarkHistoryCache.set(cacheKey, result);
        return result;
    } catch (e) {
        console.log(`Watermark fetch failed for ${market.name}:`, e.message);
        return null;
    }
}

// State
let markets = [];
let selectedMarket = null;
let comparisonChart = null;
let legendFilters = { pt: true, yt: true, lp: true, loop: true, neutral: true, watermark: true };
let sortDirection = 'desc'; // 'desc' or 'asc'
let currentSortColumn = 'tvl';

// Utility functions
function formatNumber(num, decimals = 2) {
    return num.toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
    });
}

function formatCurrency(num) {
    if (Math.abs(num) >= 1000000) {
        return '$' + formatNumber(num / 1000000, 2) + 'M';
    } else if (Math.abs(num) >= 1000) {
        return '$' + formatNumber(num / 1000, 2) + 'K';
    }
    return '$' + formatNumber(num);
}

function formatPercent(num) {
    return formatNumber(num, 2) + '%';
}

function formatDate(dateStr) {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function daysUntil(dateStr) {
    const target = new Date(dateStr);
    const now = new Date();
    const diff = target - now;
    return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

// Calculate Fixed APY for PT
function calculateFixedAPY(ptPrice, daysToMaturity) {
    if (ptPrice <= 0 || ptPrice >= 1 || daysToMaturity <= 0) return 0;
    const exponent = 365 / daysToMaturity;
    return (Math.pow(1 / ptPrice, exponent) - 1) * 100;
}

// Calculate Implied APY
function calculateImpliedAPY(ytPrice, ptPrice, daysToMaturity) {
    if (ptPrice <= 0 || daysToMaturity <= 0) return 0;
    const exponent = 365 / daysToMaturity;
    return (Math.pow(1 + ytPrice / ptPrice, exponent) - 1) * 100;
}

// Fetch historical yield data for a market
async function fetchHistoricalData(marketAddress, chainId = 1) {
    const cacheKey = `${chainId}-${marketAddress}`;
    if (historyCache.has(cacheKey)) {
        return historyCache.get(cacheKey);
    }

    try {
        const apiUrl = `${API_BASE}/v2/${chainId}/markets/${marketAddress}/historical-data?time_frame=day`;
        let response = null;
        let data = null;

        // Try direct API first
        try {
            response = await fetch(apiUrl);
            if (response.ok) {
                data = await response.json();
            }
        } catch (e) {
            console.log('Direct historical API failed, trying proxy...');
        }

        // Try CORS proxy if direct failed
        if (!data) {
            for (const proxyFn of CORS_PROXIES) {
                try {
                    response = await fetch(proxyFn(apiUrl));
                    if (response.ok) {
                        data = await response.json();
                        if (data?.results) break;
                    }
                } catch (e) {
                    continue;
                }
            }
        }

        if (!data?.results || data.results.length === 0) {
            return null;
        }

        const results = data.results;

        // Calculate statistics for the last 90 days
        const last90Days = results.slice(-90);
        const last30Days = results.slice(-30);
        const last7Days = results.slice(-7);

        const calcStats = (arr, field) => {
            const values = arr.map(d => (d[field] || 0) * 100).filter(v => v > 0 && v < 1000);
            if (values.length === 0) return null;
            const avg = values.reduce((a, b) => a + b, 0) / values.length;
            // Calculate standard deviation for volatility
            const variance = values.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) / values.length;
            const stdDev = Math.sqrt(variance);
            return {
                min: Math.min(...values),
                max: Math.max(...values),
                avg,
                stdDev,
                current: values[values.length - 1],
                values: values
            };
        };

        const history = {
            impliedApy: {
                all: calcStats(results, 'impliedApy'),
                last90d: calcStats(last90Days, 'impliedApy'),
                last30d: calcStats(last30Days, 'impliedApy'),
                last7d: calcStats(last7Days, 'impliedApy'),
            },
            underlyingApy: {
                all: calcStats(results, 'underlyingApy'),
                last90d: calcStats(last90Days, 'underlyingApy'),
                last30d: calcStats(last30Days, 'underlyingApy'),
                last7d: calcStats(last7Days, 'underlyingApy'),
            },
            dataPoints: results.length,
            startDate: results[0]?.timestamp,
            endDate: results[results.length - 1]?.timestamp,
            rawData: results.slice(-90), // Keep last 90 days for charting
            chainId: chainId
        };

        historyCache.set(cacheKey, history);
        return history;
    } catch (e) {
        console.error('Failed to fetch historical data:', e);
        return null;
    }
}

// Calculate percentile position of current value within range
function getPercentile(current, min, max) {
    if (max === min) return 50;
    return Math.round(((current - min) / (max - min)) * 100);
}

// Get yield positioning label
function getYieldPosition(percentile) {
    if (percentile <= 10) return { label: 'Very Low', color: 'var(--pt-color)' };
    if (percentile <= 30) return { label: 'Low', color: 'var(--pt-color)' };
    if (percentile <= 70) return { label: 'Average', color: 'var(--text-secondary)' };
    if (percentile <= 90) return { label: 'High', color: 'var(--yt-color)' };
    return { label: 'Very High', color: 'var(--yt-color)' };
}

// Asset categories for cross-asset comparison
const ASSET_CATEGORIES = {
    'eth-lsd': ['stETH', 'wstETH', 'rETH', 'cbETH', 'sfrxETH', 'weETH', 'eETH', 'ezETH', 'pufETH', 'rsETH', 'mETH', 'swETH', 'ETHx', 'osETH', 'ankrETH', 'uniETH', 'agETH', 'hgETH', 'strETH', 'weETHs', 'instETH'],
    'btc': ['WBTC', 'tBTC', 'cbBTC', 'eBTC', 'LBTC', 'solvBTC', 'pumpBTC', 'uniBTC', 'SolvBTC'],
    'stablecoin': ['USDC', 'USDT', 'DAI', 'FRAX', 'crvUSD', 'GHO', 'LUSD', 'sUSD', 'USDD', 'sDAI', 'sUSDe', 'USDe', 'aUSDC', 'cUSDO', 'USD0', 'savUSD', 'stcUSD', 'deUSD', 'fUSDC', 'lvlUSD', 'syrupUSDC'],
    'other': []
};

// Categorize an asset by name
function categorizeAsset(name) {
    const upperName = (name || '').toUpperCase();
    for (const [category, assets] of Object.entries(ASSET_CATEGORIES)) {
        if (category === 'other') continue;
        for (const asset of assets) {
            if (upperName.includes(asset.toUpperCase())) {
                return category;
            }
        }
    }
    return 'other';
}

// Calculate mean reversion signal
function getMeanReversionSignal(current, avg, stdDev) {
    if (!avg || !stdDev || stdDev === 0) return null;
    const zScore = (current - avg) / stdDev;

    let signal, description, color;
    if (zScore > 1.5) {
        signal = 'PT Favored';
        description = `Yield is ${zScore.toFixed(1)}σ above average. High chance of reversion down → lock in with PT`;
        color = 'var(--pt-color)';
    } else if (zScore > 0.5) {
        signal = 'Slightly High';
        description = `Yield is ${zScore.toFixed(1)}σ above average. May revert down`;
        color = 'var(--pt-color)';
    } else if (zScore < -1.5) {
        signal = 'YT Favored';
        description = `Yield is ${Math.abs(zScore).toFixed(1)}σ below average. High chance of reversion up → YT could benefit`;
        color = 'var(--yt-color)';
    } else if (zScore < -0.5) {
        signal = 'Slightly Low';
        description = `Yield is ${Math.abs(zScore).toFixed(1)}σ below average. May revert up`;
        color = 'var(--yt-color)';
    } else {
        signal = 'Near Average';
        description = 'Yield is close to historical average. No strong mean reversion signal';
        color = 'var(--text-secondary)';
    }

    return { signal, description, color, zScore };
}

// Calculate Sharpe ratio for PT and YT strategies
function calculateSharpeRatios(ptFixedApy, underlyingApy, impliedApy, volatility, days) {
    // Risk-free rate assumption (approximate stablecoin yield)
    const riskFreeRate = 3;

    // PT Sharpe: fixed return with minimal volatility risk
    // PT volatility is much lower since return is fixed at maturity
    const ptVolatility = volatility * 0.2; // PT has ~20% of underlying volatility
    const ptExcessReturn = ptFixedApy - riskFreeRate;
    const ptSharpe = ptVolatility > 0 ? ptExcessReturn / ptVolatility : 0;

    // YT Sharpe: leveraged exposure to yield
    // YT volatility is amplified by leverage
    const ytLeverage = 1 / (1 - (1 / Math.pow(1 + impliedApy / 100, days / 365)));
    const ytVolatility = volatility * Math.min(ytLeverage, 10); // Cap leverage effect
    const ytExpectedReturn = (underlyingApy - impliedApy) * Math.min(ytLeverage, 10); // Simplified
    const ytExcessReturn = ytExpectedReturn - riskFreeRate;
    const ytSharpe = ytVolatility > 0 ? ytExcessReturn / ytVolatility : 0;

    return {
        pt: { sharpe: ptSharpe, volatility: ptVolatility, excessReturn: ptExcessReturn },
        yt: { sharpe: ytSharpe, volatility: ytVolatility, excessReturn: ytExpectedReturn }
    };
}

// ETH price cache for correlation calculation
let ethPriceHistory = null;

// Fetch ETH price history
async function fetchEthPriceHistory() {
    if (ethPriceHistory) return ethPriceHistory;

    try {
        const response = await fetch('https://api.coingecko.com/api/v3/coins/ethereum/market_chart?vs_currency=usd&days=90');
        if (response.ok) {
            const data = await response.json();
            ethPriceHistory = data.prices.map(([timestamp, price]) => ({
                timestamp: new Date(timestamp).toISOString().split('T')[0],
                price
            }));
            return ethPriceHistory;
        }
    } catch (e) {
        console.log('Failed to fetch ETH prices:', e.message);
    }
    return null;
}

// Calculate correlation between yield and ETH price
function calculateCorrelation(yieldData, priceData) {
    if (!yieldData || !priceData || yieldData.length < 10) return null;

    // Align data by date
    const priceMap = new Map(priceData.map(p => [p.timestamp, p.price]));
    const aligned = [];

    for (const point of yieldData) {
        const date = new Date(point.timestamp).toISOString().split('T')[0];
        const price = priceMap.get(date);
        if (price && point.underlyingApy) {
            aligned.push({
                yield: point.underlyingApy * 100,
                price
            });
        }
    }

    if (aligned.length < 10) return null;

    // Calculate Pearson correlation
    const n = aligned.length;
    const sumX = aligned.reduce((s, p) => s + p.yield, 0);
    const sumY = aligned.reduce((s, p) => s + p.price, 0);
    const sumXY = aligned.reduce((s, p) => s + p.yield * p.price, 0);
    const sumX2 = aligned.reduce((s, p) => s + p.yield * p.yield, 0);
    const sumY2 = aligned.reduce((s, p) => s + p.price * p.price, 0);

    const numerator = n * sumXY - sumX * sumY;
    const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

    if (denominator === 0) return null;

    const correlation = numerator / denominator;

    let interpretation, color;
    if (correlation > 0.5) {
        interpretation = 'Strong positive correlation with ETH. Yield likely to drop in bear markets.';
        color = 'var(--loss-color)';
    } else if (correlation > 0.2) {
        interpretation = 'Moderate positive correlation with ETH.';
        color = 'var(--text-secondary)';
    } else if (correlation < -0.5) {
        interpretation = 'Negative correlation with ETH. Yield may rise in bear markets (hedge).';
        color = 'var(--profit-color)';
    } else if (correlation < -0.2) {
        interpretation = 'Slight negative correlation with ETH.';
        color = 'var(--text-secondary)';
    } else {
        interpretation = 'Low correlation with ETH price. Yield is relatively independent.';
        color = 'var(--text-secondary)';
    }

    return { correlation, interpretation, color };
}

// Get cross-asset comparison data
function getCrossAssetComparison(market, allMarkets) {
    const category = categorizeAsset(market.name);
    if (category === 'other') return null;

    const peers = allMarkets.filter(m =>
        categorizeAsset(m.name) === category &&
        m.address !== market.address &&
        m.days > 7
    );

    if (peers.length < 2) return null;

    const peerImpliedApys = peers.map(m => m.impliedApyPercent);
    const avgImplied = peerImpliedApys.reduce((a, b) => a + b, 0) / peerImpliedApys.length;
    const diff = market.impliedApyPercent - avgImplied;

    const categoryLabels = {
        'eth-lsd': 'ETH LSDs',
        'btc': 'BTC Assets',
        'stablecoin': 'Stablecoins'
    };

    let signal, color;
    if (diff > 1) {
        signal = `Higher than ${categoryLabels[category]} avg (+${formatPercent(diff)}) → PT may be cheap`;
        color = 'var(--pt-color)';
    } else if (diff < -1) {
        signal = `Lower than ${categoryLabels[category]} avg (${formatPercent(diff)}) → YT may be cheap`;
        color = 'var(--yt-color)';
    } else {
        signal = `In line with ${categoryLabels[category]} average`;
        color = 'var(--text-secondary)';
    }

    return {
        category: categoryLabels[category],
        peerCount: peers.length,
        avgImplied,
        diff,
        signal,
        color,
        peers: peers.slice(0, 5).map(p => ({ name: p.name, impliedApy: p.impliedApyPercent }))
    };
}

// Check if YT is below watermark (on-chain)
async function checkWatermarkStatus(ytAddress, chainId) {
    const cacheKey = `${chainId}-${ytAddress}`;
    if (watermarkCache.has(cacheKey)) {
        return watermarkCache.get(cacheKey);
    }

    try {
        const rpcUrl = RPC_ENDPOINTS[chainId];
        if (!rpcUrl || typeof ethers === 'undefined') {
            return null;
        }

        const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
        const ytContract = new ethers.Contract(ytAddress, YT_ABI, provider);

        // Get SY address and pyIndexStored
        const [syAddress, pyIndexStored] = await Promise.all([
            ytContract.SY(),
            ytContract.pyIndexStored()
        ]);

        // Get current exchange rate from SY
        const syContract = new ethers.Contract(syAddress, SY_ABI, provider);
        const exchangeRate = await syContract.exchangeRate();

        // Compare: if exchangeRate < pyIndexStored, YT is below watermark
        const belowWatermark = exchangeRate.lt(pyIndexStored);
        const ratio = parseFloat(ethers.utils.formatUnits(exchangeRate, 18)) /
                      parseFloat(ethers.utils.formatUnits(pyIndexStored, 18));

        const result = {
            belowWatermark,
            ratio,
            exchangeRate: ethers.utils.formatUnits(exchangeRate, 18),
            pyIndex: ethers.utils.formatUnits(pyIndexStored, 18)
        };

        watermarkCache.set(cacheKey, result);
        return result;
    } catch (e) {
        console.log(`Watermark check failed for ${ytAddress}:`, e.message);
        return null;
    }
}

// Check watermarks for all markets (in background)
async function checkAllWatermarks(marketsToCheck) {
    const chainId = document.getElementById('chain-filter')?.value || 1;

    for (const market of marketsToCheck) {
        // Extract YT address from the market data
        // The yt field is formatted as "chainId-address"
        let ytAddress = market.yt;
        if (typeof ytAddress === 'string' && ytAddress.includes('-')) {
            ytAddress = ytAddress.split('-')[1];
        }

        if (ytAddress && ytAddress.startsWith('0x')) {
            const status = await checkWatermarkStatus(ytAddress, parseInt(chainId));
            if (status) {
                market.watermarkStatus = status;
                // Re-render if below watermark
                if (status.belowWatermark) {
                    console.log(`${market.name} is BELOW watermark! Ratio: ${status.ratio.toFixed(4)}`);
                }
            }
        }
    }

    // Re-render markets with watermark info
    renderMarkets();
}

// Determine market signal (PT opportunity vs YT opportunity)
function getMarketSignal(underlyingApy, impliedApy) {
    const diff = impliedApy - underlyingApy;
    const threshold = 0.5; // 0.5% threshold for signal

    if (diff > threshold) {
        return {
            type: 'pt',
            label: 'PT Opportunity',
            reason: `Implied APY (${formatPercent(impliedApy)}) > Underlying APY (${formatPercent(underlyingApy)}). Market expects yield to drop. Lock in high fixed rate with PT.`
        };
    } else if (diff < -threshold) {
        return {
            type: 'yt',
            label: 'YT Opportunity',
            reason: `Underlying APY (${formatPercent(underlyingApy)}) > Implied APY (${formatPercent(impliedApy)}). Market may be underpricing future yield. YT could be attractive.`
        };
    }
    return {
        type: 'neutral',
        label: 'Fair Value',
        reason: `Implied APY (${formatPercent(impliedApy)}) ≈ Underlying APY (${formatPercent(underlyingApy)}). Market seems fairly priced.`
    };
}

// Fallback sample data in case API fails (dates set to future from Feb 2026)
const SAMPLE_MARKETS = [
    { address: '0x1', name: 'sUSDe', proName: 'sUSDe', expiry: '2026-05-29', underlyingApy: 0.0453, impliedApy: 0.0431, liquidity: { usd: 20770000 }, proIcon: '' },
    { address: '0x2', name: 'savUSD', proName: 'savUSD', expiry: '2026-05-14', underlyingApy: 0.10, impliedApy: 0.0994, liquidity: { usd: 24880000 }, proIcon: '' },
    { address: '0x3', name: 'stcUSD', proName: 'stcUSD', expiry: '2026-07-23', underlyingApy: 0.0557, impliedApy: 0.0648, liquidity: { usd: 33830000 }, proIcon: '' },
    { address: '0x4', name: 'wstETH', proName: 'wstETH', expiry: '2027-12-30', underlyingApy: 0.0262, impliedApy: 0.0238, liquidity: { usd: 2370000 }, proIcon: '' },
    { address: '0x5', name: 'weETH', proName: 'weETH', expiry: '2026-06-25', underlyingApy: 0.0273, impliedApy: 0.0251, liquidity: { usd: 2180000 }, proIcon: '' },
    { address: '0x6', name: 'hgETH', proName: 'hgETH (YT Opportunity)', expiry: '2026-06-25', underlyingApy: 0.1008, impliedApy: 0.0535, liquidity: { usd: 3240000 }, proIcon: '' },
    { address: '0x7', name: 'pufETH', proName: 'pufETH (YT Opportunity)', expiry: '2026-06-25', underlyingApy: 0.0526, impliedApy: 0.0431, liquidity: { usd: 1880000 }, proIcon: '' },
    { address: '0x8', name: 'agETH', proName: 'agETH (PT Opportunity)', expiry: '2026-06-25', underlyingApy: 0.0432, impliedApy: 0.0498, liquidity: { usd: 746800 }, proIcon: '' },
    { address: '0x9', name: 'cUSDO', proName: 'cUSDO (PT Opportunity)', expiry: '2026-05-28', underlyingApy: 0.0337, impliedApy: 0.0479, liquidity: { usd: 14670000 }, proIcon: '' },
    { address: '0xa', name: 'strETH', proName: 'strETH (YT Opportunity)', expiry: '2026-03-26', underlyingApy: 0.0513, impliedApy: 0.0439, liquidity: { usd: 2330000 }, proIcon: '' },
    { address: '0xb', name: 'weETHs', proName: 'weETHs (PT Opportunity)', expiry: '2026-06-25', underlyingApy: 0.019, impliedApy: 0.0377, liquidity: { usd: 1650000 }, proIcon: '' },
    { address: '0xc', name: 'uniETH', proName: 'uniETH (PT Opportunity)', expiry: '2026-06-25', underlyingApy: 0.0281, impliedApy: 0.0421, liquidity: { usd: 532000 }, proIcon: '' },
];

// Fetch markets from Pendle API
async function fetchMarkets(chainId = 1) {
    const marketsContainer = document.getElementById('markets-list');
    const refreshBtn = document.getElementById('refresh-markets');

    refreshBtn?.classList.add('loading');
    marketsContainer.innerHTML = '<div class="loading">Loading markets...</div>';

    // Fetch lending data in parallel with market data
    const lendingPromises = Promise.allSettled([
        fetchAaveReserves(parseInt(chainId)),
        fetchMorphoMarkets([parseInt(chainId)])
    ]);

    try {
        const apiUrl = `${API_BASE}/v1/markets/all?isActive=true&chainId=${chainId}`;
        let response = null;
        let data = null;

        // Try direct API first
        try {
            response = await fetch(apiUrl);
            if (response.ok) {
                data = await response.json();
            }
        } catch (e) {
            console.log('Direct API failed, trying proxies...', e.message);
        }

        // If direct failed, try CORS proxies
        if (!data) {
            for (const proxyFn of CORS_PROXIES) {
                try {
                    const proxyUrl = proxyFn(apiUrl);
                    console.log('Trying proxy:', proxyUrl);
                    response = await fetch(proxyUrl);
                    if (response.ok) {
                        data = await response.json();
                        if (data && (data.markets || data.results || Array.isArray(data))) {
                            console.log('Proxy succeeded!');
                            break;
                        }
                    }
                } catch (e) {
                    console.log('Proxy failed:', e.message);
                }
            }
        }

        if (!data) throw new Error('All API attempts failed');

        markets = data.markets || data.results || data || [];

        // 0 markets is valid for some chains - don't fall back to sample data
        if (markets.length === 0) {
            marketsContainer.innerHTML = '<div class="loading">No active markets on this chain</div>';
            refreshBtn?.classList.remove('loading');
            return;
        }

        console.log(`Loaded ${markets.length} markets`);

        // Get lending data results
        const lendingResults = await lendingPromises;
        const aaveReserves = lendingResults[0].status === 'fulfilled' ? lendingResults[0].value : [];
        const morphoMarkets = lendingResults[1].status === 'fulfilled' ? lendingResults[1].value : [];
        console.log(`Loaded ${aaveReserves.length} Aave reserves, ${morphoMarkets.length} Morpho markets`);

        // Store raw market data for watermark checking
        const rawMarkets = [...markets];

        // Process markets to add calculated fields
        markets = markets.map(market => {
            const days = daysUntil(market.expiry);
            const details = market.details || {};

            // Get APYs from details or top level
            const underlyingApy = (details.underlyingApy || market.underlyingApy || 0) * 100;
            const impliedApy = (details.impliedApy || market.impliedApy || 0) * 100;

            // Calculate PT price from implied APY: PT = 1 / (1 + impliedApy * days/365)
            // This is approximate but works for display
            const ptPrice = 1 / Math.pow(1 + impliedApy / 100, days / 365);
            const ytPrice = 1 - ptPrice;
            const discount = (1 - ptPrice) * 100;

            // Get TVL
            const tvl = details.liquidity || details.totalTvl || market.liquidity?.usd || market.totalValueLocked || 0;

            // Detect external incentives (points, airdrops, reward tokens)
            const rewardTokens = market.rewardTokens || details.rewardTokens || [];
            const aggregatedApy = (details.aggregatedApy || market.aggregatedApy || 0) * 100;
            const lpRewardApy = (details.lpRewardApy || market.lpRewardApy || 0) * 100;
            const pointMultipliers = market.pointMultipliers || details.pointMultipliers || [];

            // Market has incentives if: reward tokens exist, or aggregatedApy > impliedApy, or has point multipliers
            const hasIncentives = rewardTokens.length > 0 ||
                                  lpRewardApy > 0.1 ||
                                  pointMultipliers.length > 0 ||
                                  (aggregatedApy > impliedApy + 0.5);

            // Get incentive details for tooltip
            const incentiveDetails = [];
            if (rewardTokens.length > 0) {
                incentiveDetails.push(`${rewardTokens.length} reward token${rewardTokens.length > 1 ? 's' : ''}`);
            }
            if (pointMultipliers.length > 0) {
                incentiveDetails.push('Points campaign');
            }
            if (lpRewardApy > 0.1) {
                incentiveDetails.push(`+${formatPercent(lpRewardApy)} LP rewards`);
            }

            // Detect if yield is purely points-based (0 underlying but positive implied)
            const isPurePoints = underlyingApy < 0.1 && impliedApy > 1;

            // Categorize zero-yield markets with explanations
            let zeroYieldReason = null;
            if (isPurePoints) {
                const name = market.name?.toUpperCase() || '';
                if (name === 'USDE') {
                    zeroYieldReason = {
                        type: 'raw_token',
                        title: 'Raw Token - No Native Yield',
                        explanation: 'Raw USDe does not generate yield. Stake to sUSDe for ~4.5% APY. Implied APY is from points speculation.'
                    };
                } else if (name === 'SENA') {
                    zeroYieldReason = {
                        type: 'governance',
                        title: 'Governance Token Staking',
                        explanation: 'sENA yield comes from governance rewards and points, not direct protocol yield.'
                    };
                } else if (name.includes('BTC') || name === 'UNIBTC') {
                    zeroYieldReason = {
                        type: 'raw_token',
                        title: 'Wrapped BTC - No Native Yield',
                        explanation: 'Wrapped BTC has no native yield. Must be lent or staked in DeFi to earn yield.'
                    };
                } else if (name.includes('FUSN') || name.includes('STH')) {
                    zeroYieldReason = {
                        type: 'data_issue',
                        title: '⚠️ Possible Data Issue',
                        explanation: 'This asset should have underlying yield. Data may be delayed or incorrectly reported.'
                    };
                } else {
                    zeroYieldReason = {
                        type: 'points_only',
                        title: 'Points/Incentive Based',
                        explanation: 'Yield is entirely from points programs or airdrops - no measurable on-chain yield.'
                    };
                }
            }

            // Calculate total LP APY (swap fees + PT yield component + rewards)
            const swapFeeApy = (details.swapFeeApy || market.swapFeeApy || 0) * 100;
            const lpApy = aggregatedApy > 0 ? aggregatedApy : (swapFeeApy + lpRewardApy + (impliedApy * 0.5)); // Estimate if not provided

            // Find loop opportunity for this market
            const loopOpportunity = findLoopOpportunity(
                { ...market, ptPrice, days },
                parseInt(chainId),
                aaveReserves,
                morphoMarkets
            );

            return {
                ...market,
                days,
                underlyingApyPercent: underlyingApy,
                impliedApyPercent: impliedApy,
                ptPrice,
                ytPrice,
                discount,
                signal: getMarketSignal(underlyingApy, impliedApy),
                loopOpportunity,
                tvl,
                proName: market.name,
                proIcon: market.icon || '',
                hasIncentives,
                incentiveDetails,
                lpRewardApy,
                swapFeeApy,
                lpApy,
                aggregatedApy,
                isPurePoints,
                zeroYieldReason
            };
        }).filter(m => m.days > 0);

        renderMarkets();

        // Check watermarks in background (don't await)
        checkAllWatermarks(markets);
    } catch (error) {
        console.error('Failed to fetch markets:', error);
        console.log('Using sample data...');

        // Use sample data as fallback
        markets = SAMPLE_MARKETS.map(market => {
            const days = daysUntil(market.expiry);
            const underlyingApy = (market.underlyingApy || 0) * 100;
            const impliedApy = (market.impliedApy || 0) * 100;
            const ptPrice = 1 / (1 + impliedApy / 100 * days / 365);
            const ytPrice = 1 - ptPrice;
            const discount = (1 - ptPrice) * 100;

            return {
                ...market,
                days,
                underlyingApyPercent: underlyingApy,
                impliedApyPercent: impliedApy,
                ptPrice,
                ytPrice,
                discount,
                signal: getMarketSignal(underlyingApy, impliedApy),
                tvl: market.liquidity?.usd || 0
            };
        }).filter(m => m.days > 0);

        renderMarkets();
        marketsContainer.insertAdjacentHTML('beforeend', '<div class="loading" style="padding: 0.5rem; font-size: 0.8rem; color: #ffd93d;">Using cached sample data (API unavailable)</div>');
    } finally {
        refreshBtn?.classList.remove('loading');
    }
}

// Render markets list
function renderMarkets() {
    const container = document.getElementById('markets-list');
    const sortBy = currentSortColumn || document.getElementById('sort-filter')?.value || 'tvl';
    const signalFilter = document.getElementById('signal-filter')?.value || 'all';
    const searchQuery = (document.getElementById('search-filter')?.value || '').trim().toLowerCase();

    let filtered = [...markets];

    // Filter by search query (match against name, proName, or underlying asset)
    if (searchQuery) {
        filtered = filtered.filter(m => {
            const name = (m.name || '').toLowerCase();
            const proName = (m.proName || '').toLowerCase();
            const symbol = (m.symbol || '').toLowerCase();
            return name.includes(searchQuery) || proName.includes(searchQuery) || symbol.includes(searchQuery);
        });
    }

    // Helper to check if LP is the best opportunity
    const isLpOpportunity = (m) => m.lpApy > m.underlyingApyPercent && m.lpApy > calculateFixedAPY(m.ptPrice, m.days);

    // Filter by signal dropdown
    if (signalFilter === 'pt-opportunity') {
        filtered = filtered.filter(m => m.signal.type === 'pt');
    } else if (signalFilter === 'yt-opportunity') {
        filtered = filtered.filter(m => m.signal.type === 'yt');
    } else if (signalFilter === 'lp-opportunity') {
        filtered = filtered.filter(m => isLpOpportunity(m));
    } else if (signalFilter === 'has-incentives') {
        filtered = filtered.filter(m => m.hasIncentives);
    } else if (signalFilter === 'no-incentives') {
        filtered = filtered.filter(m => !m.hasIncentives);
    } else if (signalFilter === 'pure-points') {
        filtered = filtered.filter(m => m.isPurePoints);
    } else if (signalFilter === 'real-yield') {
        filtered = filtered.filter(m => !m.isPurePoints && m.underlyingApyPercent > 0.5);
    } else if (signalFilter === 'below-watermark') {
        filtered = filtered.filter(m => m.watermarkStatus?.belowWatermark);
    } else if (signalFilter === 'loop-opportunity') {
        filtered = filtered.filter(m => m.loopOpportunity);
    }

    // Filter by legend buttons
    filtered = filtered.filter(m => {
        if (m.watermarkStatus?.belowWatermark) return legendFilters.watermark;
        if (m.loopOpportunity) return legendFilters.loop !== false; // Show loop if filter is not false
        if (isLpOpportunity(m)) return legendFilters.lp;
        if (m.signal.type === 'pt') return legendFilters.pt;
        if (m.signal.type === 'yt') return legendFilters.yt;
        return legendFilters.neutral;
    });

    // Sort
    filtered.sort((a, b) => {
        const dir = sortDirection === 'asc' ? 1 : -1;
        switch (sortBy) {
            case 'tvl': return dir * ((b.tvl || 0) - (a.tvl || 0));
            case 'lpApy': return dir * ((b.lpApy || 0) - (a.lpApy || 0));
            case 'fixedApy': return dir * (calculateFixedAPY(b.ptPrice, b.days) - calculateFixedAPY(a.ptPrice, a.days));
            case 'underlyingApy': return dir * (b.underlyingApyPercent - a.underlyingApyPercent);
            case 'impliedApy': return dir * (b.impliedApyPercent - a.impliedApyPercent);
            case 'expiry': return dir * (a.days - b.days);
            default: return 0;
        }
    });

    if (filtered.length === 0) {
        const message = searchQuery
            ? `No markets found for "${searchQuery}"`
            : 'No markets match your filters';
        container.innerHTML = `<div class="loading">${message}</div>`;
        return;
    }

    container.innerHTML = filtered.map(market => {
        // Determine card class based on opportunity type
        let cardClass = market.signal.type + '-opportunity';
        if (market.watermarkStatus?.belowWatermark) {
            cardClass = 'below-watermark';
        } else if (market.loopOpportunity) {
            cardClass = 'loop-opportunity';
        }

        // Generate loop badge tooltip content
        const loopTooltip = market.loopOpportunity
            ? `${market.loopOpportunity.platform} | LTV: ${(market.loopOpportunity.ltv * 100).toFixed(0)}% | Borrow: ${formatPercent(market.loopOpportunity.borrowRate)} | Leverage: ${market.loopOpportunity.safeLeverage.toFixed(1)}x | Effective APY: ${formatPercent(market.loopOpportunity.effectiveApy)}${market.loopOpportunity.isEstimated ? ' (estimated)' : ''}`
            : '';

        return `
        <div class="market-card ${cardClass}" data-address="${market.address}">
            <div class="market-info">
                <img class="market-icon" src="${market.proIcon || market.icon || ''}" alt="" onerror="this.style.display='none'">
                <div class="market-details">
                    <span class="market-name">
                        ${market.proName || market.name || 'Unknown'}
                        ${market.hasIncentives ? `<span class="incentive-badge" title="${market.incentiveDetails.join(', ') || 'External incentives'}">✨</span>` : ''}
                    </span>
                    <span class="market-expiry">${formatDate(market.expiry)} (${market.days}d)</span>
                </div>
            </div>
            <div class="market-stat">
                <span class="stat-label">TVL</span>
                <span class="stat-value">${formatCurrency(market.tvl)}</span>
            </div>
            <div class="market-stat">
                <span class="stat-label">Underlying</span>
                <span class="stat-value ${market.underlyingApyPercent > market.impliedApyPercent ? 'highlight-yt' : ''} ${market.isPurePoints ? 'pure-points' : ''}" ${market.isPurePoints && market.zeroYieldReason ? `title="${market.zeroYieldReason.title}: ${market.zeroYieldReason.explanation}"` : ''}>${market.isPurePoints ? '0% 🎯' : formatPercent(market.underlyingApyPercent)}</span>
            </div>
            <div class="market-stat">
                <span class="stat-label">Implied</span>
                <span class="stat-value ${market.impliedApyPercent > market.underlyingApyPercent ? 'highlight-pt' : ''}">${formatPercent(market.impliedApyPercent)}</span>
            </div>
            <div class="market-stat">
                <span class="stat-label">Fixed APY</span>
                <span class="stat-value positive">${formatPercent(calculateFixedAPY(market.ptPrice, market.days))}</span>
            </div>
            <div class="market-stat">
                <span class="stat-label">LP APY</span>
                <span class="stat-value ${market.lpApy > market.underlyingApyPercent ? 'highlight-lp' : ''}" ${market.lpApy > market.underlyingApyPercent ? `title="LP yields ${formatPercent(market.lpApy - market.underlyingApyPercent)} more than holding"` : ''}>${formatPercent(market.lpApy)}${market.lpApy > market.underlyingApyPercent ? ' 💎' : ''}</span>
            </div>
            <div class="market-signal">
                ${market.watermarkStatus?.belowWatermark
                    ? `<span class="signal-badge watermark" title="Exchange rate: ${market.watermarkStatus.ratio.toFixed(4)}x of watermark">⚠️ Below Watermark</span>`
                    : market.loopOpportunity
                        ? `<span class="signal-badge loop" title="${loopTooltip}">🔄 Loop +${formatPercent(market.loopOpportunity.apyBoost)}</span>`
                        : market.lpApy > market.underlyingApyPercent && market.lpApy > calculateFixedAPY(market.ptPrice, market.days)
                            ? `<span class="signal-badge lp" title="LP APY beats both underlying and fixed APY">LP Best</span>`
                            : `<span class="signal-badge ${market.signal.type}">${market.signal.label}</span>`
                }
            </div>
        </div>
    `}).join('');

    // Add click handlers
    container.querySelectorAll('.market-card').forEach(card => {
        card.addEventListener('click', () => {
            const address = card.dataset.address;
            selectedMarket = markets.find(m => m.address === address);
            if (selectedMarket) {
                const chainId = document.getElementById('chain-filter')?.value || 1;
                populateCalculatorFromMarket(selectedMarket, chainId);
                switchTab('calculator');
            }
        });
    });
}

// Get Pendle chain name from chain ID
function getPendleChainName(chainId) {
    const chainNames = {
        1: 'ethereum',
        42161: 'arbitrum',
        8453: 'base',
        56: 'bsc',
        146: 'sonic',
        999: 'hyperevm',
        9745: 'berachain'
    };
    return chainNames[chainId] || 'ethereum';
}

// Generate Pendle trade URLs
function getPendleUrls(market, chainId) {
    const chainName = getPendleChainName(chainId);
    const marketAddress = market.address;
    return {
        pt: `https://app.pendle.finance/trade/markets/${marketAddress}/swap?view=pt&chain=${chainName}`,
        yt: `https://app.pendle.finance/trade/markets/${marketAddress}/swap?view=yt&chain=${chainName}`,
        lp: `https://app.pendle.finance/trade/markets/${marketAddress}/swap?view=lp&chain=${chainName}`
    };
}

// Update URL with selected market
function updateUrlWithMarket(market, chainId) {
    const url = new URL(window.location);
    url.searchParams.set('chain', chainId);
    url.searchParams.set('market', market.address);
    window.history.pushState({}, '', url);
}

// Clear market from URL
function clearUrlMarket() {
    const url = new URL(window.location);
    url.searchParams.delete('market');
    window.history.pushState({}, '', url);
}

// Populate calculator inputs from selected market
function populateCalculatorFromMarket(market, chainId) {
    document.getElementById('calc-pt-price').value = market.ptPrice.toFixed(4);
    document.getElementById('calc-yt-price').value = market.ytPrice.toFixed(4);
    document.getElementById('calc-days').value = market.days;
    document.getElementById('calc-underlying-apy').value = market.underlyingApyPercent.toFixed(2);
    document.getElementById('calc-expected-apy').value = market.underlyingApyPercent.toFixed(2);

    // Store watermark status for display
    selectedMarket = market;

    // Get current chain ID
    const currentChainId = chainId || document.getElementById('chain-filter')?.value || 1;

    // Update URL
    updateUrlWithMarket(market, currentChainId);

    // Load historical data
    loadHistoricalData(market);

    // Also update compare tab
    document.getElementById('cmp-pt-price').value = market.ptPrice.toFixed(4);
    document.getElementById('cmp-yt-price').value = market.ytPrice.toFixed(4);
    document.getElementById('cmp-days').value = market.days;

    // Show market banner
    const banner = document.getElementById('selected-market-banner');
    const compareBanner = document.getElementById('compare-market-banner');

    if (banner) {
        banner.style.display = 'flex';
        document.getElementById('banner-icon').src = market.proIcon || market.icon || '';
        document.getElementById('banner-name').textContent = market.proName || market.name;
        document.getElementById('banner-expiry').textContent = `Expires ${formatDate(market.expiry)}`;

        // Update Pendle trade links
        const pendleUrls = getPendleUrls(market, currentChainId);
        document.getElementById('pendle-pt-link').href = pendleUrls.pt;
        document.getElementById('pendle-yt-link').href = pendleUrls.yt;
        document.getElementById('pendle-lp-link').href = pendleUrls.lp;
    }

    if (compareBanner) {
        compareBanner.style.display = 'flex';
        document.getElementById('compare-banner-icon').src = market.proIcon || market.icon || '';
        document.getElementById('compare-banner-name').textContent = market.proName || market.name;
        document.getElementById('compare-banner-expiry').textContent = `Expires ${formatDate(market.expiry)}`;
    }

    // Update looping banner
    const loopingBanner = document.getElementById('looping-market-banner');
    if (loopingBanner && market.loopOpportunity) {
        loopingBanner.style.display = 'flex';
        document.getElementById('looping-banner-icon').src = market.proIcon || market.icon || '';
        document.getElementById('looping-banner-name').textContent = market.proName || market.name;
        document.getElementById('looping-banner-expiry').textContent = `Expires ${formatDate(market.expiry)}`;

        const pendleUrls = getPendleUrls(market, currentChainId);
        document.getElementById('looping-pendle-link').href = pendleUrls.pt;
    } else if (loopingBanner) {
        loopingBanner.style.display = 'none';
    }

    updateCalculator();
    updateCompareCalculator();
    updateLoopingSection();
}

// Position type state
let positionType = 'pt';

// Update calculator
function updateCalculator() {
    const ptPrice = parseFloat(document.getElementById('calc-pt-price').value) || 0.95;
    const ytPrice = parseFloat(document.getElementById('calc-yt-price').value) || 0.05;
    const days = parseFloat(document.getElementById('calc-days').value) || 90;
    const underlyingApy = parseFloat(document.getElementById('calc-underlying-apy').value) || 5;
    const expectedApy = parseFloat(document.getElementById('calc-expected-apy').value) || 5;
    const investment = parseFloat(document.getElementById('calc-investment').value) || 10000;

    // Calculate implied APY
    const impliedApy = calculateImpliedAPY(ytPrice, ptPrice, days);
    const fixedApy = calculateFixedAPY(ptPrice, days);

    // Update implied APY display
    document.getElementById('calc-implied-apy').textContent = formatPercent(impliedApy);

    // Update APY comparison bars
    const maxApy = Math.max(underlyingApy, impliedApy, 1);
    document.getElementById('underlying-bar').style.width = `${(underlyingApy / maxApy) * 100}%`;
    document.getElementById('implied-bar').style.width = `${(impliedApy / maxApy) * 100}%`;
    document.getElementById('underlying-label').textContent = formatPercent(underlyingApy);
    document.getElementById('implied-label').textContent = formatPercent(impliedApy);

    // Update valuation signal
    const signal = getMarketSignal(underlyingApy, impliedApy);
    const signalBody = document.getElementById('signal-body');

    // Check for watermark warning
    if (selectedMarket?.watermarkStatus?.belowWatermark) {
        const ratio = selectedMarket.watermarkStatus.ratio;
        signalBody.innerHTML = `<strong style="color: var(--loss-color);">⚠️ BELOW WATERMARK</strong><br>
            This YT is currently not earning yield. Exchange rate is at ${(ratio * 100).toFixed(2)}% of the watermark.
            YT holders will not receive yield until the rate recovers above the watermark.`;
        signalBody.className = 'signal-body';
    } else if (selectedMarket?.isPurePoints && selectedMarket?.zeroYieldReason) {
        const reason = selectedMarket.zeroYieldReason;
        const icon = reason.type === 'data_issue' ? '⚠️' : reason.type === 'raw_token' ? '📦' : '🎯';
        const color = reason.type === 'data_issue' ? 'var(--loss-color)' : 'var(--warning-color)';
        signalBody.innerHTML = `<strong style="color: ${color};">${icon} ${reason.title}</strong><br>
            ${reason.explanation}<br><br>
            <span style="color: var(--text-muted);">The ${formatPercent(impliedApy)} implied APY suggests the market is pricing in future value from points or incentives.
            YT holders are speculating on airdrop/points value - high risk if expectations aren't met.</span>`;
        signalBody.className = 'signal-body';
    } else if (selectedMarket?.isPurePoints) {
        signalBody.innerHTML = `<strong style="color: var(--warning-color);">🎯 PURE POINTS MARKET</strong><br>
            This market has 0% on-chain yield. The ${formatPercent(impliedApy)} implied APY is entirely from points/airdrops speculation.
            YT value depends entirely on future airdrop valuations - high risk if points don't convert to expected value.`;
        signalBody.className = 'signal-body';
    } else {
        signalBody.textContent = signal.reason;
        signalBody.className = 'signal-body ' + (signal.type !== 'neutral' ? signal.type + '-signal' : '');
    }

    // PT Results
    const ptDiscount = (1 - ptPrice) * 100;
    const ptAmount = investment / ptPrice;
    const ptMaturityValue = ptAmount;
    const ptProfit = ptMaturityValue - investment;

    document.getElementById('calc-fixed-apy').textContent = formatPercent(fixedApy);
    document.getElementById('calc-pt-discount').textContent = formatPercent(ptDiscount);
    document.getElementById('calc-pt-maturity').textContent = formatCurrency(ptMaturityValue);
    document.getElementById('calc-pt-profit').textContent = (ptProfit >= 0 ? '+' : '') + formatCurrency(ptProfit);
    document.getElementById('calc-pt-profit').className = 'result-value ' + (ptProfit >= 0 ? 'profit' : 'loss');

    // YT Results
    const ytLeverage = ytPrice > 0 ? 1 / ytPrice : 0;
    const ytExposure = investment * ytLeverage;
    const periodYield = (expectedApy / 100) * (days / 365);
    const ytGrossYield = ytExposure * periodYield;
    const ytNetYield = ytGrossYield * (1 - PENDLE_FEE);
    const ytPnl = ytNetYield - investment;

    document.getElementById('calc-yt-leverage').textContent = formatNumber(ytLeverage, 1) + 'x';
    document.getElementById('calc-yt-exposure').textContent = formatCurrency(ytExposure);
    document.getElementById('calc-breakeven').textContent = formatPercent(impliedApy);
    document.getElementById('calc-yt-yield').textContent = formatCurrency(ytNetYield);
    document.getElementById('calc-yt-pnl').textContent = (ytPnl >= 0 ? '+' : '') + formatCurrency(ytPnl);
    document.getElementById('calc-yt-pnl').className = 'result-value ' + (ytPnl >= 0 ? 'profit' : 'loss');

    // LP calculations
    // LP is roughly 50% PT + 50% SY, earns swap fees + rewards
    const lpSwapFeeApy = selectedMarket?.swapFeeApy || 2.5;
    const lpIncentiveApy = selectedMarket?.lpRewardApy || 5;
    const lpTotalApy = selectedMarket?.lpApy || (fixedApy * 0.5 + lpSwapFeeApy + lpIncentiveApy);
    const lpPeriodReturn = (lpTotalApy / 100) * (days / 365);
    const lpFinalValue = investment * (1 + lpPeriodReturn);

    // IL risk assessment based on yield volatility
    const lpIlRisk = impliedApy > 30 ? 'Medium-High' : impliedApy > 15 ? 'Low-Medium' : 'Low';

    document.getElementById('calc-lp-apy').textContent = formatPercent(lpTotalApy);
    document.getElementById('calc-lp-pt-exposure').textContent = '~50%';
    document.getElementById('calc-lp-swap-apy').textContent = formatPercent(lpSwapFeeApy);
    document.getElementById('calc-lp-incentive-apy').textContent = formatPercent(lpIncentiveApy);
    document.getElementById('calc-lp-value').textContent = formatCurrency(lpFinalValue);
    document.getElementById('calc-lp-il-risk').textContent = lpIlRisk;

    // Calculate holding comparison
    const holdPeriodYield = (expectedApy / 100) * (days / 365);
    const holdYield = investment * holdPeriodYield;

    let vsHold;
    if (positionType === 'pt') {
        vsHold = ptProfit - holdYield;
    } else if (positionType === 'yt') {
        vsHold = ytPnl - holdYield;
    } else if (positionType === 'lp') {
        vsHold = (lpFinalValue - investment) - holdYield;
    }

    document.getElementById('calc-vs-hold').textContent = (vsHold >= 0 ? '+' : '') + formatCurrency(vsHold);
    document.getElementById('calc-vs-hold').className = 'result-value ' + (vsHold >= 0 ? 'profit' : 'loss');

    // Show/hide appropriate results
    document.getElementById('pt-results').style.display = positionType === 'pt' ? 'block' : 'none';
    document.getElementById('yt-results').style.display = positionType === 'yt' ? 'block' : 'none';
    document.getElementById('lp-results').style.display = positionType === 'lp' ? 'block' : 'none';
}

// Update looping section
function updateLoopingSection() {
    const loopOpportunity = selectedMarket?.loopOpportunity;
    const selectPrompt = document.getElementById('looping-select-prompt');
    const loopingDetails = document.getElementById('looping-details');

    if (!selectedMarket || !loopOpportunity) {
        if (selectPrompt) selectPrompt.style.display = 'flex';
        if (loopingDetails) loopingDetails.style.display = 'none';
        return;
    }

    // Show details, hide prompt
    if (selectPrompt) selectPrompt.style.display = 'none';
    if (loopingDetails) loopingDetails.style.display = 'block';

    // Calculate PT fixed APY
    const ptFixedApy = calculateFixedAPY(selectedMarket.ptPrice, selectedMarket.days);

    // Update metrics
    document.getElementById('loop-effective-apy').textContent = formatPercent(loopOpportunity.effectiveApy);
    document.getElementById('loop-base-apy').textContent = formatPercent(ptFixedApy);
    document.getElementById('loop-apy-boost').textContent = '+' + formatPercent(loopOpportunity.apyBoost);
    document.getElementById('loop-platform').textContent = loopOpportunity.platform + (loopOpportunity.isEstimated ? ' (estimated)' : '');
    document.getElementById('loop-platform-name').textContent = loopOpportunity.platform;
    document.getElementById('loop-collateral').textContent = loopOpportunity.collateralSymbol;
    document.getElementById('loop-borrow-asset').textContent = loopOpportunity.borrowSymbol;
    document.getElementById('loop-ltv').textContent = (loopOpportunity.ltv * 100).toFixed(0) + '%';
    document.getElementById('loop-borrow-rate').textContent = formatPercent(loopOpportunity.borrowRate);
    document.getElementById('loop-safe-leverage').textContent = loopOpportunity.safeLeverage.toFixed(2) + 'x';
    document.getElementById('loop-max-leverage').textContent = loopOpportunity.maxLeverage.toFixed(2) + 'x';
    document.getElementById('loop-liq-buffer').textContent = loopOpportunity.liquidationBuffer.toFixed(1) + '%';

    // Update calculator
    updateLoopCalculator();
}

// Update loop calculator results
function updateLoopCalculator() {
    const loopOpportunity = selectedMarket?.loopOpportunity;
    if (!loopOpportunity) return;

    const investment = parseFloat(document.getElementById('loop-investment')?.value) || 10000;
    const days = selectedMarket.days;
    const ptFixedApy = calculateFixedAPY(selectedMarket.ptPrice, days);

    // Calculate returns
    const loopPeriodReturn = (loopOpportunity.effectiveApy / 100) * (days / 365);
    const loopFinalValue = investment * (1 + loopPeriodReturn);
    const loopProfit = loopFinalValue - investment;

    // Calculate regular PT returns for comparison
    const ptPeriodReturn = (ptFixedApy / 100) * (days / 365);
    const ptFinalValue = investment * (1 + ptPeriodReturn);
    const ptProfit = ptFinalValue - investment;

    const vsPt = loopProfit - ptProfit;

    document.getElementById('loop-expected-value').textContent = formatCurrency(loopFinalValue);
    document.getElementById('loop-expected-profit').textContent = '+' + formatCurrency(loopProfit);
    document.getElementById('loop-vs-pt').textContent = '+' + formatCurrency(vsPt) + ' extra';
    document.getElementById('loop-vs-pt').className = 'result-value profit';
}

// Compare calculator
function updateCompareCalculator() {
    const ptPrice = parseFloat(document.getElementById('cmp-pt-price').value) || 0.95;
    const ytPrice = parseFloat(document.getElementById('cmp-yt-price').value) || 0.05;
    const days = parseFloat(document.getElementById('cmp-days').value) || 90;
    const investment = parseFloat(document.getElementById('cmp-investment').value) || 10000;
    const futureApy = parseFloat(document.getElementById('cmp-underlying-apy').value) || 25;

    document.getElementById('cmp-apy-display').textContent = futureApy + '%';

    const impliedApy = calculateImpliedAPY(ytPrice, ptPrice, days);
    document.getElementById('cmp-breakeven-apy').textContent = formatPercent(impliedApy);

    // PT Strategy (fixed)
    const ptAmount = investment / ptPrice;
    const ptFinal = ptAmount;
    const ptProfit = ptFinal - investment;
    const ptFixedApy = calculateFixedAPY(ptPrice, days);

    // YT Strategy
    const ytLeverage = ytPrice > 0 ? 1 / ytPrice : 0;
    const ytExposure = investment * ytLeverage;
    const ytPeriodYield = (futureApy / 100) * (days / 365);
    const ytGrossYield = ytExposure * ytPeriodYield;
    const ytNetYield = ytGrossYield * (1 - PENDLE_FEE);
    const ytFinal = ytNetYield;
    const ytProfit = ytFinal - investment;

    // LP Strategy
    // LP combines ~50% PT exposure with swap fees and incentives
    const lpSwapFeeApy = selectedMarket?.swapFeeApy || 2.5;
    const lpIncentiveApy = selectedMarket?.lpRewardApy || 5;
    const lpBaseApy = selectedMarket?.lpApy || (ptFixedApy * 0.5 + lpSwapFeeApy + lpIncentiveApy);
    const lpPeriodReturn = (lpBaseApy / 100) * (days / 365);
    const lpFinal = investment * (1 + lpPeriodReturn);
    const lpProfit = lpFinal - investment;

    // Hold Strategy
    const holdPeriodYield = (futureApy / 100) * (days / 365);
    const holdYieldEarned = investment * holdPeriodYield;
    const holdFinal = investment + holdYieldEarned;
    const holdReturn = holdPeriodYield * 100;

    // Update PT card
    document.getElementById('cmp-pt-final').textContent = formatCurrency(ptFinal);
    document.getElementById('cmp-pt-apy').textContent = formatPercent(ptFixedApy);
    document.getElementById('cmp-pt-profit').textContent = (ptProfit >= 0 ? '+' : '') + formatCurrency(ptProfit);
    document.getElementById('cmp-pt-profit').className = ptProfit >= 0 ? 'profit' : 'loss';

    // Update YT card
    document.getElementById('cmp-yt-final').textContent = formatCurrency(ytFinal);
    document.getElementById('cmp-yt-leverage').textContent = formatNumber(ytLeverage, 1) + 'x';
    document.getElementById('cmp-yt-profit').textContent = (ytProfit >= 0 ? '+' : '') + formatCurrency(ytProfit);
    document.getElementById('cmp-yt-profit').className = ytProfit >= 0 ? 'profit' : 'loss';
    document.getElementById('cmp-yt-verdict').textContent = `Profitable if APY > ${formatPercent(impliedApy)}`;

    // Update LP card
    document.getElementById('cmp-lp-final').textContent = formatCurrency(lpFinal);
    document.getElementById('cmp-lp-apy').textContent = formatPercent(lpBaseApy);
    document.getElementById('cmp-lp-profit').textContent = (lpProfit >= 0 ? '+' : '') + formatCurrency(lpProfit);
    document.getElementById('cmp-lp-profit').className = lpProfit >= 0 ? 'profit' : 'loss';
    document.getElementById('cmp-lp-verdict').textContent = 'Swap fees + PT yield + incentives';

    // Update Hold card
    document.getElementById('cmp-hold-final').textContent = formatCurrency(holdFinal);
    document.getElementById('cmp-hold-yield').textContent = formatCurrency(holdYieldEarned);
    document.getElementById('cmp-hold-return').textContent = formatPercent(holdReturn);

    // Determine winner
    const strategies = [
        { name: 'PT', final: ptFinal },
        { name: 'YT', final: ytFinal },
        { name: 'LP', final: lpFinal },
        { name: 'Hold', final: holdFinal }
    ];
    strategies.sort((a, b) => b.final - a.final);
    const winner = strategies[0];
    const secondBest = strategies[1];
    const advantage = winner.final - secondBest.final;

    document.getElementById('winner-name').textContent = winner.name;
    document.getElementById('winner-advantage').textContent = `+${formatCurrency(advantage)} vs next best`;

    // Highlight winner card
    document.querySelectorAll('.comparison-card').forEach(card => card.classList.remove('winner'));
    if (winner.name === 'PT') document.querySelector('.pt-card')?.classList.add('winner');
    if (winner.name === 'YT') document.querySelector('.yt-card')?.classList.add('winner');
    if (winner.name === 'LP') document.querySelector('.lp-card')?.classList.add('winner');
    if (winner.name === 'Hold') document.querySelector('.hold-card')?.classList.add('winner');

    // Update chart
    updateComparisonChart(ptPrice, ytPrice, days, investment);
}

function updateComparisonChart(ptPrice, ytPrice, days, investment) {
    const ctx = document.getElementById('comparison-chart');
    if (!ctx) return;

    const apyRange = [];
    const ptReturns = [];
    const ytReturns = [];
    const lpReturns = [];
    const holdReturns = [];

    const ptAmount = investment / ptPrice;
    const ptFinal = ptAmount;
    const ptReturnFixed = ((ptFinal - investment) / investment) * 100;

    const ytLeverage = ytPrice > 0 ? 1 / ytPrice : 0;
    const ytExposure = investment * ytLeverage;

    // Base LP fees and incentives (independent of APY)
    const lpSwapFeeApy = selectedMarket?.swapFeeApy || 2.5;
    const lpIncentiveApy = selectedMarket?.lpRewardApy || 5;
    const lpBaseReturn = ((lpSwapFeeApy + lpIncentiveApy + ptReturnFixed * 0.5) * (days / 365));

    for (let apy = 0; apy <= 50; apy += 2) {
        apyRange.push(apy);
        ptReturns.push(ptReturnFixed);

        const ytPeriodYield = (apy / 100) * (days / 365);
        const ytGrossYield = ytExposure * ytPeriodYield;
        const ytNetYield = ytGrossYield * (1 - PENDLE_FEE);
        const ytReturn = ((ytNetYield - investment) / investment) * 100;
        ytReturns.push(ytReturn);

        // LP return is relatively stable (slight variation with trading volume)
        lpReturns.push(lpBaseReturn);

        const holdPeriodYield = (apy / 100) * (days / 365);
        const holdReturn = holdPeriodYield * 100;
        holdReturns.push(holdReturn);
    }

    if (comparisonChart) {
        comparisonChart.destroy();
    }

    comparisonChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: apyRange.map(a => a + '%'),
            datasets: [
                {
                    label: 'PT (Fixed)',
                    data: ptReturns,
                    borderColor: '#00d4aa',
                    backgroundColor: 'rgba(0, 212, 170, 0.1)',
                    borderWidth: 2,
                    fill: false,
                    tension: 0.1,
                    pointRadius: 0,
                    pointHoverRadius: 4
                },
                {
                    label: 'YT (Long Yield)',
                    data: ytReturns,
                    borderColor: '#a29bfe',
                    backgroundColor: 'rgba(162, 155, 254, 0.1)',
                    borderWidth: 2,
                    fill: false,
                    tension: 0.1,
                    pointRadius: 0,
                    pointHoverRadius: 4
                },
                {
                    label: 'LP (Balanced)',
                    data: lpReturns,
                    borderColor: '#f472b6',
                    backgroundColor: 'rgba(244, 114, 182, 0.1)',
                    borderWidth: 2,
                    fill: false,
                    tension: 0.1,
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    borderDash: [5, 5]
                },
                {
                    label: 'Hold Underlying',
                    data: holdReturns,
                    borderColor: '#74b9ff',
                    backgroundColor: 'rgba(116, 185, 255, 0.1)',
                    borderWidth: 2,
                    fill: false,
                    tension: 0.1,
                    pointRadius: 0,
                    pointHoverRadius: 4
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            interaction: {
                mode: 'index',
                intersect: false
            },
            plugins: {
                legend: {
                    position: 'top',
                    labels: {
                        color: '#a0a0b0',
                        font: { family: "'Inter', sans-serif", size: 12 },
                        padding: 20,
                        usePointStyle: true
                    }
                },
                tooltip: {
                    backgroundColor: '#1a1a24',
                    titleColor: '#ffffff',
                    bodyColor: '#a0a0b0',
                    borderColor: '#2a2a3a',
                    borderWidth: 1,
                    padding: 12,
                    displayColors: true,
                    callbacks: {
                        label: ctx => ctx.dataset.label + ': ' + ctx.parsed.y.toFixed(2) + '%'
                    }
                }
            },
            scales: {
                x: {
                    title: {
                        display: true,
                        text: 'Future Underlying APY',
                        color: '#606070',
                        font: { family: "'Inter', sans-serif", size: 12 }
                    },
                    ticks: { color: '#606070', font: { family: "'Inter', sans-serif" } },
                    grid: { color: 'rgba(42, 42, 58, 0.5)' }
                },
                y: {
                    title: {
                        display: true,
                        text: 'Period Return (%)',
                        color: '#606070',
                        font: { family: "'Inter', sans-serif", size: 12 }
                    },
                    ticks: {
                        color: '#606070',
                        font: { family: "'Inter', sans-serif" },
                        callback: value => value + '%'
                    },
                    grid: { color: 'rgba(42, 42, 58, 0.5)' }
                }
            }
        }
    });
}

// History chart instance
let historyChart = null;

// Load and display historical data for a market
async function loadHistoricalData(market) {
    const historyCard = document.getElementById('history-card');
    const historyLoading = document.getElementById('history-loading');
    const historyContent = document.getElementById('history-content');
    const chainId = document.getElementById('chain-filter')?.value || 1;

    if (!historyCard) return;

    // Show the card and loading state
    historyCard.style.display = 'block';
    historyLoading.style.display = 'block';
    historyContent.style.display = 'none';

    const history = await fetchHistoricalData(market.address, chainId);

    if (!history) {
        historyLoading.textContent = 'Historical data not available for this market';
        return;
    }

    historyLoading.style.display = 'none';
    historyContent.style.display = 'block';

    // Update implied APY range
    const impliedStats = history.impliedApy.last90d || history.impliedApy.all;
    if (impliedStats) {
        const impliedPercentile = getPercentile(market.impliedApyPercent, impliedStats.min, impliedStats.max);
        const impliedPosition = getYieldPosition(impliedPercentile);

        document.getElementById('implied-range-fill').style.width = '100%';
        document.getElementById('implied-marker').style.left = `${impliedPercentile}%`;
        document.getElementById('implied-min').textContent = formatPercent(impliedStats.min);
        document.getElementById('implied-max').textContent = formatPercent(impliedStats.max);
        document.getElementById('implied-current').textContent = `Current: ${formatPercent(market.impliedApyPercent)}`;
        document.getElementById('implied-percentile').textContent = `${impliedPercentile}th`;
        document.getElementById('implied-position').textContent = impliedPosition.label;
        document.getElementById('implied-position').style.color = impliedPosition.color;
    }

    // Update underlying APY range
    const underlyingStats = history.underlyingApy.last90d || history.underlyingApy.all;
    if (underlyingStats) {
        const underlyingPercentile = getPercentile(market.underlyingApyPercent, underlyingStats.min, underlyingStats.max);
        const underlyingPosition = getYieldPosition(underlyingPercentile);

        document.getElementById('underlying-range-fill').style.width = '100%';
        document.getElementById('underlying-marker').style.left = `${underlyingPercentile}%`;
        document.getElementById('underlying-min').textContent = formatPercent(underlyingStats.min);
        document.getElementById('underlying-max').textContent = formatPercent(underlyingStats.max);
        document.getElementById('underlying-current').textContent = `Current: ${formatPercent(market.underlyingApyPercent)}`;
        document.getElementById('underlying-percentile').textContent = `${underlyingPercentile}th`;
        document.getElementById('underlying-position').textContent = underlyingPosition.label;
        document.getElementById('underlying-position').style.color = underlyingPosition.color;
    }

    // Update spread indicator
    const spread = market.impliedApyPercent - market.underlyingApyPercent;
    const spreadValue = document.getElementById('spread-value');
    const spreadLabel = document.getElementById('spread-label');

    spreadValue.textContent = (spread >= 0 ? '+' : '') + formatPercent(spread);
    spreadValue.className = 'spread-value ' + (spread >= 0 ? 'positive' : 'negative');

    if (spread > 0.5) {
        spreadLabel.textContent = 'Implied above Underlying → PT may be attractive (lock in high rate)';
    } else if (spread < -0.5) {
        spreadLabel.textContent = 'Underlying above Implied → YT may be attractive (market underpricing yield)';
    } else {
        spreadLabel.textContent = 'Spread is tight → Market fairly priced';
    }

    // === NEW ANALYTICS ===

    // 1. Mean Reversion Analysis
    const meanReversionEl = document.getElementById('mean-reversion-analysis');
    if (meanReversionEl && underlyingStats) {
        const meanReversion = getMeanReversionSignal(market.underlyingApyPercent, underlyingStats.avg, underlyingStats.stdDev);
        if (meanReversion) {
            meanReversionEl.innerHTML = `
                <div class="analysis-signal" style="color: ${meanReversion.color}">
                    <span class="signal-icon">${meanReversion.zScore > 0 ? '📈' : meanReversion.zScore < 0 ? '📉' : '➡️'}</span>
                    <span class="signal-text">${meanReversion.signal}</span>
                </div>
                <div class="analysis-detail">${meanReversion.description}</div>
                <div class="analysis-stats">
                    <span>Historical Avg: ${formatPercent(underlyingStats.avg)}</span>
                    <span>Volatility (σ): ${formatPercent(underlyingStats.stdDev)}</span>
                    <span>Z-Score: ${meanReversion.zScore.toFixed(2)}</span>
                </div>
            `;
        }
    }

    // 2. Cross-Asset Comparison
    const crossAssetEl = document.getElementById('cross-asset-analysis');
    if (crossAssetEl) {
        const comparison = getCrossAssetComparison(market, markets);
        if (comparison) {
            crossAssetEl.innerHTML = `
                <div class="analysis-signal" style="color: ${comparison.color}">
                    <span class="signal-icon">⚖️</span>
                    <span class="signal-text">${comparison.signal}</span>
                </div>
                <div class="analysis-detail">
                    Comparing to ${comparison.peerCount} other ${comparison.category} markets
                </div>
                <div class="peer-comparison">
                    <div class="peer-avg">Category Avg Implied: ${formatPercent(comparison.avgImplied)}</div>
                    <div class="peer-list">
                        ${comparison.peers.map(p => `<span class="peer-chip">${p.name}: ${formatPercent(p.impliedApy)}</span>`).join('')}
                    </div>
                </div>
            `;
        } else {
            crossAssetEl.innerHTML = `<div class="analysis-detail">Not enough similar assets for comparison</div>`;
        }
    }

    // 3. Sharpe Ratio Analysis
    const sharpeEl = document.getElementById('sharpe-analysis');
    if (sharpeEl && underlyingStats) {
        const ptFixedApy = calculateFixedAPY(market.ptPrice, market.days);
        const sharpeData = calculateSharpeRatios(
            ptFixedApy,
            market.underlyingApyPercent,
            market.impliedApyPercent,
            underlyingStats.stdDev,
            market.days
        );

        const betterStrategy = sharpeData.pt.sharpe > sharpeData.yt.sharpe ? 'PT' : 'YT';
        const betterColor = betterStrategy === 'PT' ? 'var(--pt-color)' : 'var(--yt-color)';

        sharpeEl.innerHTML = `
            <div class="analysis-signal" style="color: ${betterColor}">
                <span class="signal-icon">📊</span>
                <span class="signal-text">${betterStrategy} has better risk-adjusted return</span>
            </div>
            <div class="sharpe-comparison">
                <div class="sharpe-card ${betterStrategy === 'PT' ? 'highlighted' : ''}">
                    <div class="sharpe-label">PT Sharpe</div>
                    <div class="sharpe-value">${sharpeData.pt.sharpe.toFixed(2)}</div>
                    <div class="sharpe-detail">Vol: ${formatPercent(sharpeData.pt.volatility)}</div>
                </div>
                <div class="sharpe-card ${betterStrategy === 'YT' ? 'highlighted' : ''}">
                    <div class="sharpe-label">YT Sharpe</div>
                    <div class="sharpe-value">${sharpeData.yt.sharpe.toFixed(2)}</div>
                    <div class="sharpe-detail">Vol: ${formatPercent(sharpeData.yt.volatility)}</div>
                </div>
            </div>
            <div class="analysis-detail">Higher Sharpe = better risk-adjusted return (assumes 3% risk-free rate)</div>
        `;
    }

    // 4. ETH Correlation Analysis
    const correlationEl = document.getElementById('correlation-analysis');
    if (correlationEl && history.rawData) {
        // Fetch ETH prices and calculate correlation
        fetchEthPriceHistory().then(ethPrices => {
            if (ethPrices) {
                const correlation = calculateCorrelation(history.rawData, ethPrices);
                if (correlation) {
                    correlationEl.innerHTML = `
                        <div class="analysis-signal" style="color: ${correlation.color}">
                            <span class="signal-icon">🔗</span>
                            <span class="signal-text">ETH Correlation: ${correlation.correlation.toFixed(2)}</span>
                        </div>
                        <div class="correlation-bar">
                            <div class="correlation-scale">
                                <span>-1</span>
                                <span>0</span>
                                <span>+1</span>
                            </div>
                            <div class="correlation-track">
                                <div class="correlation-marker" style="left: ${((correlation.correlation + 1) / 2) * 100}%"></div>
                            </div>
                        </div>
                        <div class="analysis-detail">${correlation.interpretation}</div>
                    `;
                } else {
                    correlationEl.innerHTML = `<div class="analysis-detail">Insufficient data for correlation analysis</div>`;
                }
            } else {
                correlationEl.innerHTML = `<div class="analysis-detail">ETH price data unavailable</div>`;
            }
        });
    }

    // 5. Protocol Verification
    const verificationEl = document.getElementById('verification-analysis');
    if (verificationEl) {
        verificationEl.innerHTML = `<div class="analysis-detail">Verifying with protocol source...</div>`;

        verifyUnderlyingApy(market).then(verification => {
            if (verification.verified) {
                const statusIcon = verification.matches ? '✅' : '⚠️';
                const statusColor = verification.matches ? 'var(--profit-color)' : 'var(--warning-color)';
                const statusText = verification.matches ? 'Verified' : 'Divergence detected';

                verificationEl.innerHTML = `
                    <div class="analysis-signal" style="color: ${statusColor}">
                        <span class="signal-icon">${statusIcon}</span>
                        <span class="signal-text">${statusText}</span>
                    </div>
                    <div class="verification-comparison">
                        <div class="verification-row">
                            <span class="verification-label">Pendle API:</span>
                            <span class="verification-value">${formatPercent(verification.pendleApy)}</span>
                        </div>
                        <div class="verification-row">
                            <span class="verification-label">${verification.source}:</span>
                            <span class="verification-value">${formatPercent(verification.protocolApy)}</span>
                        </div>
                        <div class="verification-row">
                            <span class="verification-label">Difference:</span>
                            <span class="verification-value ${verification.matches ? '' : 'warning'}">${verification.difference.toFixed(3)}% (${verification.percentDiff.toFixed(1)}%)</span>
                        </div>
                    </div>
                    <div class="analysis-detail">
                        ${verification.matches
                            ? `Data verified against ${verification.source}'s official API`
                            : `Pendle data differs from ${verification.source} by ${verification.percentDiff.toFixed(1)}% - may use different calculation methods`
                        }
                    </div>
                `;
            } else {
                verificationEl.innerHTML = `
                    <div class="analysis-signal" style="color: var(--text-muted)">
                        <span class="signal-icon">❓</span>
                        <span class="signal-text">Cannot verify</span>
                    </div>
                    <div class="analysis-detail">${verification.reason}</div>
                `;
            }
        });
    }

    // 6. Watermark History Analysis
    const watermarkHistoryEl = document.getElementById('watermark-history-analysis');
    if (watermarkHistoryEl) {
        const watermarkAnalysis = analyzeWatermarkHistory(history, market.name);

        if (watermarkAnalysis) {
            const riskIcon = watermarkAnalysis.riskLevel === 'high' ? '🚨' :
                            watermarkAnalysis.riskLevel === 'medium' ? '⚠️' : '✅';

            let eventsHtml = '';
            if (watermarkAnalysis.knownEvents.length > 0) {
                eventsHtml = `
                    <div class="known-events">
                        <strong>Known Risk Events:</strong>
                        ${watermarkAnalysis.knownEvents.map(e => `
                            <div class="event-item">
                                <span class="event-date">${e.date}</span>
                                <span class="event-desc">${e.event}</span>
                                ${e.yieldBefore !== undefined ? `
                                    <span class="event-yield">${e.yieldBefore.toFixed(2)}% → ${e.yieldAfter.toFixed(2)}%</span>
                                ` : ''}
                                ${e.source.startsWith('http') ?
                                    `<a href="${e.source}" target="_blank" class="event-link">📰</a>` :
                                    `<span class="event-source">${e.source}</span>`}
                            </div>
                        `).join('')}
                    </div>
                `;
            }

            let breachesHtml = '';
            if (watermarkAnalysis.potentialBreaches.length > 0) {
                breachesHtml = `
                    <div class="breach-list">
                        <strong>Detected Yield Drops:</strong>
                        ${watermarkAnalysis.potentialBreaches.slice(0, 3).map(b => `
                            <div class="breach-item ${b.severity}">
                                <span class="breach-date">${b.date}</span>
                                <span class="breach-change">${b.previousApy.toFixed(2)}% → ${b.newApy.toFixed(2)}%</span>
                                <span class="breach-severity">${b.severity}</span>
                            </div>
                        `).join('')}
                    </div>
                `;
            }

            watermarkHistoryEl.innerHTML = `
                <div class="analysis-signal" style="color: ${watermarkAnalysis.riskColor}">
                    <span class="signal-icon">${riskIcon}</span>
                    <span class="signal-text">Watermark Risk: ${watermarkAnalysis.riskLevel.toUpperCase()}</span>
                </div>
                <div class="watermark-stats">
                    <div class="stat-item">
                        <span class="stat-label">Max Drawdown</span>
                        <span class="stat-value">${watermarkAnalysis.maxDrawdown.toFixed(2)}%</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-label">Yield Volatility</span>
                        <span class="stat-value">${watermarkAnalysis.volatility.toFixed(2)}%</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-label">Risk Periods</span>
                        <span class="stat-value">${watermarkAnalysis.riskPeriods.length}</span>
                    </div>
                </div>
                ${eventsHtml}
                ${breachesHtml}
                <div class="analysis-detail">
                    ${watermarkAnalysis.riskLevel === 'high' ?
                        'This asset has experienced significant yield drops or known loss events. YT holders should monitor closely.' :
                        watermarkAnalysis.riskLevel === 'medium' ?
                        'Some yield volatility detected. Exchange rate may have approached watermark during volatile periods.' :
                        'No significant watermark risk detected in historical data.'}
                </div>
            `;
        } else {
            watermarkHistoryEl.innerHTML = `<div class="analysis-detail">Insufficient data for watermark analysis</div>`;
        }

        // Also try to fetch current on-chain watermark status
        fetchOnChainWatermark(market, chainId).then(onChainData => {
            if (onChainData) {
                const statusEl = document.getElementById('current-watermark-status');
                if (statusEl) {
                    const statusIcon = onChainData.belowWatermark ? '🚨' : '✅';
                    const statusColor = onChainData.belowWatermark ? 'var(--loss-color)' : 'var(--profit-color)';
                    statusEl.innerHTML = `
                        <div class="current-watermark">
                            <span style="color: ${statusColor}">${statusIcon} ${onChainData.belowWatermark ? 'BELOW WATERMARK' : 'Above Watermark'}</span>
                            <span class="watermark-detail">Rate: ${onChainData.currentExchangeRate.toFixed(6)} / WM: ${onChainData.pyIndexStored.toFixed(6)}</span>
                            <span class="watermark-detail">(${onChainData.percentFromWatermark >= 0 ? '+' : ''}${onChainData.percentFromWatermark.toFixed(4)}%)</span>
                        </div>
                    `;
                }
            }
        });
    }

    // Render history chart
    renderHistoryChart(history.rawData);
}

// Calculate moving average
function calculateMovingAverage(data, window = 7) {
    const result = [];
    for (let i = 0; i < data.length; i++) {
        if (i < window - 1) {
            // Not enough data points yet, use available average
            const slice = data.slice(0, i + 1);
            const avg = slice.reduce((a, b) => a + b, 0) / slice.length;
            result.push(avg);
        } else {
            const slice = data.slice(i - window + 1, i + 1);
            const avg = slice.reduce((a, b) => a + b, 0) / window;
            result.push(avg);
        }
    }
    return result;
}

// Render the historical yield chart
function renderHistoryChart(data) {
    const ctx = document.getElementById('history-chart');
    if (!ctx || !data || data.length === 0) return;

    const labels = data.map(d => {
        const date = new Date(d.timestamp);
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    });

    const impliedData = data.map(d => (d.impliedApy || 0) * 100);
    const underlyingData = data.map(d => (d.underlyingApy || 0) * 100);

    // Calculate 7-day moving averages
    const underlying7dMA = calculateMovingAverage(underlyingData, 7);

    if (historyChart) {
        historyChart.destroy();
    }

    historyChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'Implied APY',
                    data: impliedData,
                    borderColor: '#A78BFA',
                    backgroundColor: 'rgba(167, 139, 250, 0.05)',
                    borderWidth: 2,
                    fill: true,
                    tension: 0.4,
                    pointRadius: 0,
                    pointHoverRadius: 4
                },
                {
                    label: 'Underlying APY',
                    data: underlyingData,
                    borderColor: '#60A5FA',
                    backgroundColor: 'rgba(96, 165, 250, 0.05)',
                    borderWidth: 1.5,
                    fill: false,
                    tension: 0.4,
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    borderDash: [4, 2]
                },
                {
                    label: 'Underlying 7D MA',
                    data: underlying7dMA,
                    borderColor: '#2DD4BF',
                    backgroundColor: 'transparent',
                    borderWidth: 2.5,
                    fill: false,
                    tension: 0.4,
                    pointRadius: 0,
                    pointHoverRadius: 4
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            interaction: {
                mode: 'index',
                intersect: false
            },
            plugins: {
                legend: {
                    position: 'top',
                    labels: {
                        color: '#9CA3AF',
                        font: { family: "'Inter', sans-serif", size: 11 },
                        padding: 16,
                        usePointStyle: true,
                        pointStyle: 'line'
                    }
                },
                tooltip: {
                    backgroundColor: '#1A1A1A',
                    titleColor: '#FFFFFF',
                    bodyColor: '#9CA3AF',
                    borderColor: '#2A2A2A',
                    borderWidth: 1,
                    padding: 12,
                    cornerRadius: 8,
                    callbacks: {
                        label: ctx => ctx.dataset.label + ': ' + ctx.parsed.y.toFixed(2) + '%'
                    }
                }
            },
            scales: {
                x: {
                    ticks: {
                        color: '#6B7280',
                        font: { family: "'Inter', sans-serif", size: 10 },
                        maxTicksLimit: 8
                    },
                    grid: { display: false }
                },
                y: {
                    ticks: {
                        color: '#6B7280',
                        font: { family: "'Inter', sans-serif", size: 10 },
                        callback: value => value.toFixed(1) + '%'
                    },
                    grid: { color: 'rgba(42, 42, 42, 0.5)' }
                }
            }
        }
    });
}

// Tab switching
function switchTab(tabName) {
    const tabs = document.querySelectorAll('.tab');
    const sections = document.querySelectorAll('.calculator-section');

    tabs.forEach(t => t.classList.remove('active'));
    sections.forEach(s => s.classList.remove('active'));

    document.querySelector(`[data-tab="${tabName}"]`)?.classList.add('active');
    document.getElementById(`${tabName}-calculator`)?.classList.add('active');

    if (tabName === 'compare') {
        updateCompareCalculator();
    } else if (tabName === 'calculator') {
        updateCalculator();
    } else if (tabName === 'looping') {
        updateLoopingSection();
    }
}

function initTabs() {
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });
}

// Initialize position type toggle
function initToggle() {
    document.querySelectorAll('.toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            positionType = btn.dataset.type;
            updateCalculator();
        });
    });
}

// Initialize event listeners
function initEventListeners() {
    // Calculator inputs
    const calcInputs = ['calc-pt-price', 'calc-yt-price', 'calc-days', 'calc-underlying-apy', 'calc-expected-apy', 'calc-investment'];
    calcInputs.forEach(id => {
        document.getElementById(id)?.addEventListener('input', updateCalculator);
    });

    // Compare inputs
    const cmpInputs = ['cmp-pt-price', 'cmp-yt-price', 'cmp-days', 'cmp-investment', 'cmp-underlying-apy'];
    cmpInputs.forEach(id => {
        document.getElementById(id)?.addEventListener('input', updateCompareCalculator);
    });

    // Filters
    document.getElementById('chain-filter')?.addEventListener('change', e => fetchMarkets(e.target.value));
    document.getElementById('sort-filter')?.addEventListener('change', (e) => {
        currentSortColumn = e.target.value;
        updateSortHeaderUI();
        renderMarkets();
    });
    document.getElementById('signal-filter')?.addEventListener('change', renderMarkets);

    // Search filter
    const searchInput = document.getElementById('search-filter');
    const searchClear = document.getElementById('search-clear');
    const searchWrapper = searchInput?.parentElement;

    searchInput?.addEventListener('input', (e) => {
        const hasValue = e.target.value.length > 0;
        searchWrapper?.classList.toggle('has-value', hasValue);
        renderMarkets();
    });

    searchClear?.addEventListener('click', () => {
        if (searchInput) {
            searchInput.value = '';
            searchWrapper?.classList.remove('has-value');
            renderMarkets();
            searchInput.focus();
        }
    });

    // Legend filter buttons
    document.querySelectorAll('.legend-btn').forEach(btn => {
        // Single click: toggle this category
        btn.addEventListener('click', () => {
            const filter = btn.dataset.filter;
            legendFilters[filter] = !legendFilters[filter];
            btn.classList.toggle('active', legendFilters[filter]);
            renderMarkets();
        });

        // Double click: isolate this category (show only this one)
        btn.addEventListener('dblclick', (e) => {
            e.preventDefault();
            const filter = btn.dataset.filter;

            // Check if this is the only active filter
            const activeFilters = Object.entries(legendFilters).filter(([k, v]) => v);
            const isAlreadyIsolated = activeFilters.length === 1 && activeFilters[0][0] === filter;

            if (isAlreadyIsolated) {
                // If already isolated, show all
                Object.keys(legendFilters).forEach(key => {
                    legendFilters[key] = true;
                });
            } else {
                // Isolate: disable all, enable only this one
                Object.keys(legendFilters).forEach(key => {
                    legendFilters[key] = (key === filter);
                });
            }

            // Update button states
            document.querySelectorAll('.legend-btn').forEach(b => {
                b.classList.toggle('active', legendFilters[b.dataset.filter]);
            });

            renderMarkets();
        });
    });
    document.getElementById('refresh-markets')?.addEventListener('click', () => {
        const chainId = document.getElementById('chain-filter')?.value || 1;
        fetchMarkets(chainId);
    });

    // Clear selection
    document.getElementById('clear-selection')?.addEventListener('click', () => {
        selectedMarket = null;
        document.getElementById('selected-market-banner').style.display = 'none';
        document.getElementById('compare-market-banner').style.display = 'none';
        document.getElementById('looping-market-banner').style.display = 'none';
        document.getElementById('history-card').style.display = 'none';
        clearUrlMarket();
        updateLoopingSection();
    });

    // Looping section clear selection
    document.getElementById('looping-clear-selection')?.addEventListener('click', () => {
        selectedMarket = null;
        document.getElementById('selected-market-banner').style.display = 'none';
        document.getElementById('compare-market-banner').style.display = 'none';
        document.getElementById('looping-market-banner').style.display = 'none';
        document.getElementById('history-card').style.display = 'none';
        clearUrlMarket();
        updateLoopingSection();
    });

    // View loop opportunities button
    document.getElementById('view-loop-markets-btn')?.addEventListener('click', () => {
        // Switch to markets tab and filter by loop opportunities
        switchTab('markets');
        const signalFilter = document.getElementById('signal-filter');
        if (signalFilter) {
            signalFilter.value = 'loop-opportunity';
            renderMarkets();
        }
    });

    // Looping investment input
    document.getElementById('loop-investment')?.addEventListener('input', updateLoopCalculator);

    // Theme toggle
    document.getElementById('theme-toggle')?.addEventListener('click', () => {
        const html = document.documentElement;
        const currentTheme = html.getAttribute('data-theme');
        const newTheme = currentTheme === 'light' ? 'dark' : 'light';
        html.setAttribute('data-theme', newTheme);
        localStorage.setItem('pendash-theme', newTheme);
    });

    // Load saved theme
    const savedTheme = localStorage.getItem('pendash-theme');
    if (savedTheme) {
        document.documentElement.setAttribute('data-theme', savedTheme);
    }

    // Sortable table headers
    document.querySelectorAll('.header-cell.sortable').forEach(header => {
        header.addEventListener('click', () => {
            const sortKey = header.dataset.sort;

            // Toggle direction if clicking same column
            if (currentSortColumn === sortKey) {
                sortDirection = sortDirection === 'desc' ? 'asc' : 'desc';
            } else {
                currentSortColumn = sortKey;
                sortDirection = 'desc';
            }

            // Update sort dropdown to match
            const sortFilter = document.getElementById('sort-filter');
            if (sortFilter) {
                sortFilter.value = sortKey;
            }

            // Update header styling
            document.querySelectorAll('.header-cell.sortable').forEach(h => {
                h.classList.remove('active', 'asc', 'desc');
                h.querySelector('.sort-arrow').textContent = '';
            });
            header.classList.add('active', sortDirection);
            header.querySelector('.sort-arrow').textContent = sortDirection === 'desc' ? '↓' : '↑';

            renderMarkets();
        });
    });

    // Tooltips
    document.querySelectorAll('.help-trigger').forEach(trigger => {
        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            const tooltipId = trigger.dataset.tooltip;
            showTooltip(tooltipId);
        });
    });

    // Close tooltip on overlay click
    document.getElementById('tooltip-overlay')?.addEventListener('click', (e) => {
        if (e.target.id === 'tooltip-overlay') {
            hideTooltip();
        }
    });

    // Close tooltip on Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            hideTooltip();
        }
    });
}

// Show tooltip
function showTooltip(tooltipId) {
    const template = document.getElementById(`tooltip-${tooltipId}`);
    const overlay = document.getElementById('tooltip-overlay');
    const content = document.getElementById('tooltip-content');

    if (template && overlay && content) {
        content.innerHTML = template.innerHTML;
        overlay.classList.add('active');
    }
}

// Hide tooltip
function hideTooltip() {
    const overlay = document.getElementById('tooltip-overlay');
    if (overlay) {
        overlay.classList.remove('active');
    }
}

// Update sort header UI to match current sort state
function updateSortHeaderUI() {
    document.querySelectorAll('.header-cell.sortable').forEach(h => {
        h.classList.remove('active', 'asc', 'desc');
        h.querySelector('.sort-arrow').textContent = '';

        if (h.dataset.sort === currentSortColumn) {
            h.classList.add('active', sortDirection);
            h.querySelector('.sort-arrow').textContent = sortDirection === 'desc' ? '↓' : '↑';
        }
    });
}

// Load market from URL parameters
async function loadMarketFromUrl() {
    const url = new URL(window.location);
    const chainId = url.searchParams.get('chain');
    const marketAddress = url.searchParams.get('market');

    if (chainId && marketAddress) {
        // Set the chain dropdown
        const chainFilter = document.getElementById('chain-filter');
        if (chainFilter) {
            chainFilter.value = chainId;
        }

        // Fetch markets for this chain and find the market
        await fetchMarkets(chainId);

        const market = markets.find(m => m.address === marketAddress);
        if (market) {
            populateCalculatorFromMarket(market, chainId);
            switchTab('calculator');
        }
        return true;
    }
    return false;
}

// Initialize application
async function init() {
    initTabs();
    initToggle();
    initEventListeners();

    // Check for market in URL first
    const loadedFromUrl = await loadMarketFromUrl();

    // If no market in URL, fetch default chain
    if (!loadedFromUrl) {
        fetchMarkets(1);
    }

    // Initial calculations
    updateCalculator();
    updateCompareCalculator();
}

document.addEventListener('DOMContentLoaded', init);
