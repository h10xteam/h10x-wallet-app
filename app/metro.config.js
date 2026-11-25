// Configuración de Metro (el servidor de desarrollo de Expo).
// Además de servir la app, reenvía /guardian/* al guardián que corre en este mismo VPS.
// Así el móvil llega al guardián por el mismo túnel HTTPS de Expo, sin abrir puertos.
const http = require("node:http");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const fs = require("node:fs");
const path = require("node:path");

/** Puerto del guardián: GUARDIAN_INTERNAL_URL si está puesta; si no, el PORT de guardian/.env; si no, 8787. */
function guardianUrl() {
  if (process.env.GUARDIAN_INTERNAL_URL) return process.env.GUARDIAN_INTERNAL_URL;
  let port = "8787";
  try {
    const env = fs.readFileSync(path.join(__dirname, "..", "guardian", ".env"), "utf8");
    const m = /^\s*PORT\s*=\s*["']?(\d+)/m.exec(env);
    if (m) port = m[1];
  } catch {
    // sin guardian/.env: puerto por defecto
  }
  return `http://127.0.0.1:${port}`;
}
const GUARDIAN = new URL(guardianUrl());

/** X-Forwarded-For para el guardián (solo direcciones con forma de IP, como mucho 5). */
function forwardedFor(req) {
  const chain = String(req.headers["x-forwarded-for"] || "")
    .split(",")
    .map((x) => x.trim())
    .filter((x) => /^[0-9a-f.:]{3,45}$/i.test(x));
  const remote = (req.socket && req.socket.remoteAddress) || "";
  if (remote && !/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(remote)) chain.push(remote);
  return chain.slice(-5).join(", ");
}

const previous = config.server?.enhanceMiddleware;
config.server = {
  ...config.server,
  enhanceMiddleware: (middleware, server) => {
    const base = previous ? previous(middleware, server) : middleware;
    return (req, res, next) => {
      if (!req.url || !req.url.startsWith("/guardian/")) return base(req, res, next);
      const upstream = http.request(
        {
          host: GUARDIAN.hostname,
          port: GUARDIAN.port,
          method: req.method,
          path: req.url.replace(/^\/guardian/, ""),
          headers: {
            "content-type": req.headers["content-type"] || "application/json",
            // Para que el guardián limite a quien abusa y no a todos: la cadena que trae el túnel de Expo
            // y, si la conexión no es local, la dirección de quien conecta.
            "x-forwarded-for": forwardedFor(req),
          },
        },
        (up) => {
          res.writeHead(up.statusCode || 502, { "content-type": up.headers["content-type"] || "application/json" });
          up.pipe(res);
        },
      );
      upstream.on("error", () => {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "el guardián no responde" }));
      });
      req.pipe(upstream);
    };
  },
};

module.exports = config;
