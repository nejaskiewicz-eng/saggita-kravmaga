module.exports = async (req, res) => {
  const m = req.query._module;
  if (m === 'registrations') return require('./_saggita/registrations')(req, res);
  if (m === 'students') return require('./_saggita/students')(req, res);
  if (m === 'instructor-auth') return require('./_saggita/auth')(req, res);
  if (m === 'instructor-panel') return require('./_saggita/panel')(req, res);
  if (m === 'instructor-attendance') return require('./_saggita/attendance')(req, res);
  return res.status(404).json({error: 'Not found'});
}