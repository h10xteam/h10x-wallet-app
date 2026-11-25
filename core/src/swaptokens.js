// @ts-check
// Tokens que se pueden cambiar en la app (swap ampliado, fase 1): una lista REVISADA por red, nunca «cualquier token».
//
// Cada token de la lista se ha comprobado a mano (25-nov-2026, mirror de Hedera y fábricas de SaucerSwap):
//   - tiene pool con WHBAR en SaucerSwap (V1 y/o V2);
//   - no cobra comisiones propias ni tiene llave para ponerlas (fee_schedule_key);
//   - no exige KYC, no nace congelado y no está pausado.
// Aun así, la app lo vuelve a comprobar con el mirror cada vez que se elige (checkSwapToken): si algo ha cambiado
// (lo han pausado, borrado, renombrado…), ese token no se deja cambiar hasta revisarlo.
// Las acciones tokenizadas NO están aquí: son otra fase (consulta legal antes).
// USDT0 (0.0.10282787) salió de la lista el 25-nov-2026: su pool casi no tiene liquidez (con 10 HBAR el precio se
// movía un 54 %). Vuelve cuando la tenga: scripts/cotizar.mjs (con «todos») lo comprueba.
import { tr } from "./i18n.js";
import { tokenRisks } from "./risks.js";
import { fakesHbar, hasLink } from "./scamtext.js";

/**
 * @typedef {{ id: string, symbol: string, name: string }} SwapTokenEntry
 *   symbol/name: los que tenía el token al revisarlo (si el emisor los cambia, se bloquea hasta revisarlo)
 */

/** @type {Readonly<Record<"mainnet" | "testnet", ReadonlyArray<Readonly<SwapTokenEntry>>>>} */
export const SWAP_TOKENS = Object.freeze({
  mainnet: Object.freeze([
    Object.freeze({ id: "0.0.10907484", symbol: "H10X", name: "H10X Index" }),
    Object.freeze({ id: "0.0.456858", symbol: "USDC", name: "USD Coin" }),
    Object.freeze({ id: "0.0.731861", symbol: "SAUCE", name: "SAUCE" }),
    Object.freeze({ id: "0.0.1460200", symbol: "XSAUCE", name: "xSAUCE" }),
    Object.freeze({ id: "0.0.834116", symbol: "HBARX", name: "HBARX" }),
    Object.freeze({ id: "0.0.4794920", symbol: "PACK", name: "PACK" }),
    Object.freeze({ id: "0.0.8279134", symbol: "BONZO", name: "BONZO" }),
    Object.freeze({ id: "0.0.968069", symbol: "HST", name: "HeadStarter" }),
    Object.freeze({ id: "0.0.3716059", symbol: "DOVU", name: "Dovu" }),
    Object.freeze({ id: "0.0.2283230", symbol: "KARATE", name: "Karate" }),
    Object.freeze({ id: "0.0.1159074", symbol: "GRELF", name: "GRELF" }),
  ]),
  // Testnet: los tokens de prueba de SaucerSwap con pool V2 contra su WHBAR.
  testnet: Object.freeze([
    Object.freeze({ id: "0.0.1183558", symbol: "SAUCE", name: "Sauce" }),
    Object.freeze({ id: "0.0.5449", symbol: "USDC", name: "USD Coin" }),
    Object.freeze({ id: "0.0.2231533", symbol: "HBARX", name: "Hbarx" }),
    Object.freeze({ id: "0.0.3772909", symbol: "KARATE", name: "Karate Combat" }),
    Object.freeze({ id: "0.0.5365", symbol: "CLXY", name: "Calaxy" }),
  ]),
});

/**
 * Lista de tokens para una red. `extra`: un token fijado al compilar (EXPO_PUBLIC_SWAP_TOKEN_ID) que no esté en la
 * lista; entra sin nombre revisado (symbol vacío) y pasa las mismas comprobaciones salvo la del nombre.
 * @param {string} network @param {string | null | undefined} [extra]
 * @returns {SwapTokenEntry[]}
 */
export function swapTokenList(network, extra) {
  const list = network === "mainnet" || network === "testnet" ? [...SWAP_TOKENS[network]] : [];
  const id = typeof extra === "string" ? extra.trim() : "";
  if (/^0\.0\.\d+$/.test(id) && !list.some((t) => t.id === id)) list.unshift({ id, symbol: "", name: "" });
  return list;
}

