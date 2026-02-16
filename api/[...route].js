// /api/[...route].js
// Bezpieczny proxy-router dla Vercel (CommonJS).
// Kieruje ruch do istniejących handlerów w /api/*.
// Jeśli handler nie istnieje -> 404 zamiast crash.

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
}

function pickFirst(arrOrStr) {
  if (Array.isArray(arrOrStr)) return arrOrStr[0];
  return arrOrStr;
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");

  try {
    // Vercel: req.query.route dla catch-all /api/[...route].js
    const routeParam = req.query?.route;
    const segs = Array.isArray(routeParam)
      ? routeParam
      : (typeof routeParam === "string" && routeParam ? [routeParam] : []);

    const head = segs[0] || "";

    // 1) ADMIN API: /api/admin-api/*
    if (head === "admin-api") {
      // Przekazujemy resztę segmentów do /api/admin-api/[...path].js
      const handler = require("./admin-api/[...path].js");
      req.query = req.query || {};
      req.query.path = segs.slice(1); // ważne: nazwa parametru "path"
      return handler(req, res);
    }

    // 2) Publiczne endpointy używane przez zapisz-sie
    if (head === "schedule") return require("./schedule.js")(req, res);
    if (head === "prices") return require("./prices.js")(req, res);
    if (head === "register") return require("./register.js")(req, res);

    // 3) Jeśli masz dodatkowe pliki (opcjonalnie)
    if (head === "payment-document") return require("./payment-document.js")(req, res);
    if (head === "pay-online") return require("./pay-online.js")(req, res);

    // 4) Fallback
    return res.status(404).json({ error: "Not Found", route: segs });
  } catch (e) {
    // Najważniejsze: NIE crashować funkcji.
    console.error("[api/[...route]]", e);
    return res.status(500).json({
      error: "Server error",
      details: e?.message || String(e),
    });
  }
};
