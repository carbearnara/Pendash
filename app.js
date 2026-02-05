// Pendash - Pendle Calculator with Live Market Data

const PENDLE_FEE = 0.05; // 5% fee on YT yield
const API_BASE = 'https://api-v2.pendle.finance/core';

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
};

// Minimal ABIs for watermark checking
const SY_ABI = ['function exchangeRate() view returns (uint256)'];
const YT_ABI = ['function pyIndexStored() view returns (uint256)', 'function SY() view returns (address)'];

// Cache for watermark status
const watermarkCache = new Map();

// Cache for historical data
const historyCache = new Map();

// State
let markets = [];
let selectedMarket = null;
let comparisonChart = null;
let legendFilters = { pt: true, yt: true, neutral: true, watermark: true };

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
            return {
                min: Math.min(...values),
                max: Math.max(...values),
                avg: values.reduce((a, b) => a + b, 0) / values.length,
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
            rawData: results.slice(-90) // Keep last 90 days for charting
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
                        if (data && (data.results || Array.isArray(data))) {
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

        if (markets.length === 0) throw new Error('No markets returned');

        console.log(`Loaded ${markets.length} markets`);

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

            return {
                ...market,
                days,
                underlyingApyPercent: underlyingApy,
                impliedApyPercent: impliedApy,
                ptPrice,
                ytPrice,
                discount,
                signal: getMarketSignal(underlyingApy, impliedApy),
                tvl,
                proName: market.name,
                proIcon: market.icon || ''
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
    const sortBy = document.getElementById('sort-filter')?.value || 'tvl';
    const signalFilter = document.getElementById('signal-filter')?.value || 'all';

    let filtered = [...markets];

    // Filter by signal dropdown
    if (signalFilter === 'pt-opportunity') {
        filtered = filtered.filter(m => m.signal.type === 'pt');
    } else if (signalFilter === 'yt-opportunity') {
        filtered = filtered.filter(m => m.signal.type === 'yt');
    } else if (signalFilter === 'below-watermark') {
        filtered = filtered.filter(m => m.watermarkStatus?.belowWatermark);
    }

    // Filter by legend buttons
    filtered = filtered.filter(m => {
        if (m.watermarkStatus?.belowWatermark) return legendFilters.watermark;
        if (m.signal.type === 'pt') return legendFilters.pt;
        if (m.signal.type === 'yt') return legendFilters.yt;
        return legendFilters.neutral;
    });

    // Sort
    filtered.sort((a, b) => {
        switch (sortBy) {
            case 'tvl': return (b.tvl || 0) - (a.tvl || 0);
            case 'bonusApr': return (b.impliedApyPercent - b.underlyingApyPercent) - (a.impliedApyPercent - a.underlyingApyPercent);
            case 'fixedApy': return calculateFixedAPY(b.ptPrice, b.days) - calculateFixedAPY(a.ptPrice, a.days);
            case 'underlyingApy': return b.underlyingApyPercent - a.underlyingApyPercent;
            case 'impliedApy': return b.impliedApyPercent - a.impliedApyPercent;
            case 'expiry': return a.days - b.days;
            default: return 0;
        }
    });

    if (filtered.length === 0) {
        container.innerHTML = '<div class="loading">No markets match your filters</div>';
        return;
    }

    container.innerHTML = filtered.map(market => `
        <div class="market-card ${market.watermarkStatus?.belowWatermark ? 'below-watermark' : market.signal.type + '-opportunity'}" data-address="${market.address}">
            <div class="market-info">
                <img class="market-icon" src="${market.proIcon || market.icon || ''}" alt="" onerror="this.style.display='none'">
                <div class="market-details">
                    <span class="market-name">${market.proName || market.name || 'Unknown'}</span>
                    <span class="market-expiry">${formatDate(market.expiry)} (${market.days}d)</span>
                </div>
            </div>
            <div class="market-stat">
                <span class="stat-label">TVL</span>
                <span class="stat-value">${formatCurrency(market.tvl)}</span>
            </div>
            <div class="market-stat">
                <span class="stat-label">Underlying</span>
                <span class="stat-value ${market.underlyingApyPercent > market.impliedApyPercent ? 'highlight-yt' : ''}">${formatPercent(market.underlyingApyPercent)}</span>
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
                <span class="stat-label">${market.signal.type === 'pt' ? 'Bonus APR' : 'Spread'}</span>
                <span class="stat-value ${market.impliedApyPercent > market.underlyingApyPercent ? 'highlight-pt' : market.underlyingApyPercent > market.impliedApyPercent ? 'highlight-yt' : ''}">${market.impliedApyPercent > market.underlyingApyPercent ? '+' : ''}${formatPercent(market.impliedApyPercent - market.underlyingApyPercent)}</span>
            </div>
            <div class="market-signal">
                ${market.watermarkStatus?.belowWatermark
                    ? `<span class="signal-badge watermark" title="Exchange rate: ${market.watermarkStatus.ratio.toFixed(4)}x of watermark">⚠️ Below Watermark</span>`
                    : `<span class="signal-badge ${market.signal.type}">${market.signal.label}</span>`
                }
            </div>
        </div>
    `).join('');

    // Add click handlers
    container.querySelectorAll('.market-card').forEach(card => {
        card.addEventListener('click', () => {
            const address = card.dataset.address;
            selectedMarket = markets.find(m => m.address === address);
            if (selectedMarket) {
                populateCalculatorFromMarket(selectedMarket);
                switchTab('calculator');
            }
        });
    });
}

// Populate calculator inputs from selected market
function populateCalculatorFromMarket(market) {
    document.getElementById('calc-pt-price').value = market.ptPrice.toFixed(4);
    document.getElementById('calc-yt-price').value = market.ytPrice.toFixed(4);
    document.getElementById('calc-days').value = market.days;
    document.getElementById('calc-underlying-apy').value = market.underlyingApyPercent.toFixed(2);
    document.getElementById('calc-expected-apy').value = market.underlyingApyPercent.toFixed(2);

    // Store watermark status for display
    selectedMarket = market;

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
    }

    if (compareBanner) {
        compareBanner.style.display = 'flex';
        document.getElementById('compare-banner-icon').src = market.proIcon || market.icon || '';
        document.getElementById('compare-banner-name').textContent = market.proName || market.name;
        document.getElementById('compare-banner-expiry').textContent = `Expires ${formatDate(market.expiry)}`;
    }

    updateCalculator();
    updateCompareCalculator();
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

    // Calculate holding comparison
    const holdPeriodYield = (expectedApy / 100) * (days / 365);
    const holdYield = investment * holdPeriodYield;

    let vsHold;
    if (positionType === 'pt') {
        vsHold = ptProfit - holdYield;
    } else {
        vsHold = ytPnl - holdYield;
    }

    document.getElementById('calc-vs-hold').textContent = (vsHold >= 0 ? '+' : '') + formatCurrency(vsHold);
    document.getElementById('calc-vs-hold').className = 'result-value ' + (vsHold >= 0 ? 'profit' : 'loss');

    // Show/hide appropriate results
    document.getElementById('pt-results').style.display = positionType === 'pt' ? 'block' : 'none';
    document.getElementById('yt-results').style.display = positionType === 'yt' ? 'block' : 'none';
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

    // Update Hold card
    document.getElementById('cmp-hold-final').textContent = formatCurrency(holdFinal);
    document.getElementById('cmp-hold-yield').textContent = formatCurrency(holdYieldEarned);
    document.getElementById('cmp-hold-return').textContent = formatPercent(holdReturn);

    // Determine winner
    const strategies = [
        { name: 'PT', final: ptFinal },
        { name: 'YT', final: ytFinal },
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
    const holdReturns = [];

    const ptAmount = investment / ptPrice;
    const ptFinal = ptAmount;
    const ptReturnFixed = ((ptFinal - investment) / investment) * 100;

    const ytLeverage = ytPrice > 0 ? 1 / ytPrice : 0;
    const ytExposure = investment * ytLeverage;

    for (let apy = 0; apy <= 50; apy += 2) {
        apyRange.push(apy);
        ptReturns.push(ptReturnFixed);

        const ytPeriodYield = (apy / 100) * (days / 365);
        const ytGrossYield = ytExposure * ytPeriodYield;
        const ytNetYield = ytGrossYield * (1 - PENDLE_FEE);
        const ytReturn = ((ytNetYield - investment) / investment) * 100;
        ytReturns.push(ytReturn);

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
    document.getElementById('sort-filter')?.addEventListener('change', renderMarkets);
    document.getElementById('signal-filter')?.addEventListener('change', renderMarkets);

    // Legend filter buttons
    document.querySelectorAll('.legend-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const filter = btn.dataset.filter;
            legendFilters[filter] = !legendFilters[filter];
            btn.classList.toggle('active', legendFilters[filter]);
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
        document.getElementById('history-card').style.display = 'none';
    });
}

// Initialize application
function init() {
    initTabs();
    initToggle();
    initEventListeners();

    // Fetch initial markets
    fetchMarkets(1);

    // Initial calculations
    updateCalculator();
    updateCompareCalculator();
}

document.addEventListener('DOMContentLoaded', init);