/** ¿Está este token en la lista revisada de la red? @param {string} network @param {string} tokenId */
export const isReviewedSwapToken = (network, tokenId) => (network === "mainnet" || network === "testnet") && SWAP_TOKENS[network].some((t) => t.id === tokenId);

/**
 * Comprobación de un token antes de dejar cambiarlo, con lo que dice el mirror AHORA.
 *   problems: lo que impide cambiarlo (se enseña y el botón no se activa).
 *   warnings: lo que se puede hacer igualmente, pero el usuario debe saber.
 * @param {SwapTokenEntry} entry
 * @param {(import("./mirror.js").TokenInfo & { deleted?: boolean, paused?: boolean, freezeDefault?: boolean }) | null} info
 * @returns {{ ok: boolean, problems: string[], warnings: string[] }}
 */
export function checkSwapToken(entry, info) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const warnings = [];
  if (!info) return { ok: false, problems: [tr("No se ha podido leer el token en la red. Prueba en un rato.", "Couldn't read the token on the network. Try again later.")], warnings };
  if (info.tokenId !== entry.id) problems.push(tr("Los datos del token no corresponden al elegido.", "The token data doesn't match the one chosen."));
  if (!info.fungible) problems.push(tr("Es un NFT: aquí solo se cambian tokens.", "It's an NFT: only tokens are swapped here."));
  if (info.deleted) problems.push(tr("El emisor ha borrado este token.", "The issuer has deleted this token."));
  if (info.paused) problems.push(tr("El emisor ha pausado este token: ahora no se puede mover.", "The issuer has paused this token: it can't move right now."));
  if (info.freezeDefault) problems.push(tr("Este token nace congelado en cada cuenta.", "This token starts frozen in every account."));
  if (entry.symbol && info.symbol !== entry.symbol) {
    problems.push(
      tr(
        `El token ha cambiado de nombre (antes ${entry.symbol}, ahora ${info.symbol}). No se deja cambiar hasta revisarlo.`,
        `The token has been renamed (was ${entry.symbol}, now ${info.symbol}). Swapping is blocked until it's reviewed.`,
      ),
    );
  }
  const r = tokenRisks(info);
  if (r.anyFixedFee || r.takesShare) problems.push(tr("Cobra una comisión propia cada vez que se mueve.", "It charges its own fee every time it moves."));
  if (r.canChangeFees) problems.push(tr("Su emisor puede ponerle comisiones en cualquier momento.", "Its issuer can add fees at any time."));
  const keys = info.issuerKeys ?? [];
  if (keys.includes("kyc")) problems.push(tr("Exige que el emisor te apruebe (KYC) antes de poder recibirlo.", "The issuer must approve you (KYC) before you can receive it."));
  if (keys.includes("freeze")) warnings.push(tr("Su emisor puede congelar tu saldo.", "Its issuer can freeze your balance."));
  if (keys.includes("wipe")) warnings.push(tr("Su emisor puede borrar tu saldo.", "Its issuer can wipe your balance."));
  if (keys.includes("pause") && !info.paused) warnings.push(tr("Su emisor puede pausar todos los movimientos.", "Its issuer can pause all movements."));
  if (!entry.symbol) warnings.push(tr("Token fijado en esta versión, fuera de la lista revisada.", "Token fixed in this build, outside the reviewed list."));
  return { ok: problems.length === 0, problems, warnings };
}

/** Para comparar nombres: mayúsculas, sin espacios ni signos, letras cirílicas/griegas parecidas y 0/1 como O/I. @param {unknown} v */
function looks(v) {
  const MAP = /** @type {Record<string, string>} */ ({ А: "A", В: "B", С: "C", Е: "E", Н: "H", І: "I", К: "K", М: "M", О: "O", Р: "P", Ѕ: "S", Т: "T", Х: "X", У: "Y", Α: "A", Β: "B", Ε: "E", Η: "H", Ι: "I", Κ: "K", Μ: "M", Ν: "N", Ο: "O", Ρ: "P", Τ: "T", Χ: "X", Υ: "Y", Ζ: "Z", "0": "O", "1": "I", L: "I", "5": "S" });
  return String(v ?? "")
    .normalize("NFKC")
    .toUpperCase()
    .replace(/./gu, (c) => MAP[c] ?? c)
    .replace(/[^A-Z0-9]/g, "");
}

