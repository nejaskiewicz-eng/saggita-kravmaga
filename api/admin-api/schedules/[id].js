module.exports = async (req, res) => {
  req.query = req.query || {};
  req.query.path = ['schedules', String(req.query.id)];
  return require('../[...path].js')(req, res);
};
