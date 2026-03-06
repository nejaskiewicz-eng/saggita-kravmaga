const handler = require('./api/register');

const req = {
    method: 'POST',
    body: {
        first_name: 'Natalia',
        last_name: 'Jaśkiewicz',
        email: 'test@example.com',
        phone: '123456789',
        group_id: 1,
        is_new: true,
        price_plan_id: 1, // Let's guess
        doc_data: {
            isAdult: false,
            fields: { doc1_parent: "Natalia" },
            signatures: { sig1: "data:image/png;base64,xxxx" }
        }
    }
};

const res = {
    setHeader: () => { },
    status: function (s) {
        this.statusCode = s;
        return this;
    },
    json: function (j) {
        console.log('Status:', this.statusCode);
        console.log('Response:', j);
    },
    end: () => console.log('End')
};

handler(req, res).catch(console.error);
