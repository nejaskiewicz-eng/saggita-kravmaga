// api/saggita.js — centralny router (JEDNA funkcja Vercel)
// Obsługuje wszystkie moduły przez ?_module=
module.exports = async (req, res) => {
  const m = req.query._module;
  if (m === 'registrations')         return require('./_saggita/registrations')(req, res);
  if (m === 'students')              return require('./_saggita/students')(req, res);

  // Instruktor — wszystko w panel.js
  if (m === 'instructor-auth')       return require('./_saggita/panel')(req, res);
  if (m === 'instructor-panel')      return require('./_saggita/panel')(req, res);
  if (m === 'instructor-attendance') return require('./_saggita/panel')(req, res);
  if (m === 'instructor-students')   return require('./_saggita/panel')(req, res);
  if (m === 'instructor-calendar')   return require('./_saggita/panel')(req, res);

  return res.status(404).json({ error: 'Nieznany moduł: ' + m });
};
