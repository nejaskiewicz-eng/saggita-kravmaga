const { Client } = require('pg');
const client = new Client({
    connectionString: 'postgresql://neondb_owner:npg_6fgIYbnOeWs0@ep-small-sea-agotpuc8-pooler.c-2.eu-central-1.aws.neon.tech/neondb?sslmode=require'
});
async function run() {
    await client.connect();
    try {
        const res = await client.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'registrations'");
        console.log(JSON.stringify(res.rows, null, 2));
    } catch (e) {
        console.error(e);
    } finally {
        await client.end();
    }
}
run();
