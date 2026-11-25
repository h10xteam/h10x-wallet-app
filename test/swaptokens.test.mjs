// 0.10.2 · Swap ampliado, fase 1: lista revisada de tokens por red y comprobación con el mirror antes de cambiar.
// Sin red: el mirror es de mentira. Los datos de la lista se comprobaron el 25-nov-2026 en mainnet y testnet
// (pools de SaucerSwap contra WHBAR y llaves de cada token).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Mirror, NEW_TOKEN_DAYS, SAUCERSWAP, SWAP_DEFAULT_TOKEN, SWAP_TOKENS, checkPastedToken, checkSwapToken, isReviewedSwapToken, swapSetup, swapTokenList } from "@boveda/core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

/** TokenInfo limpio (como lo devuelve Mirror.tokenInfo) con lo que se quiera cambiar. */
const info = (id, symbol, extra = {}) => ({
  tokenId: id,
  name: symbol,
  symbol,
  decimals: 6,
  fungible: true,
  fees: { fixedHbar: 0n, fixedTokens: [], fractional: 0, royalty: 0 },
  issuerKeys: ["admin", "supply"],
  deleted: false,
  paused: false,
  freezeDefault: false,
  ...extra,
});

test("0.10.2 · la lista: H10X primero en mainnet, SAUCE en testnet, sin repetidos, sin WHBAR y sin acciones", () => {
  for (const net of ["mainnet", "testnet"]) {
    const ids = SWAP_TOKENS[net].map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length, `${net}: sin repetidos`);
    for (const t of SWAP_TOKENS[net]) {
      assert.match(t.id, /^0\.0\.\d+$/);
      assert.ok(t.symbol && t.name, `${t.id} con nombre y símbolo revisados`);
      assert.ok(swapSetup(net, t.id), `${t.id} tiene configuración de swap`);
    }
    assert.ok(!ids.includes(SAUCERSWAP[net].whbar), "WHBAR no se cambia por HBAR");
    assert.equal(ids[0], SWAP_DEFAULT_TOKEN[net], "el token por defecto va primero");
    assert.ok(Object.isFrozen(SWAP_TOKENS[net]) && SWAP_TOKENS[net].every((t) => Object.isFrozen(t)), "no se puede tocar en tiempo de ejecución");
  }
  assert.equal(SWAP_TOKENS.mainnet[0].symbol, "H10X");
  // Acciones tokenizadas (Robinhood vía SODAX) y sus imitaciones: fuera de la fase 1.
  for (const stock of ["0.0.10840033", "0.0.10839711", "0.0.10840034", "0.0.10840039", "0.0.10680993", "0.0.10680985", "0.0.10681352"]) {
    assert.ok(!isReviewedSwapToken("mainnet", stock), `${stock} no está en la lista`);
  }
  // Tokens de Hashport ([hts]): sin respaldo desde el 31-may-2026.
  assert.ok(!isReviewedSwapToken("mainnet", "0.0.1055483"), "WBTC[hts] no");
  assert.ok(!isReviewedSwapToken("mainnet", "0.0.10282787"), "USDT0 fuera: su pool casi no tiene liquidez (54 % de impacto con 10 HBAR)");
  assert.ok(!SWAP_TOKENS.mainnet.some((t) => /\[hts\]/i.test(t.symbol)));
  assert.deepEqual(swapTokenList("previewnet"), []);
});

test("0.10.2 · un token fijado al compilar entra primero, sin nombre revisado, y no se duplica", () => {
  const list = swapTokenList("testnet", " 0.0.777 ");
  assert.deepEqual(list[0], { id: "0.0.777", symbol: "", name: "" });
  assert.equal(list.length, SWAP_TOKENS.testnet.length + 1);
  assert.equal(swapTokenList("testnet", "0.0.1183558").length, SWAP_TOKENS.testnet.length, "si ya está, no se repite");
  assert.equal(swapTokenList("testnet", "no-vale").length, SWAP_TOKENS.testnet.length);
  const c = checkSwapToken(list[0], info("0.0.777", "LO-QUE-SEA"));
  assert.equal(c.ok, true, "sin nombre revisado no se compara el nombre");
  assert.ok(c.warnings.some((w) => /fuera de la lista revisada|outside the reviewed list/.test(w)));
});

