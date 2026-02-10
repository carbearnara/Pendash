import { kv } from '@vercel/kv';

const PENDLE_API = 'https://api-v2.pendle.finance/core/v2';
const CACHE_TTL = 60 * 60 * 24 * 7; // 7 days in KV
const MAX_HISTORY_DAYS = 180;

export default async function handler(req, res) {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const { chainId, address } = req.query;

    if (!chainId || !address) {
        return res.status(400).json({ error: 'Missing chainId or address' });
    }

    const cacheKey = `history:${chainId}:${address.toLowerCase()}`;

    try {
        // Get cached data from KV
        let cached = await kv.get(cacheKey);
        let cachedData = cached?.data || [];
        let lastTimestamp = cached?.lastTimestamp || null;

        // Determine how many days to fetch
        let daysToFetch = MAX_HISTORY_DAYS;
        if (lastTimestamp) {
            const lastDate = new Date(lastTimestamp);
            const now = new Date();
            const daysSinceUpdate = Math.ceil((now - lastDate) / (1000 * 60 * 60 * 24));
            daysToFetch = Math.min(daysSinceUpdate + 1, 14); // Fetch at most 14 days of new data
        }

        // Fetch new data from Pendle API
        const pendleUrl = `${PENDLE_API}/${chainId}/markets/${address}/historical-data?time_frame=day`;
        let newData = [];

        try {
            const response = await fetch(pendleUrl);
            if (response.ok) {
                const json = await response.json();
                newData = json.results || [];
            }
        } catch (e) {
            console.error('Pendle API fetch failed:', e.message);
        }

        // If we have cached data, merge with new data
        let mergedData;
        if (cachedData.length > 0 && newData.length > 0) {
            // Create a map of existing data by date
            const dataMap = new Map();

            // Add cached data first
            for (const point of cachedData) {
                const dateKey = point.timestamp?.split('T')[0];
                if (dateKey) {
                    dataMap.set(dateKey, point);
                }
            }

            // Overlay with new data (newer takes precedence)
            for (const point of newData) {
                const dateKey = point.timestamp?.split('T')[0];
                if (dateKey) {
                    dataMap.set(dateKey, point);
                }
            }

            // Convert back to sorted array
            mergedData = Array.from(dataMap.values())
                .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
                .slice(-MAX_HISTORY_DAYS); // Keep last N days
        } else if (newData.length > 0) {
            mergedData = newData.slice(-MAX_HISTORY_DAYS);
        } else {
            mergedData = cachedData;
        }

        // Update cache if we have new data
        if (newData.length > 0 && mergedData.length > 0) {
            const latestTimestamp = mergedData[mergedData.length - 1]?.timestamp;
            await kv.set(cacheKey, {
                data: mergedData,
                lastTimestamp: latestTimestamp,
                updatedAt: new Date().toISOString()
            }, { ex: CACHE_TTL });
        }

        // Return data
        return res.status(200).json({
            results: mergedData,
            cached: cachedData.length > 0,
            dataPoints: mergedData.length,
            lastUpdated: cached?.updatedAt || new Date().toISOString()
        });

    } catch (error) {
        console.error('History API error:', error);

        // Fallback: try to fetch directly from Pendle
        try {
            const pendleUrl = `${PENDLE_API}/${chainId}/markets/${address}/historical-data?time_frame=day`;
            const response = await fetch(pendleUrl);
            if (response.ok) {
                const json = await response.json();
                return res.status(200).json({
                    results: json.results || [],
                    cached: false,
                    fallback: true
                });
            }
        } catch (e) {
            console.error('Fallback fetch failed:', e.message);
        }

        return res.status(500).json({ error: 'Failed to fetch historical data' });
    }
}
