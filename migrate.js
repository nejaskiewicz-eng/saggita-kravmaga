const { Client } = require('pg');
const client = new Client({
    connectionString: 'postgresql://neondb_owner:npg_6fgIYbnOeWs0@ep-small-sea-agotpuc8-pooler.c-2.eu-central-1.aws.neon.tech/neondb?sslmode=require'
});
async function run() {
    await client.connect();
    try {
        const res = await client.query(`ALTER TABLE registrations ADD COLUMN IF NOT EXISTS doc_data JSONB;`);
        console.log('Migration successful:', res);
    } catch (e) {
        console.error('Migration failed:', e);
    } finally {
        await client.end();
    }
}
run();