test("0.10.2 · checkSwapToken: un token limpio pasa; los poderes del emisor son avisos", () => {
  const usdc = SWAP_TOKENS.mainnet.find((t) => t.symbol === "USDC");
  assert.deepEqual(checkSwapToken(usdc, info(usdc.id, "USDC")), { ok: true, problems: [], warnings: [] });
  const c = checkSwapToken(usdc, info(usdc.id, "USDC", { issuerKeys: ["admin", "freeze", "wipe", "pause"] }));
  assert.equal(c.ok, true);
  assert.equal(c.warnings.length, 3, "congelar, borrar y pausar: se avisa, no se bloquea");
});

test("0.10.2 · checkSwapToken: bloquea lo que haría perder dinero o no poder recibirlo", () => {
  const e = SWAP_TOKENS.mainnet.find((t) => t.symbol === "SAUCE");
  const fixed = { fixedHbar: 1n, fixedTokens: [], fractional: 0, royalty: 0 };
  const cases = [
    ["sin datos del mirror", null, /No se ha podido leer|Couldn't read/],
    ["borrado", info(e.id, "SAUCE", { deleted: true }), /borrado|deleted/],
    ["pausado", info(e.id, "SAUCE", { paused: true }), /pausado|paused/],
    ["nace congelado", info(e.id, "SAUCE", { freezeDefault: true }), /congelado|frozen/],
    ["renombrado (imitación o cambio)", info(e.id, "SAUCEX"), /cambiado de nombre|renamed/],
    ["comisión fija, aunque sea mínima", info(e.id, "SAUCE", { fees: fixed }), /comisión propia|own fee/],
    ["comisión en otro token", info(e.id, "SAUCE", { fees: { ...fixed, fixedHbar: 0n, fixedTokens: [{ tokenId: "0.0.9", amount: 1n }] } }), /comisión propia|own fee/],
    ["se queda una parte", info(e.id, "SAUCE", { fees: { ...fixed, fixedHbar: 0n, fractional: 1 } }), /comisión propia|own fee/],
    ["llave de comisiones", info(e.id, "SAUCE", { issuerKeys: ["feeSchedule"] }), /comisiones en cualquier momento|fees at any time/],
    ["exige KYC", info(e.id, "SAUCE", { issuerKeys: ["kyc"] }), /KYC/],
    ["NFT", info(e.id, "SAUCE", { fungible: false }), /NFT/],
    ["datos de otro token", info("0.0.1", "SAUCE"), /no corresponden|doesn't match/],
  ];
  for (const [name, i, re] of cases) {
    const c = checkSwapToken(e, i);
    assert.equal(c.ok, false, name);
    assert.ok(c.problems.some((p) => re.test(p)), `${name}: ${c.problems.join(" | ")}`);
  }
});

test("0.10.2 · Mirror.tokenInfo lee si el token está borrado, pausado o nace congelado", async () => {
  const body = {
    token_id: "0.0.731861",
    name: "SAUCE",
    symbol: "SAUCE",
    decimals: "6",
    type: "FUNGIBLE_COMMON",
    deleted: true,
    pause_status: "PAUSED",
    freeze_default: true,
    pause_key: { _type: "ED25519", key: "aa" },
    custom_fees: { fixed_fees: [], fractional_fees: [] },
  };
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => body });
  const m = new Mirror("https://mirror.example", fakeFetch);
  const i = await m.tokenInfo("0.0.731861");
  assert.equal(i.deleted, true);
  assert.equal(i.paused, true);
  assert.equal(i.freezeDefault, true);
  assert.deepEqual(i.issuerKeys, ["pause"]);
  const clean = await new Mirror("https://mirror.example", async () => ({ ok: true, status: 200, json: async () => ({ ...body, deleted: false, pause_status: "UNPAUSED", freeze_default: false }) })).tokenInfo("0.0.731861");
  assert.deepEqual([clean.deleted, clean.paused, clean.freezeDefault], [false, false, false]);
});

