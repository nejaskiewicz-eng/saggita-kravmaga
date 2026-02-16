// api/admin-api/participants/[id].js
module.exports = async (req, res) => {
  req.query = req.query || {};
  // Vercel route param
  req.query.id = req.query.id || (req.query && req.query.id);
  return require("./index.js")(req, res);
};