/** Tesorería desde la que SODAX emite en Hedera las acciones tokenizadas de Robinhood (core/src/stocks.js). */
export const ROBINHOOD_TREASURY = "0.0.10495816";

/** Días que se consideran «recién creado» para un token pegado. */
export const NEW_TOKEN_DAYS = 7;

/**
 * Comprobación de un token PEGADO por su ID (fuera de la lista, fase 2). Si resulta que está en la lista, es la
 * comprobación normal. Si no, lo mismo que checkSwapToken y además:
 *   - bloquea si se hace pasar por uno de la lista (mismo símbolo o nombre, con letras parecidas) o por HBAR, o si
 *     lleva una web en el nombre (la marca de las estafas de «regalos»);
 *   - avisa siempre de que nadie lo ha revisado, y si es de hace menos de NEW_TOKEN_DAYS días.
 * @param {string} network
 * @param {(import("./mirror.js").TokenInfo & { deleted?: boolean, paused?: boolean, freezeDefault?: boolean, createdAt?: number | null }) | null} info
 * @param {{ now?: () => number }} [opts] now en milisegundos
 * @returns {{ ok: boolean, problems: string[], warnings: string[], reviewed: boolean }}
 */
export function checkPastedToken(network, info, { now = Date.now } = {}) {
  const list = network === "mainnet" || network === "testnet" ? SWAP_TOKENS[network] : [];
  const listed = info ? list.find((t) => t.id === info.tokenId) : undefined;
  if (listed) return { ...checkSwapToken(listed, info), reviewed: true };
  const base = checkSwapToken({ id: info?.tokenId ?? "", symbol: "", name: "" }, info);
  if (!info) return { ...base, reviewed: false };
  const problems = [...base.problems];
  const warnings = base.warnings.filter((w) => !/fuera de la lista revisada|outside the reviewed list/.test(w));
  const twin = list.find((t) => looks(t.symbol) === looks(info.symbol) || looks(t.name) === looks(info.name));
  if (twin) {
    problems.push(
      tr(
        `Se hace pasar por ${twin.symbol}, pero no lo es (el de verdad es ${twin.id}).`,
        `It poses as ${twin.symbol}, but it isn't (the real one is ${twin.id}).`,
      ),
    );
  }
  if (fakesHbar(info.symbol) || fakesHbar(info.name) || ["HBAR", "WHBAR"].includes(looks(info.symbol))) {
    problems.push(tr("Se hace llamar HBAR, pero no es HBAR.", "Calls itself HBAR, but it isn't HBAR."));
  }
  // 0.10.2 (fase 3): las acciones tokenizadas las emite una sola tesorería. Otro token que diga «Robinhood» se hace pasar
  // por una acción.
  if (/ROBINHOOD/.test(looks(info.name)) || /ROBINHOOD/.test(looks(info.symbol))) {
    if (info.treasury === ROBINHOOD_TREASURY) warnings.push(tr("Es una acción tokenizada: cómprala desde Acciones.", "It's a tokenized stock: buy it from Stocks."));
    else problems.push(tr("Se hace pasar por una acción tokenizada de Robinhood, pero no la emite su tesorería.", "It poses as a Robinhood tokenized stock, but it isn't issued by its treasury."));
  }
  if (hasLink(info.name) || hasLink(info.symbol)) {
    problems.push(tr("Lleva una web en el nombre: es la marca de las estafas de «regalos».", "It has a website in its name: the mark of «giveaway» scams."));
  }
  warnings.unshift(tr("No está en la lista revisada: nadie lo ha comprobado. Asegúrate de que es el token que quieres.", "It's not on the reviewed list: nobody has checked it. Make sure it's the token you want."));
  if (info.createdAt && now() - info.createdAt * 1000 < NEW_TOKEN_DAYS * 86_400_000) {
    const days = Math.max(0, Math.floor((now() - info.createdAt * 1000) / 86_400_000));
    warnings.push(tr(`Se creó hace ${days === 0 ? "menos de un día" : `${days} día${days === 1 ? "" : "s"}`}.`, `It was created ${days === 0 ? "less than a day" : `${days} day${days === 1 ? "" : "s"}`} ago.`));
  }
  return { ok: problems.length === 0, problems, warnings, reviewed: false };
}
