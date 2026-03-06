const https = require('https');

// Simulate a ~50kb base64 string
const base64Chunk = "V".repeat(50000);

const rawData = JSON.stringify({
    first_name: "Test",
    last_name: "User",
    email: "test@example.com",
    phone: "123456789",
    group_id: 1,
    is_new: true,
    doc_data: {
        isAdult: false,
        fields: { doc1_parent: "Natalia", doc1_child: "Jaskiewicz" },
        signatures: {
            sig1: "data:image/png;base64," + base64Chunk,
            sig2: "data:image/png;base64," + base64Chunk,
            sig3: "data:image/png;base64," + base64Chunk
        }
    }
});

const options = {
    hostname: 'saggita-kravmaga.vercel.app',
    port: 443,
    path: '/api/register',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(rawData)
    }
};

const req = https.request(options, (res) => {
    console.log('STATUS:', res.statusCode);
    console.log('HEADERS:', res.headers);
    let data = '';
    res.on('data', d => data += d);
    res.on('end', () => console.log('RESPONSE:', data.slice(0, 500)));
});

req.on('error', console.error);
req.write(rawData);
req.end();
