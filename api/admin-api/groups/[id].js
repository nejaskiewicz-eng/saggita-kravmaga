module.exports = async (req, res) => {
  req.query = req.query || {};
  req.query.path = ['groups', String(req.query.id)];
  return require('../[...path].js')(req, res);
};