test("0.10.2 · la app: dos tarjetas con su token, teclado propio, comprobación fresca y destino Cartera o bóveda", () => {
  const screen = read("app/src/screens/Swap.tsx");
  assert.match(screen, /swapTokenList\(NETWORK, swapTokenOverride\)/);
  assert.match(screen, /mirror\.tokenInfo\(id, \{ fresh: true \}\)/, "la comprobación, con datos frescos");
  assert.match(screen, /entry \? \{ \.\.\.checkSwapToken\(entry, info\), reviewed: !!entry\.symbol \} : checkPastedToken\(NETWORK, info\)/, "los de la lista con su ficha; los demás, como pegados");
  assert.match(screen, /&& tokensOk;/, "sin comprobación buena no se puede cambiar");
  assert.match(screen, /if \(current\.current !== key\) return;/, "lo que llegue tarde de otro par no se usa");
  assert.match(screen, /const key = `\$\{pairKey\}:\$\{amountIn \?\? ""\}`;/, "una cotización de otro par o importe no se reutiliza");
  assert.equal((screen.match(/recipientId: dest,/g) ?? []).length, 2, "destino en los dos tipos de cambio");
  assert.match(screen, /const dest = toVault && vaultId \? vaultId : null;/, "la bóveda solo si es la del perfil");
  assert.match(screen, /mode === "route"\s+\? rs && routes\s+\? await withPocket\(\(\{ client, accountId \}\) =>\s+swapTokensFromPocket\(/, "token ↔ token por swaproute");
  assert.match(screen, /if \(checks\.some\(\(c\) => !c\.reviewed\)\) \{/, "un token sin revisar pide confirmación aparte");
  assert.match(screen, /function Keypad\(/);
  assert.match(screen, /onPart\(25\)/);
  assert.match(screen, /function TokenPicker\(/);
  assert.match(screen, /checkPastedToken\(NETWORK, info\) \}\);/, "el ID pegado se comprueba antes de poder usarlo");
  assert.match(screen, /if \(!pasted\?\.info \|\| !pasted\.check\.ok\) return;/, "uno con problemas no se puede elegir");
  assert.doesNotMatch(screen, /FEE_COLLECTOR|serviceFees/, "sigue sin comisión de servicio");
  assert.match(read("core/src/index.js"), /export \* from "\.\/swaptokens\.js";/);
  assert.match(read("core/src/index.js"), /export \* from "\.\/swaproute\.js";/);
});

test("0.10.2 · token pegado: avisa siempre, y bloquea imitaciones, falsos HBAR y webs en el nombre", () => {
  const now = () => Date.UTC(2026, 10, 25);
  const pasted = (id, symbol, name, extra = {}) => checkPastedToken("mainnet", info(id, symbol, { name, ...extra }), { now });
  const fine = pasted("0.0.999", "MEOW", "Meow coin");
  assert.equal(fine.ok, true);
  assert.equal(fine.reviewed, false);
  assert.ok(fine.warnings.some((w) => /No está en la lista revisada|not on the reviewed list/.test(w)));
  for (const [symbol, name, what] of [
    ["USDC", "Otra cosa", "mismo símbolo que uno de la lista"],
    ["XYZ", "USD Coin", "mismo nombre"],
    ["U5DC", "x", "5 por S"],
    ["H1OX", "x", "1 por 1 y O por 0"],
    ["SΑUCE", "x", "A griega"],
  ]) {
    const c = pasted("0.0.998", symbol, name);
    assert.equal(c.ok, false, what);
    assert.ok(c.problems.some((p) => /Se hace pasar por|poses as/.test(p)), `${what}: ${c.problems.join(" | ")}`);
  }
  assert.ok(pasted("0.0.997", "НВАR", "x").problems.some((p) => /HBAR/.test(p)), "HBAR con letras cirílicas");
  assert.ok(pasted("0.0.997", "WHBAR", "x").problems.some((p) => /HBAR/.test(p)));
  assert.ok(pasted("0.0.996", "GIFT", "claim at hbar-gift.com").problems.some((p) => /web|website/.test(p)));
  const young = pasted("0.0.995", "NEW", "New", { createdAt: now() / 1000 - 2 * 86_400 });
  assert.ok(young.warnings.some((w) => /hace 2 días|2 days ago/.test(w)));
  assert.ok(!pasted("0.0.995", "OLD", "Old", { createdAt: now() / 1000 - (NEW_TOKEN_DAYS + 1) * 86_400 }).warnings.some((w) => /Se creó|created/.test(w)));
  // Las comprobaciones de siempre también cuentan.
  assert.equal(pasted("0.0.994", "FEE", "Fee", { issuerKeys: ["feeSchedule"] }).ok, false);
  // Si el ID pegado es de la lista, es la comprobación normal.
  const usdc = checkPastedToken("mainnet", info("0.0.456858", "USDC"), { now });
  assert.deepEqual(usdc, { ok: true, problems: [], warnings: [], reviewed: true });
});

test("0.10.2 · Mirror.tokenInfo da cuándo se creó el token", async () => {
  const m = new Mirror("https://mirror.example", async () => ({ ok: true, status: 200, json: async () => ({ token_id: "0.0.5", name: "X", symbol: "X", decimals: "0", type: "FUNGIBLE_COMMON", created_timestamp: "1784556999.097126000", custom_fees: {} }) }));
  assert.equal((await m.tokenInfo("0.0.5")).createdAt, 1784556999);
});
