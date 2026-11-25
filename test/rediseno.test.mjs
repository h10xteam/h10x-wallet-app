// Rediseño (h10x9): logos de tokens validados, precios y cambio en 24 h de cada activo, orden de las listas y avisos.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LOGO_LIMITS, WHBAR_MAINNET, dayChange, formatPct, formatPrice, makeQuote, parseLogo, parseTokenLogos, sortHoldings, svgIsSafe, tokenWarnings } from "../core/src/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const b64 = (s) => Buffer.from(s).toString("base64");
// PNG de 1×1 de verdad (cabecera incluida).
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const SVG_OK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="#6c5"/></svg>';
const sp = (s) => s.replace(/\s/g, " ");

test("logos: PNG y SVG limpios pasan; lo demás se descarta", () => {
  const png = parseLogo(`data:image/png;base64,${PNG}`);
  assert.equal(png?.kind, "raster");
  assert.ok(png.uri.startsWith("data:image/png;base64,"));
  const svg = parseLogo(`data:image/svg+xml;base64,${b64(SVG_OK)}`);
  assert.equal(svg?.kind, "svg");
  assert.match(svg.xml, /<circle/);
  // Lo que dice ser PNG tiene que serlo de verdad.
  assert.equal(parseLogo(`data:image/png;base64,${b64(SVG_OK)}`), null);
  // Otros tipos, base64 roto, http y texto suelto: fuera.
  for (const bad of [`data:image/gif;base64,${PNG}`, "data:image/png;base64,@@@", "https://example.com/logo.png", `data:text/html;base64,${b64("<b>x</b>")}`, 42, null]) assert.equal(parseLogo(bad), null, String(bad));
  // Demasiado grande.
  assert.equal(parseLogo(`data:image/png;base64,${PNG}${"A".repeat(LOGO_LIMITS.base64)}`), null);
});

test("logos: SVG con algo ejecutable o externo no pasa", () => {
  const bad = [
    '<svg><script>alert(1)</script></svg>',
    '<svg onload="alert(1)"><rect/></svg>',
    '<svg><foreignObject><div/></foreignObject></svg>',
    '<svg><image href="https://evil.example/x.png"/></svg>',
    '<svg><use xlink:href="http://evil.example/a.svg#x"/></svg>',
    '<svg><rect style="fill:url(https://evil.example/p)"/></svg>',
    '<!DOCTYPE svg [<!ENTITY x "y">]><svg/>',
    "<html><body>no es un svg</body></html>",
  ];
  for (const s of bad) {
    assert.equal(svgIsSafe(s), false, s);
    assert.equal(parseLogo(`data:image/svg+xml;base64,${b64(s)}`), null, s);
  }
  assert.equal(svgIsSafe('<svg><defs><linearGradient id="g"/></defs><rect fill="url(#g)"/><use href="#g"/></svg>'), true);
});

test("logos: la lista entera solo guarda IDs de Hedera válidos y con tope", () => {
  const raw = { "0.0.1456986": `data:image/png;base64,${PNG}`, "0.0.9770617": `data:image/svg+xml;base64,${b64(SVG_OK)}`, "no-es-un-id": `data:image/png;base64,${PNG}`, "0.0.5": "data:image/png;base64,@@" };
  const m = parseTokenLogos(raw);
  assert.deepEqual([...m.keys()].sort(), ["0.0.1456986", "0.0.9770617"]);
  assert.equal(parseTokenLogos(null).size, 0);
  assert.equal(parseTokenLogos([1, 2]).size, 0);
  assert.equal(parseTokenLogos("x").size, 0);
  const many = Object.fromEntries(Array.from({ length: LOGO_LIMITS.count + 50 }, (_, i) => [`0.0.${i + 1}`, `data:image/png;base64,${PNG}`]));
  assert.equal(parseTokenLogos(many).size, LOGO_LIMITS.count);
});

const NAV = {
  nav: 1.2,
  hbarUsd: 0.2,
  change24h: 1.1,
  components: [
    { symbol: "HBAR", name: "HBAR", tokenId: WHBAR_MAINNET, decimals: 8, units: 1, priceUsd: 0.2, weight: 0.4, targetWeight: null, change24h: 2.4 },
    { symbol: "SAUCE", name: "SaucerSwap", tokenId: "0.0.731861", decimals: 6, units: 1, priceUsd: 0.05, weight: 0.2, targetWeight: null, change24h: -3.2 },
  ],
};
const PRICES = { hbar: { usd: 0.2, eur: 0.18 }, tokens: { "0.0.456858": { usd: 1, eur: 0.9 } }, at: 0, source: "t" };

