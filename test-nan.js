const { Client } = require('pg');
const client = new Client({
  connectionString: 'postgresql://neondb_owner:npg_6fgIYbnOeWs0@ep-small-sea-agotpuc8-pooler.c-2.eu-central-1.aws.neon.tech/neondb?sslmode=require'
});
async function run() {
  await client.connect();
  try {
    await client.query("INSERT INTO registrations (first_name, last_name, email, phone, location_id, status, payment_status, total_amount) VALUES ('A','B','c@c.com','1','1','new','unpaid',$1)", [NaN]);
    console.log('Success');
  } catch (e) {
    console.log('Error:', e.message);
  }
  await client.end();
}
run();
