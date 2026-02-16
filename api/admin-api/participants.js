// api/admin-api/participants.js
module.exports = async (req, res) => {
  req.query = req.query || {};
  req.query.path = ["participants"];
  return require("./[...path].js")(req, res);
};
