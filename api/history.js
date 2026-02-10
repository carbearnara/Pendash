import { neon } from '@neondatabase/serverless';

const PENDLE_API = 'https://api-v2.pendle.finance/core/v2';
const MAX_HISTORY_DAYS = 180;

// Initialize database connection
const sql = neon(process.env.DATABASE_URL);

// Ensure table exists (runs once on cold start)
let tableInitialized = false;
async function ensureTable() {
    if (tableInitialized) return;
    try {
        await sql`
            CREATE TABLE IF NOT EXISTS historical_data (
                id SERIAL PRIMARY KEY,
                chain_id INTEGER NOT NULL,
                market_address TEXT NOT NULL,
                data JSONB NOT NULL,
                last_timestamp TIMESTAMPTZ,
                updated_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(chain_id, market_address)
            )
        `;
        await sql`
            CREATE INDEX IF NOT EXISTS idx_history_lookup
            ON historical_data(chain_id, market_address)
        `;
        tableInitialized = true;
    } catch (e) {
        console.error('Table init error:', e.message);
    }
}

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

    const chainIdNum = parseInt(chainId);
    const addressLower = address.toLowerCase();

    try {
        await ensureTable();

        // Get cached data from PostgreSQL
        const rows = await sql`
            SELECT data, last_timestamp, updated_at
            FROM historical_data
            WHERE chain_id = ${chainIdNum} AND market_address = ${addressLower}
        `;

        let cachedData = [];
        let lastTimestamp = null;
        let updatedAt = null;

        if (rows.length > 0) {
            cachedData = rows[0].data || [];
            lastTimestamp = rows[0].last_timestamp;
            updatedAt = rows[0].updated_at;
        }

        // Check if cache is fresh (less than 1 hour old)
        const cacheAge = updatedAt ? (Date.now() - new Date(updatedAt).getTime()) : Infinity;
        const cacheFresh = cacheAge < 60 * 60 * 1000; // 1 hour

        // If cache is fresh, return it immediately
        if (cacheFresh && cachedData.length > 0) {
            return res.status(200).json({
                results: cachedData,
                cached: true,
                dataPoints: cachedData.length,
                lastUpdated: updatedAt,
                cacheAge: Math.round(cacheAge / 1000 / 60) + ' minutes'
            });
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
                .slice(-MAX_HISTORY_DAYS);
        } else if (newData.length > 0) {
            mergedData = newData.slice(-MAX_HISTORY_DAYS);
        } else {
            mergedData = cachedData;
        }

        // Update database if we have new data
        if (newData.length > 0 && mergedData.length > 0) {
            const latestTimestamp = mergedData[mergedData.length - 1]?.timestamp;

            await sql`
                INSERT INTO historical_data (chain_id, market_address, data, last_timestamp, updated_at)
                VALUES (${chainIdNum}, ${addressLower}, ${JSON.stringify(mergedData)}, ${latestTimestamp}, NOW())
                ON CONFLICT (chain_id, market_address)
                DO UPDATE SET
                    data = ${JSON.stringify(mergedData)},
                    last_timestamp = ${latestTimestamp},
                    updated_at = NOW()
            `;
        }

        // Return data
        return res.status(200).json({
            results: mergedData,
            cached: cachedData.length > 0,
            dataPoints: mergedData.length,
            lastUpdated: new Date().toISOString()
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
