const { getPool } = require('./_lib/db');

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const pool = getPool();
    try {
        const start = Date.now();
        await pool.query('SELECT 1');
        const duration = Date.now() - start;
        return res.status(200).json({ status: 'ok', db: 'connected', latency: duration + 'ms', timestamp: new Date().toISOString() });
    } catch (e) {
        return res.status(500).json({ status: 'error', message: e.message, env_db: !!process.env.DATABASE_URL });
    }
};