test("precios: HBAR, H10X (NAV), tokens de la cesta y del guardián, en la moneda elegida", () => {
  const q = makeQuote({ prices: PRICES, nav: NAV, currency: "EUR", network: "mainnet", h10xTokenId: "0.0.10907484" });
  assert.deepEqual(q(null), { price: 0.18, change24h: 2.4 }, "HBAR: precio de siempre y cambio del WHBAR");
  const h = q("0.0.10907484");
  assert.ok(Math.abs(h.price - 1.2 * 0.9) < 1e-9, "H10X: NAV en dólares pasado a euros");
  assert.equal(h.change24h, 1.1);
  const s = q("0.0.731861");
  assert.ok(Math.abs(s.price - 0.045) < 1e-9);
  assert.equal(s.change24h, -3.2);
  assert.deepEqual(q("0.0.456858"), { price: 0.9, change24h: null }, "del guardián, sin cambio en 24 h");
  assert.deepEqual(q("0.0.999"), { price: null, change24h: null }, "sin precio: nunca el de otro token");
  // En dólares.
  assert.ok(Math.abs(makeQuote({ prices: PRICES, nav: NAV, currency: "USD", network: "mainnet", h10xTokenId: "0.0.10907484" })("0.0.731861").price - 0.05) < 1e-9);
});

test("precios: en testnet los IDs de la cesta (de mainnet) no se usan; sin precio del HBAR no hay nada", () => {
  const q = makeQuote({ prices: PRICES, nav: NAV, currency: "EUR", network: "testnet", h10xTokenId: "0.0.10872951" });
  assert.equal(q("0.0.731861").price, null);
  assert.ok(q("0.0.10872951").price > 0, "el H10X de prueba se enseña con el NAV real, como la pantalla de H10X");
  const none = makeQuote({ prices: null, nav: NAV, currency: "EUR", network: "mainnet", h10xTokenId: "0.0.10907484" });
  assert.equal(none(null).price, null);
  assert.equal(none("0.0.10907484").price, null);
});

test("cambio de hoy: suma lo que ha subido y bajado cada activo", () => {
  // Los números de la maqueta: +2,57 € (+0,89 %).
  const items = [
    { value: 141.01, change24h: 2.4 },
    { value: 21.68, change24h: 1.1 },
    { value: 51.5, change24h: -3.2 },
    { value: 15.63, change24h: 0.8 },
    { value: 42.24, change24h: -0.6 },
    { value: 17.8, change24h: 5.1 },
    { value: null, change24h: 9 },
    { value: 10, change24h: null },
  ];
  const c = dayChange(items);
  assert.ok(Math.abs(c.abs - 2.57) < 0.01, String(c.abs));
  assert.ok(Math.abs(c.pct - 0.89) < 0.01, String(c.pct));
  assert.equal(dayChange([{ value: 5, change24h: null }]), null);
  assert.equal(dayChange([]), null);
});

test("formato: precios con los decimales que pide cada uno y % con signo", () => {
  assert.equal(sp(formatPrice(81240, "EUR", "es")), "81.240 €");
  assert.equal(sp(formatPrice(134.21, "EUR", "es")), "134,21 €");
  assert.equal(sp(formatPrice(1.084, "EUR", "es")), "1,084 €");
  assert.equal(sp(formatPrice(0.1652, "EUR", "es")), "0,1652 €");
  assert.equal(sp(formatPrice(0.0089, "EUR", "es")), "0,0089 €");
  assert.equal(formatPrice(0.1652, "USD", "en"), "$0.1652");
  assert.equal(sp(formatPct(2.4, 1, "es")), "+2,4 %");
  assert.equal(sp(formatPct(-3.2, 1, "es")), "−3,2 %");
  assert.equal(formatPct(0.89, 2, "en"), "+0.89%");
});

test("orden: HBAR primero, luego por valor y los que no tienen precio al final", () => {
  const list = [
    { tokenId: "0.0.3", symbol: "ZZZ", value: null },
    { tokenId: "0.0.1", symbol: "SAUCE", value: 51.5 },
    { tokenId: null, symbol: "HBAR", value: 6.81 },
    { tokenId: "0.0.2", symbol: "WBTC", value: 42.24 },
    { tokenId: "0.0.4", symbol: "AAA", value: null },
  ];
  assert.deepEqual(sortHoldings(list).map((x) => x.symbol), ["HBAR", "SAUCE", "WBTC", "AAA", "ZZZ"]);
});

