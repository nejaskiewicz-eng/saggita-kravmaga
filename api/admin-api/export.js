// api/admin-api/export.js  — eksport CSV (wrapper nad plans.js)
// Oddzielny plik bo Vercel wymaga osobnego handlerADRES dla każdego URL
const { exportCSV } = require('./plans');
module.exports = exportCSV;