test("avisos de cada token: estafas, comisiones y poderes del emisor", () => {
  const scam = tokenWarnings({ symbol: "CLAIM", name: "Reclama en hbar-gift.com", lang: "es" });
  assert.equal(scam.level, "danger");
  assert.equal(scam.short, "Cuidado");
  assert.equal(tokenWarnings({ symbol: "HBAR", name: "x", lang: "es" }).level, "danger");
  const fee = tokenWarnings({ symbol: "FEE", name: "Fee", lang: "es", info: { tokenId: "0.0.9", name: "Fee", symbol: "FEE", decimals: 0, fungible: true, fees: { fixedHbar: 1_000_000_000n, fixedTokens: [], fractional: 0, royalty: 0 } } });
  assert.equal(fee.level, "danger");
  assert.match(fee.lines.join(" "), /Cobra .* HBAR cada vez/);
  const frz = tokenWarnings({ symbol: "USDX", name: "USDX", lang: "es", info: { tokenId: "0.0.8", name: "USDX", symbol: "USDX", decimals: 6, fungible: true, issuerKeys: ["freeze", "wipe"] } });
  assert.equal(frz.level, "warn");
  assert.equal(frz.short, "Revisar");
  assert.match(frz.lines.join(" "), /congelarlo y borrarlo/);
  const clean = tokenWarnings({ symbol: "H10X", name: "H10X", lang: "es", info: { tokenId: "0.0.10907484", name: "H10X", symbol: "H10X", decimals: 8, fungible: true, issuerKeys: [] } });
  assert.equal(clean.level, null);
  assert.match(clean.lines[0], /Nadie puede congelarlo/);
  assert.deepEqual(tokenWarnings({ symbol: "ABC", name: "ABC", lang: "es" }).lines, [], "sin datos del token no se dice nada");
});

test("la app: barra de abajo sin Ajustes, Ganar en Inicio y sin «Rendimiento» en la lista de cuentas", () => {
  const ui = fs.readFileSync(path.join(ROOT, "app/src/ui.tsx"), "utf8");
  const bar = ui.slice(ui.indexOf("export function TabBar"), ui.indexOf("function TabBarSurface"));
  assert.doesNotMatch(bar, /key: "settings"/);
  assert.match(bar, /key: "home", label: t\("Inicio"/);
  const home = fs.readFileSync(path.join(ROOT, "app/src/screens/Home.tsx"), "utf8");
  assert.match(home, /label=\{t\("Ganar", "Earn"\)\} onPress=\{\(\) => go\("staking"\)\}/);
  assert.doesNotMatch(home, /title=\{t\("Rendimiento"/);
  // Los datos del móvil siguen donde estaban: actualizar no pierde la cartera.
  const cfg = fs.readFileSync(path.join(ROOT, "core/src/config.js"), "utf8");
  assert.match(cfg, /boveda\.\$\{ns\}profile\.v1/);
  assert.match(cfg, /boveda\.\$\{ns\}pocketKey\.v1/);
});

test("crear la bóveda: el mínimo sale del precio del HBAR y cubre lo que costó de verdad en mainnet", async () => {
  const { HBAR, minPocketForVault, vaultSetupReserve } = await import("../core/src/index.js");
  // Medido en mainnet (nov. 2026): 25,17 HBAR de comisiones + 3 del kit = 28,17 HBAR con el HBAR a 0,0497 $.
  const real = 2_817_000_000n;
  const r = vaultSetupReserve(0.0497);
  assert.ok(r >= real && r <= 32n * HBAR, `reserva ${r}`);
  assert.equal(minPocketForVault(0.0497), 31n * HBAR);
  // Si el HBAR sube, hacen falta menos; si baja, más.
  assert.equal(minPocketForVault(0.1), 17n * HBAR);
  assert.ok(minPocketForVault(0.03) > 45n * HBAR);
  // Sin precio, las cifras fijas.
  assert.equal(minPocketForVault(null), 30n * HBAR);
  assert.equal(vaultSetupReserve(undefined), 29n * HBAR);
  // Guardar HBAR al crearla es opcional: el campo empieza en 0.
  const onb = fs.readFileSync(path.join(ROOT, "app/src/screens/Onboarding.tsx"), "utf8");
  assert.match(onb, /const \[amount, setAmount\] = useState\("0"\);/);
});

test("About: la web de H10X y el equipo, al final de Ajustes", () => {
  const about = fs.readFileSync(path.join(ROOT, "app/src/screens/About.tsx"), "utf8");
  for (const [who, role] of [["H10X team", "Design and development"]]) {
    assert.match(about, new RegExp(`person: "${who}", role: "${role}"`));
  }
  assert.match(about, /open\(H10X_WEB\)/);
  const settings = fs.readFileSync(path.join(ROOT, "app/src/screens/Actions.tsx"), "utf8");
  const end = settings.slice(settings.indexOf("export function Settings"));
  assert.ok(end.indexOf('title="About H10X Wallet"') > end.indexOf("Borrar la cartera de este móvil"), "About va lo último");
});
