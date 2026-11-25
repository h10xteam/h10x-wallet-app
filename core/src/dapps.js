// @ts-check
// Conexión con dApps por WalletConnect (HIP-820): las de la lista y, con aviso, cualquier otra dApp de Hedera.
//
// Reglas de seguridad:
//   - El dominio se comprueba con el origen que certifica el servicio Verify de WalletConnect, no con el
//     nombre que la web dice tener. Las dApps de la lista se reconocen por sus dominios oficiales.
//   - Una dApp fuera de la lista solo se conecta con su dominio certificado por Verify (en testnet, también sin
//     certificar), con aviso, y nunca si dice ser una de la lista, se parece a una de ellas o usa un dominio
//     con letras de otros alfabetos (xn--). Se la nombra por su dominio certificado, nunca por su nombre.
//   - Solo se conecta la Cartera; la bóveda nunca firma nada para una dApp (ni podría: su llave
//     necesita dos firmas).
//   - Cada transacción se decodifica y se enseña antes de firmar. Lo peligroso (cambiar la llave,
//     borrar la cuenta, ganchos, operaciones del sistema) se bloquea siempre; los permisos para gastar
//     (allowances) y los contratos se avisan en rojo.
//   - Si una lista de transacciones trae cuerpos distintos para distintos nodos, se rechaza: es un
//     truco para enseñar una cosa y ejecutar otra.
//   - Se firma lo que se ve, o no se firma: un cuerpo con datos que esta versión no sabe leer, con relleno
//     o con dos operaciones metidas en una se rechaza. La llave de la Cartera también es una llave EVM, así
//     que nunca firma bytes que no entiende enteros.
//   - Un permiso o un envío hecho «por la puerta EVM» (la dirección del token o los contratos del sistema
//     de Hedera) se enseña y se avisa igual que si viniera por la vía normal.
import * as HieroProto from "@hiero-ledger/proto";
import { Transaction, TransactionId } from "@hiero-ledger/sdk";
import { decodeBase64, encodeBase64, hexlify, id as keccakId, toUtf8Bytes } from "ethers";
import { fakesHbar, hasLink, hideLinks } from "./scamtext.js";
import { formatHbar, formatUnits } from "./format.js";
import { coreLanguage, tr } from "./i18n.js";

const { proto } = HieroProto;

/**
 * @typedef {{ id: string, name: string, url: string, domains: string[], kind: { es: string, en: string }, networks?: string[], unlisted?: boolean }} Dapp
 *   networks: si está, la dApp solo se ofrece en esas redes (la web de H10X solo trabaja en mainnet)
 *   unlisted: una dApp fuera de la lista (id «web:dominio»), conectada con aviso
 */

/** dApps permitidas. Para añadir una, basta con añadirla aquí (con TODOS sus dominios oficiales). */
/** @type {Dapp[]} */
export const DAPPS = [
  { id: "saucerswap", name: "SaucerSwap", url: "https://www.saucerswap.finance", domains: ["saucerswap.finance"], kind: { es: "Intercambio de tokens", en: "Token exchange" } },
  { id: "sentx", name: "SentX", url: "https://sentx.io", domains: ["sentx.io"], kind: { es: "Mercado de NFT", en: "NFT marketplace" } },
  { id: "hsuite", name: "HSuite", url: "https://hsuite.app", domains: ["hsuite.app", "hsuite.finance", "hsuite.network", "hbarsuite.app"], kind: { es: "DeFi y herramientas", en: "DeFi and tools" } },
  { id: "hashpack", name: "HashPack", url: "https://www.hashpack.app", domains: ["hashpack.app"], kind: { es: "Portal de HashPack", en: "HashPack portal" } },
  { id: "kabila", name: "Kabila", url: "https://www.kabila.app", domains: ["kabila.app"], kind: { es: "Mercado y herramientas de NFT", en: "NFT market and tools" } },
  // La web de H10X: votar y proponer en la DAO, comprar y vender H10X. Solo mainnet (ahí están los H10X).
  { id: "h10x", name: "H10X", url: "https://h10xindex.xyz", domains: ["h10xindex.xyz"], kind: { es: "El Index DTF de Hedera y su DAO", en: "Hedera's Index DTF and its DAO" }, networks: ["mainnet"] },
];

/**
 * dApps que se ofrecen en una red (las que no dicen nada, en todas).
 * @param {string} network
 */
export const dappsFor = (network) => DAPPS.filter((d) => !d.networks || d.networks.includes(network));

/**
 * Exigir que el dominio esté verificado por WalletConnect (estado VALID). Con `false`, un origen
 * UNKNOWN de una dApp de la lista se permite con un aviso; INVALID o estafa se rechazan siempre.
 */
export const REQUIRE_VERIFIED_DOMAIN = false;

/**
 * Valor por defecto según la red: en mainnet se exige el dominio verificado (una web sin certificar que diga
 * ser una dApp de la lista se rechaza); en testnet se permite con aviso, para poder probar con dApps que aún
 * no lo tienen. Las conexiones desde el navegador de la app cuentan como verificadas.
 * @param {string} network
 */
export const requireVerifiedFor = (network) => network === "mainnet";

/** Métodos HIP-820. Se declaran todos al aprobar la sesión (si no, muchas dApps no conectan)… */
export const HEDERA_METHODS = [
  "hedera_getNodeAddresses",
  "hedera_executeTransaction",
  "hedera_signMessage",
  "hedera_signAndExecuteQuery",
  "hedera_signAndExecuteTransaction",
  "hedera_signTransaction",
];
/** …pero estos son los únicos que se atienden. */
export const ALLOWED_METHODS = new Set(["hedera_getNodeAddresses", "hedera_executeTransaction", "hedera_signMessage", "hedera_signAndExecuteTransaction", "hedera_signTransaction"]);
export const HEDERA_EVENTS = ["accountsChanged", "chainChanged"];

export class DappError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Host de una dirección https (en minúsculas), o null si no es https o no se entiende.
 * @param {string | null | undefined} url
 */
export function hostOf(url) {
  if (!url || typeof url !== "string") return null;
  const m = /^https:\/\/([^/?#:@\s]+)(?::\d+)?(?:[/?#]|$)/i.exec(url.trim());
  if (!m) return null;
  const host = m[1].toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9.-]+$/.test(host) || host.includes("..")) return null;
  return host;
}

/**
 * dApp de la lista a la que pertenece una dirección (dominio exacto o subdominio), o null.
 * @param {string | null | undefined} url
 */
export function dappForUrl(url) {
  const host = hostOf(url);
  if (!host) return null;
  return DAPPS.find((d) => d.domains.some((dom) => host === dom || host.endsWith(`.${dom}`))) ?? null;
}

/** Prefijo de las dApps fuera de la lista: «web:dominio». */
export const UNLISTED_PREFIX = "web:";

/**
 * dApp fuera de la lista, nombrada por su dominio (el certificado por Verify). Null si el dominio no vale.
 * @param {string | null | undefined} host
 * @returns {Dapp | null}
 */
export function unlistedDapp(host) {
  const h = hostOf(host ? `https://${host}` : null);
  if (!h || !h.includes(".")) return null;
  return { id: `${UNLISTED_PREFIX}${h}`, name: h, url: `https://${h}`, domains: [h], kind: { es: "Fuera de la lista de H10X Wallet", en: "Not on H10X Wallet's list" }, unlisted: true };
}

/**
 * dApp por su id: una de la lista o una «web:dominio».
 * @param {string | null | undefined} id
 */
export function dappById(id) {
  if (!id) return null;
  if (id.startsWith(UNLISTED_PREFIX)) return unlistedDapp(id.slice(UNLISTED_PREFIX.length));
  return DAPPS.find((d) => d.id === id) ?? null;
}

/** Marcas de las dApps de la lista (la parte principal de cada dominio oficial), para pillar imitaciones. */
const BRANDS = [...new Set([...DAPPS.flatMap((d) => d.domains.map((dom) => dom.split(".").slice(-2, -1)[0])), "h10x"].filter((b) => b && b.length >= 4))];

/**
 * ¿Se hace pasar un dominio de fuera de la lista por una dApp de la lista? (lleva su marca, p. ej.
 * «saucerswap-airdrop.xyz», o usa letras de otros alfabetos: xn--).
 * @param {string} host
 */
export function looksLikeListed(host) {
  if (dappForUrl(`https://${host}`)) return false;
  if (host.split(".").some((l) => l.startsWith("xn--"))) return true;
  const flat = host.replace(/[^a-z0-9]/g, "");
  return BRANDS.some((b) => flat.includes(b));
}

/** @param {"hedera:mainnet" | "hedera:testnet" | string} chainId */
const isHederaChain = (chainId) => /^hedera:(mainnet|testnet|previewnet|devnet)$/.test(chainId);

/**
 * @typedef {{ verified?: { origin?: string, validation?: string, isScam?: boolean } } | undefined} VerifyContext
 * @typedef {{ chains?: string[], methods?: string[], events?: string[] }} Namespace
 */

/**
 * Decide si se acepta una propuesta de sesión.
 *
 * `openedFrom` es la dApp (id) cuya página, abierta en el navegador de H10X Wallet, pidió la conexión. Esa
 * página la cargó H10X Wallet desde la lista, así que vale como verificación del dominio; si la propuesta
 * dice ser de otra dApp, se rechaza.
 * Una dApp fuera de la lista se acepta con aviso (ver `vetUnlisted`).
 * @param {{ verifyContext: VerifyContext, metadataUrl: string, metadataName?: string, requiredNamespaces?: Record<string, Namespace>,
 *   optionalNamespaces?: Record<string, Namespace>, chainId: string, requireVerified?: boolean, openedFrom?: string | null,
 *   lang?: import("./i18n.js").Lang }} p
 * @returns {{ ok: true, dapp: Dapp, verified: boolean, via: "verify" | "browser" | null, warning: string | null } | { ok: false, code: string, message: string }}
 */
export function vetProposal({ verifyContext, metadataUrl, metadataName = "", requiredNamespaces = {}, optionalNamespaces = {}, chainId, requireVerified = REQUIRE_VERIFIED_DOMAIN, openedFrom = null, lang = coreLanguage() }) {
  const v = verifyContext?.verified ?? {};
  const page = openedFrom ? (DAPPS.find((d) => d.id === openedFrom) ?? null) : null;
  if (openedFrom && !page) return { ok: false, code: "not_allowed", message: tr("Esa página no está en la lista de dApps permitidas.", "That page is not on the list of allowed dApps.", lang) };
  if (v.isScam) return { ok: false, code: "scam", message: tr("Esta web está marcada como estafa. Conexión rechazada.", "This site is flagged as a scam. Connection refused.", lang) };
  if (v.validation === "INVALID") {
    return { ok: false, code: "mismatch", message: tr("La web que pide conectar no es la que dice ser. Conexión rechazada.", "The site asking to connect is not who it claims to be. Connection refused.", lang) };
  }
  const verified = v.validation === "VALID";
  const origin = verified ? v.origin : metadataUrl;
  // Abierta en el navegador de H10X Wallet: manda la página que cargamos nosotros (si los datos de la dApp
  // no traen una dirección válida, se usa la página).
  const dapp = page && !verified && !hostOf(metadataUrl) ? page : dappForUrl(origin);
  if (page && dapp?.id !== page.id) {
    const claimed = dapp?.name ?? hostOf(origin) ?? tr("otra web", "another site", lang);
    return {
      ok: false,
      code: "mismatch",
      message: tr(`La conexión decía venir de ${claimed}, pero la pidió la página de ${page.name}. Conexión rechazada.`, `The connection claimed to come from ${claimed}, but ${page.name}'s page asked for it. Connection refused.`, lang),
    };
  }
  if (!dapp) return vetUnlisted({ v, verified, metadataUrl, metadataName, requiredNamespaces, optionalNamespaces, chainId, requireVerified, lang });
  // Con origen verificado, la dirección que la dApp dice tener debe ser de la misma dApp.
  if (verified && dappForUrl(metadataUrl)?.id !== dapp.id && hostOf(metadataUrl)) {
    return { ok: false, code: "mismatch", message: tr("Los datos de la dApp no coinciden con su web. Conexión rechazada.", "The dApp's details don't match its site. Connection refused.", lang) };
  }
  const certified = verified || !!page;
  if (!certified && requireVerified) {
    return { ok: false, code: "unverified", message: tr(`No se ha podido verificar que la conexión venga de ${dapp.name}.`, `It couldn't be verified that the connection comes from ${dapp.name}.`, lang) };
  }
  const nsProblem = namespaceProblem({ requiredNamespaces, optionalNamespaces, chainId, lang });
  if (nsProblem) return nsProblem;
  return {
    ok: true,
    dapp,
    verified: certified,
    via: verified ? "verify" : page ? "browser" : null,
    warning: certified ? null : tr(`WalletConnect no ha podido certificar el dominio de ${dapp.name}. Conecta solo si has abierto tú la web oficial.`, `WalletConnect couldn't certify ${dapp.name}'s domain. Connect only if you opened the official site yourself.`, lang),
  };
}

/**
 * Redes que pide la dApp: solo Hedera y la red de la app. Devuelve el rechazo, o null si vale.
 * @param {{ requiredNamespaces?: Record<string, Namespace>, optionalNamespaces?: Record<string, Namespace>, chainId: string, lang: import("./i18n.js").Lang }} p
 * @returns {{ ok: false, code: string, message: string } | null}
 */
function namespaceProblem({ requiredNamespaces = {}, optionalNamespaces = {}, chainId, lang }) {
  // Un espacio puede venir como "hedera" con su lista de redes o como "hedera:testnet" directamente.
  const chainsOf = (/** @type {string} */ ns, /** @type {Namespace} */ def) => def?.chains ?? (ns.includes(":") ? [ns] : []);
  for (const [ns, def] of Object.entries(requiredNamespaces ?? {})) {
    const chains = chainsOf(ns, def);
    if (!chains.every(isHederaChain)) {
      return { ok: false, code: "unsupported", message: tr("La dApp exige una red que H10X Wallet no usa.", "The dApp requires a network H10X Wallet doesn't use.", lang) };
    }
    if (chains.some((c) => c !== chainId)) {
      return { ok: false, code: "wrong_network", message: tr(`La dApp exige otra red de Hedera (H10X Wallet está en ${chainId}).`, `The dApp requires another Hedera network (H10X Wallet is on ${chainId}).`, lang) };
    }
  }
  const all = [...Object.entries(requiredNamespaces ?? {}), ...Object.entries(optionalNamespaces ?? {})];
  const wantsOurChain = all.some(([ns, def]) => chainsOf(ns, def).includes(chainId));
  if (!wantsOurChain) {
    return { ok: false, code: "wrong_network", message: tr(`La dApp no ofrece ${chainId}.`, `The dApp doesn't offer ${chainId}.`, lang) };
  }
  return null;
}

/**
 * dApp fuera de la lista. Se acepta con aviso solo si:
 *   - Verify certifica su dominio (en testnet, o con `requireVerified` a false, también sin certificar, con un aviso
 *     más fuerte y nombrada por el dominio que dice tener);
 *   - no dice ser una dApp de la lista (ni por dirección ni por nombre) ni se parece a una (su marca, xn--).
 * @param {{ v: NonNullable<NonNullable<VerifyContext>["verified"]>, verified: boolean, metadataUrl: string, metadataName: string,
 *   requiredNamespaces?: Record<string, Namespace>, optionalNamespaces?: Record<string, Namespace>, chainId: string, requireVerified: boolean,
 *   lang: import("./i18n.js").Lang }} p
 * @returns {{ ok: true, dapp: Dapp, verified: boolean, via: "verify" | "browser" | null, warning: string | null } | { ok: false, code: string, message: string }}
 */
function vetUnlisted({ v, verified, metadataUrl, metadataName, requiredNamespaces, optionalNamespaces, chainId, requireVerified, lang }) {
  const host = hostOf(verified ? v.origin : metadataUrl);
  if (!host) return { ok: false, code: "unverified", message: tr("La dApp no dice de qué web viene. Conexión rechazada.", "The dApp doesn't say which site it comes from. Connection refused.", lang) };
  const claimed = dappForUrl(metadataUrl) ?? DAPPS.find((d) => d.name.toLowerCase() === String(metadataName ?? "").trim().toLowerCase()) ?? null;
  if (claimed) {
    return {
      ok: false,
      code: "mismatch",
      message: tr(`Dice ser ${claimed.name}, pero viene de ${host}. Conexión rechazada.`, `It claims to be ${claimed.name}, but it comes from ${host}. Connection refused.`, lang),
    };
  }
  if (looksLikeListed(host)) {
    return {
      ok: false,
      code: "lookalike",
      message: tr(`${host} se parece a una dApp conocida sin serlo. Conexión rechazada.`, `${host} looks like a known dApp but isn't one. Connection refused.`, lang),
    };
  }
  if (!verified && requireVerified) {
    return {
      ok: false,
      code: "unverified",
      message: tr(
        `WalletConnect no certifica de qué web viene esta conexión (dice ser ${host}). Por seguridad, H10X Wallet solo conecta webs fuera de su lista si WalletConnect certifica su dominio.`,
        `WalletConnect doesn't certify which site this connection comes from (it claims to be ${host}). For safety, H10X Wallet only connects sites outside its list if WalletConnect certifies their domain.`,
        lang,
      ),
    };
  }
  const nsProblem = namespaceProblem({ requiredNamespaces, optionalNamespaces, chainId, lang });
  if (nsProblem) return nsProblem;
  const dapp = /** @type {Dapp} */ (unlistedDapp(host));
  return {
    ok: true,
    dapp,
    verified,
    via: verified ? "verify" : null,
    warning: verified
      ? tr(
          `${host} no está en la lista de dApps conocidas de H10X Wallet. Conecta solo si conoces esta web y la has abierto tú. Revisa bien cada operación antes de firmar.`,
          `${host} isn't on H10X Wallet's list of known dApps. Connect only if you know this site and opened it yourself. Check every operation carefully before signing.`,
          lang,
        )
      : tr(
          `Ni H10X Wallet ni WalletConnect pueden comprobar de qué web viene esta conexión (dice ser ${host}). Si no la has abierto tú, recházala.`,
          `Neither H10X Wallet nor WalletConnect can check which site this connection comes from (it claims to be ${host}). If you didn't open it yourself, reject it.`,
          lang,
        ),
  };
}

/**
 * Comprueba cada petición de una sesión ya aprobada: si el origen certificado cambia a otra web, se rechaza.
 * @param {{ verifyContext: VerifyContext, dappId: string }} p
 */
export function vetRequestOrigin({ verifyContext, dappId }) {
  const v = verifyContext?.verified ?? {};
  if (v.isScam || v.validation === "INVALID") return false;
  if (v.validation === "VALID") {
    if (dappId.startsWith(UNLISTED_PREFIX)) return dappForUrl(v.origin) == null && hostOf(v.origin) === dappId.slice(UNLISTED_PREFIX.length);
    if (dappForUrl(v.origin)?.id !== dappId) return false;
  }
  return true;
}

/**
 * Espacios de nombres que se aprueban: solo Hedera, solo esta red y solo la Cartera.
 * @param {{ chainId: string, accountId: string }} p
 */
export const approvedNamespaces = ({ chainId, accountId }) => ({
  hedera: { chains: [chainId], methods: HEDERA_METHODS, events: HEDERA_EVENTS, accounts: [`${chainId}:${accountId}`] },
});

// ---------------------------------------------------------------------------------------------
// Peticiones
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {{ method: "hedera_getNodeAddresses" }
 *   | { method: "hedera_signMessage", signer: string, message: string }
 *   | { method: "hedera_signTransaction", signer: string, bodyBytes: Uint8Array, bodies: any[] }
 *   | { method: "hedera_signAndExecuteTransaction", signer: string, listBytes: Uint8Array, bodies: any[] }
 *   | { method: "hedera_executeTransaction", listBytes: Uint8Array, bodies: any[] }} DappRequest
 */

/** @param {Uint8Array} a @param {Uint8Array} b */
const sameBytes = (a, b) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/**
 * Lee un cuerpo y exige que, vuelto a escribir, dé exactamente los mismos bytes. Si no coincide, el cuerpo
 * lleva algo que esta versión no sabe leer (campos más nuevos, relleno, un orden raro…) y no se podría
 * enseñar entero: lo que no se ve no se firma.
 * @param {Uint8Array} bodyBytes
 */
export function readBody(bodyBytes) {
  let body;
  let again = null;
  try {
    body = proto.TransactionBody.decode(bodyBytes);
    again = proto.TransactionBody.encode(body).finish();
  } catch {
    throw new DappError("bad_params", tr("La transacción no se puede leer.", "The transaction can't be read."));
  }
  if (!sameBytes(again, bodyBytes)) {
    throw new DappError(
      "unreadable",
      tr(
        "La transacción lleva datos que H10X Wallet no sabe leer, así que no podría enseñártela entera. Rechazada por seguridad.",
        "The transaction carries data H10X Wallet can't read, so it couldn't show you all of it. Rejected for safety.",
      ),
    );
  }
  return body;
}

/**
 * Cuerpos de todas las transacciones de una TransactionList (una por nodo). Exige que sean iguales
 * salvo el nodo; si no, la lista es engañosa y se rechaza.
 * @param {Uint8Array} listBytes
 */
export function bodiesOfTransactionList(listBytes) {
  let list;
  try {
    list = proto.TransactionList.decode(listBytes);
  } catch {
    throw new DappError("bad_params", tr("La transacción no se puede leer.", "The transaction can't be read."));
  }
  const txs = list.transactionList ?? [];
  if (txs.length === 0) throw new DappError("bad_params", tr("La transacción viene vacía.", "The transaction is empty."));
  const bodies = txs.map((t) => {
    const bodyBytes = t.signedTransactionBytes?.length ? proto.SignedTransaction.decode(t.signedTransactionBytes).bodyBytes : t.bodyBytes;
    if (!bodyBytes?.length) throw new DappError("bad_params", tr("La transacción no trae cuerpo.", "The transaction has no body."));
    return readBody(bodyBytes);
  });
  const canon = (/** @type {any} */ b) => {
    const copy = proto.TransactionBody.decode(proto.TransactionBody.encode(b).finish());
    copy.nodeAccountID = null;
    return hexlify(proto.TransactionBody.encode(copy).finish());
  };
  const first = canon(bodies[0]);
  if (bodies.some((b) => canon(b) !== first)) {
    throw new DappError("inconsistent", tr("La transacción trae versiones distintas según el nodo. Rechazada por seguridad.", "The transaction carries different versions per node. Rejected for safety."));
  }
  return bodies;
}

/**
 * Valida y decodifica una petición HIP-820.
 * @param {{ method: string, params: any, chainId: string, accountId: string }} p
 * @returns {DappRequest}
 */
export function parseDappRequest({ method, params, chainId, accountId }) {
  if (!ALLOWED_METHODS.has(method)) throw new DappError("method_not_allowed", tr("H10X Wallet no permite esta petición.", "H10X Wallet doesn't allow this request."));
  const signerOf = (/** @type {unknown} */ s) => {
    if (typeof s !== "string") throw new DappError("bad_params", tr("Falta la cuenta que firma.", "The signing account is missing."));
    const id = s.startsWith(`${chainId}:`) ? s.slice(chainId.length + 1) : s;
    if (id !== accountId) throw new DappError("wrong_account", tr("La dApp pide firmar con otra cuenta. Solo puede usar tu Cartera.", "The dApp asks to sign with another account. It can only use your Wallet."));
    return id;
  };
  const b64 = (/** @type {unknown} */ s, /** @type {string} */ what) => {
    if (typeof s !== "string" || !s) throw new DappError("bad_params", tr(`Falta ${what}.`, `Missing ${what}.`));
    try {
      return decodeBase64(s);
    } catch {
      throw new DappError("bad_params", tr(`${what} no es válido.`, `${what} is not valid.`));
    }
  };
  switch (method) {
    case "hedera_getNodeAddresses":
      return { method };
    case "hedera_signMessage": {
      const signer = signerOf(params?.signerAccountId);
      if (typeof params?.message !== "string") throw new DappError("bad_params", tr("Falta el mensaje.", "The message is missing."));
      if (params.message.length > 4000) throw new DappError("bad_params", tr("El mensaje es demasiado largo.", "The message is too long."));
      return { method, signer, message: params.message };
    }
    case "hedera_signTransaction": {
      const signer = signerOf(params?.signerAccountId);
      const bodyBytes = b64(params?.transactionBody, "transactionBody");
      const body = readBody(bodyBytes);
      // Aquí la firma se devuelve suelta a la dApp: solo se firma un cuerpo completo, que empiece diciendo
      // quién paga (el primer byte de una transacción de Hedera; ninguna transacción EVM empieza así).
      if (bodyBytes[0] !== 0x0a || !body.transactionID?.accountID) {
        throw new DappError("bad_params", tr("La transacción no dice quién la paga. No se puede firmar.", "The transaction doesn't say who pays for it. It can't be signed."));
      }
      return { method, signer, bodyBytes, bodies: [body] };
    }
    case "hedera_signAndExecuteTransaction": {
      const signer = signerOf(params?.signerAccountId);
      const listBytes = b64(params?.transactionList, "transactionList");
      return { method, signer, listBytes, bodies: bodiesOfTransactionList(listBytes) };
    }
    case "hedera_executeTransaction": {
      const listBytes = b64(params?.transactionList, "transactionList");
      return { method, listBytes, bodies: bodiesOfTransactionList(listBytes) };
    }
    default:
      throw new DappError("method_not_allowed", tr("H10X Wallet no permite esta petición.", "H10X Wallet doesn't allow this request."));
  }
}

// ---------------------------------------------------------------------------------------------
// Qué hace una transacción (para enseñarla antes de firmar)
// ---------------------------------------------------------------------------------------------

const num = (/** @type {any} */ v) => (v == null ? 0n : BigInt(v.toString()));
/** @param {any} id */
const acc = (id) => {
  if (!id) return "?";
  if (id.alias?.length) return hexlify(id.alias);
  return `${num(id.shardNum)}.${num(id.realmNum)}.${num(id.accountNum)}`;
};
/** @param {any} id */
const tok = (id) => `${num(id?.shardNum)}.${num(id?.realmNum)}.${num(id?.tokenNum)}`;
/** @param {any} id */
const con = (id) => (id?.evmAddress?.length ? hexlify(id.evmAddress) : `${num(id?.shardNum)}.${num(id?.realmNum)}.${num(id?.contractNum)}`);
/** Campos presentes en un mensaje decodificado (sin los vacíos). @param {any} m */
const presentFields = (m) =>
  Object.keys(m ?? {}).filter((k) => {
    const v = m[k];
    return v != null && !(Array.isArray(v) && v.length === 0);
  });
/** Cantidad tan grande que equivale a "sin límite" (≥ 2^62). */
const UNLIMITED = 2n ** 62n;
/** Campos de un cuerpo que no son «la operación». */
const NOT_DATA = new Set(["transactionID", "nodeAccountID", "transactionFee", "transactionValidDuration", "memo", "generateRecord", "maxCustomFees", "batchKey"]);
/**
 * Operaciones que trae un cuerpo ya decodificado. Tiene que ser una sola: con dos, la hoja enseñaría una y la
 * red (o la librería que lo vuelva a leer) se podría quedar con la otra.
 * Si el cuerpo lo ha leído la librería, se usa su propia lista de operaciones (el «oneof data»): así un campo
 * nuevo de la cabecera no cuenta como operación. Si esa lista no responde, cuenta todo lo que no sea
 * cabecera (ante la duda, de más: se bloquea en vez de dejar pasar).
 * @param {any} body
 * @returns {string[]}
 */
export function dataFieldsOf(body) {
  const fields = presentFields(body).filter((k) => !NOT_DATA.has(k));
  const shape = body == null ? null : Object.getPrototypeOf(body);
  const oneof = shape && shape !== Object.prototype ? Object.getOwnPropertyDescriptor(shape, "data")?.get : undefined;
  if (!oneof) return fields;
  const members = presentFields(body).filter((k) => {
    const probe = Object.create(shape);
    probe[k] = body[k];
    return oneof.call(probe) === k;
  });
  return members.length > 0 ? members : fields;
}

// ---------------------------------------------------------------------------------------------
// Permisos y envíos «por la puerta EVM»
// ---------------------------------------------------------------------------------------------

/** Dirección EVM legible: 0.0.N si es «larga de ceros» (cuentas, tokens y contratos de Hedera), o 0x… entera. @param {string} hex */
const evmName = (hex) => {
  const m = /^0x0{24}([0-9a-f]{16})$/i.exec(hex);
  return m ? `0.0.${BigInt(`0x${m[1]}`)}` : hex.toLowerCase();
};
/** Palabra n (32 bytes) de los argumentos de una llamada, o null si no está entera. @param {Uint8Array} data @param {number} n */
const abiWord = (data, n) => (data.length >= 4 + 32 * (n + 1) ? data.subarray(4 + 32 * n, 36 + 32 * n) : null);
/** @param {Uint8Array} w */
const abiUint = (w) => BigInt(hexlify(w));
/** @param {Uint8Array} w */
const abiAddress = (w) => evmName(hexlify(w.subarray(12)));

/** Contratos del sistema de Hedera: quien los llama actúa con su propia llave. 0x167 tokens, 0x16a cuentas, 0x16b programadas. */
const SYSTEM_CONTRACTS = /** @type {Record<string, "hts" | "has" | "hss">} */ ({ 359: "hts", 362: "has", 363: "hss" });

/** @type {{ token: Map<string, string>, hts: Map<string, string>, has: Map<string, string> } | null} */
let evmTables = null;
/** Selectores (los 4 primeros bytes de la huella de la función) de lo que da permisos o mueve tokens. */
function evmSelectors() {
  if (evmTables) return evmTables;
  const table = (/** @type {Record<string, string>} */ o) => new Map(Object.entries(o).map(([signature, kind]) => [keccakId(signature).slice(0, 10), kind]));
  evmTables = {
    // En la dirección de un token (ERC-20 y ERC-721) o de tu propia cuenta (hbarApprove).
    token: table({
      "approve(address,uint256)": "approve",
      "increaseAllowance(address,uint256)": "approve",
      "setApprovalForAll(address,bool)": "approveAll",
      "transfer(address,uint256)": "transfer",
      "transferFrom(address,address,uint256)": "transferFrom",
      "safeTransferFrom(address,address,uint256)": "transferFrom",
      "safeTransferFrom(address,address,uint256,bytes)": "transferFrom",
      "hbarApprove(address,int256)": "hbarApprove",
    }),
    // En el servicio de tokens (0x167): el primer argumento es el token.
    hts: table({
      "approve(address,address,uint256)": "approve",
      "approveNFT(address,address,uint256)": "approve",
      "setApprovalForAll(address,address,bool)": "approveAll",
      "transferToken(address,address,address,int64)": "transfer",
      "transferNFT(address,address,address,int64)": "transfer",
      "transferFrom(address,address,address,uint256)": "transfer",
      "transferFromNFT(address,address,address,uint256)": "transfer",
    }),
    // En el servicio de cuentas (0x16a): dueño, quien gasta y cantidad.
    has: table({ "hbarApprove(address,address,int256)": "hbarApprove" }),
  };
  return evmTables;
}

/**
 * @typedef {{ kind: "approve", tokenId: string, spender: string, amount: bigint }
 *   | { kind: "approveAll", tokenId: string, spender: string, approved: boolean }
 *   | { kind: "transfer", tokenId: string, from: string | null, to: string, amount: bigint }
 *   | { kind: "hbarApprove", owner: string | null, spender: string, amount: bigint }
 *   | { kind: "system", service: "hts" | "has" }} EvmCall
 */

/**
 * Lo que hace una llamada a contrato cuando en realidad es un permiso o un envío hecho «por la puerta EVM»:
 * la dirección de un token (approve, transfer…) o un contrato del sistema de Hedera llamado directamente.
 * Devuelve null si es una llamada cualquiera a un contrato.
 * @param {any} c ContractCallTransactionBody decodificado
 * @returns {EvmCall | null}
 */
export function evmCallOf(c) {
  const target = evmName(con(c?.contractID));
  const p = c?.functionParameters;
  /** @type {Uint8Array | null} */
  const data = p && p.length >= 4 ? p : null;
  const sel = data ? hexlify(data.subarray(0, 4)) : "";
  const w = (/** @type {number} */ n) => (data ? abiWord(data, n) : null);
  const [a, b, c2, d] = [w(0), w(1), w(2), w(3)];
  const sys = /^0\.0\.(\d+)$/.exec(target);
  const service = sys ? SYSTEM_CONTRACTS[sys[1]] : undefined;
  if (service === "hss") return null; // se bloquea aparte
  const tables = evmSelectors();
  if (service === "hts") {
    const kind = tables.hts.get(sel);
    if (kind === "approve" && a && b && c2) return { kind, tokenId: abiAddress(a), spender: abiAddress(b), amount: abiUint(c2) };
    if (kind === "approveAll" && a && b && c2) return { kind, tokenId: abiAddress(a), spender: abiAddress(b), approved: abiUint(c2) !== 0n };
    if (kind === "transfer" && a && b && c2 && d) return { kind, tokenId: abiAddress(a), from: abiAddress(b), to: abiAddress(c2), amount: abiUint(d) };
    return { kind: "system", service };
  }
  if (service === "has") {
    if (tables.has.get(sel) === "hbarApprove" && a && b && c2) return { kind: "hbarApprove", owner: abiAddress(a), spender: abiAddress(b), amount: BigInt.asIntN(256, abiUint(c2)) };
    return { kind: "system", service };
  }
  const kind = tables.token.get(sel);
  if (kind === "approve" && a && b) return { kind, tokenId: target, spender: abiAddress(a), amount: abiUint(b) };
  if (kind === "approveAll" && a && b) return { kind, tokenId: target, spender: abiAddress(a), approved: abiUint(b) !== 0n };
  if (kind === "transfer" && a && b) return { kind, tokenId: target, from: null, to: abiAddress(a), amount: abiUint(b) };
  if (kind === "transferFrom" && a && b && c2) return { kind: "transfer", tokenId: target, from: abiAddress(a), to: abiAddress(b), amount: abiUint(c2) };
  if (kind === "hbarApprove" && a && b) return { kind, owner: null, spender: abiAddress(a), amount: BigInt.asIntN(256, abiUint(b)) };
  return null;
}

/** Tokens que aparecen en una lista de cuerpos (para pedir su nombre y decimales). @param {any[]} bodies */
export function tokenIdsOfBodies(bodies) {
  const out = new Set();
  const visit = (/** @type {any} */ b) => {
    for (const l of b?.cryptoTransfer?.tokenTransfers ?? []) out.add(tok(l.token));
    for (const l of b?.tokenAirdrop?.tokenTransfers ?? []) out.add(tok(l.token));
    for (const a of b?.cryptoApproveAllowance?.tokenAllowances ?? []) out.add(tok(a.tokenId));
    for (const a of b?.cryptoApproveAllowance?.nftAllowances ?? []) out.add(tok(a.tokenId));
    for (const t of b?.tokenAssociate?.tokens ?? []) out.add(tok(t));
    for (const t of b?.tokenDissociate?.tokens ?? []) out.add(tok(t));
    const call = b?.contractCall ? evmCallOf(b.contractCall) : null;
    if (call && "tokenId" in call && /^0\.0\.\d+$/.test(call.tokenId)) out.add(call.tokenId);
    if (b?.scheduleCreate?.scheduledTransactionBody) visit(b.scheduleCreate.scheduledTransactionBody);
    for (const inner of innerBatchBodies(b)) visit(inner);
  };
  bodies.forEach(visit);
  return [...out];
}

/** Cuerpos internos de una transacción por lotes (HIP-551). @param {any} b */
function innerBatchBodies(b) {
  if (!b?.atomicBatch) return [];
  return (b.atomicBatch.transactions ?? []).map((/** @type {Uint8Array} */ bytes) => {
    const signed = proto.SignedTransaction.decode(bytes);
    return readBody(signed.bodyBytes);
  });
}

/**
 * @typedef {{ title: string, lines: string[], warnings: string[], blocked: string | null, danger: boolean,
 *   payer: string, maxFee: bigint, outgoingTinybars: bigint }} TxDescription
 */

/**
 * Describe una transacción (cuerpo protobuf) para la Cartera `account`.
 * @param {any} body
 * @param {{ account: string, vaultId?: string | null, notaryId?: string | null, meta?: (tokenId: string) => import("./mirror.js").TokenInfo | null | undefined,
 *   lang?: import("./i18n.js").Lang, depth?: number }} opts
 * @returns {TxDescription}
 */
export function describeDappTransaction(body, { account, vaultId = null, notaryId = null, meta = () => null, lang = coreLanguage(), depth = 0 }) {
  const T = (/** @type {string} */ es, /** @type {string} */ en) => tr(es, en, lang);
  const hbar = (/** @type {bigint} */ t) => `${formatHbar(t < 0n ? -t : t, 8, lang)} HBAR`;
  // Nombre y símbolo los pone quien crea el token: se enseñan sin sus enlaces.
  const symOf = (/** @type {string} */ tokenId) => {
    const s = meta(tokenId)?.symbol;
    return s ? hideLinks(s, lang) : tokenId;
  };
  const units = (/** @type {string} */ tokenId, /** @type {bigint} */ amount) => {
    const m = meta(tokenId);
    if (amount >= UNLIMITED) return T(`sin límite de ${symOf(tokenId)}`, `unlimited ${symOf(tokenId)}`);
    return m ? `${formatUnits(amount < 0n ? -amount : amount, m.decimals, 6, lang)} ${symOf(tokenId)}` : `${(amount < 0n ? -amount : amount).toString()} × ${tokenId}`;
  };
  const tokName = (/** @type {string} */ tokenId) => {
    const n = meta(tokenId)?.name;
    return n ? hideLinks(n, lang) : tokenId;
  };
  const payer = acc(body.transactionID?.accountID);
  const maxFee = num(body.transactionFee);
  /** @type {TxDescription} */
  const d = { title: "", lines: [], warnings: [], blocked: null, danger: false, payer, maxFee, outgoingTinybars: 0n };
  const block = (/** @type {string} */ why) => {
    d.blocked = d.blocked ?? why;
    d.danger = true;
  };
  const warn = (/** @type {string} */ w, danger = false) => {
    d.warnings.push(w);
    if (danger) d.danger = true;
  };
  const isMe = (/** @type {string} */ a) => a === account;
  // La bóveda y su notario, también por su dirección EVM «long-zero» (0x000…num).
  const longZero = (/** @type {string | null} */ id) => (id ? `0x${BigInt(id.split(".")[2] ?? "0").toString(16).padStart(40, "0")}` : null);
  const isVault = (/** @type {string} */ a) => !!vaultId && (a === vaultId || a.toLowerCase() === longZero(vaultId));
  const isNotary = (/** @type {string} */ c) => !!notaryId && (c === notaryId || c.toLowerCase() === longZero(notaryId));
  /** Schedule Service (0x16b): firmar programadas desde un contrato o una cuenta. */
  const isScheduleService = (/** @type {string} */ c) => c === "0.0.363" || c.toLowerCase() === `0x${"16b".padStart(40, "0")}`;
  const vaultBlock = () =>
    block(T("Movería o cambiaría tu bóveda. Las dApps solo pueden usar tu Cartera: bloqueado.", "It would move or change your vault. dApps can only use your Wallet: blocked."));

  // Un cuerpo lleva UNA operación. Con dos, la red se queda con la última y aquí se enseñaría otra distinta.
  if (dataFieldsOf(body).length > 1) {
    block(T("La transacción trae varias operaciones metidas en una y solo se podría enseñar una de ellas. Bloqueado.", "The transaction has several operations packed into one and only one of them could be shown. Blocked."));
  }

  // Quien paga pone también el dinero de lo que no nombra a nadie: el saldo inicial de una cuenta nueva, los
  // HBAR enviados a un contrato, un permiso o un rechazo sin dueño… Si paga la bóveda, sale de la bóveda.
  // Vale a cualquier profundidad (cada operación de un lote lleva su propio pagador).
  if (isVault(payer)) vaultBlock();
  else if (depth === 0 && payer !== account) warn(T(`La comisión la paga otra cuenta (${payer}).`, `The fee is paid by another account (${payer}).`));
  if (depth === 0 && maxFee > 20n * 100_000_000n) warn(T(`Comisión máxima alta: ${hbar(maxFee)}.`, `High maximum fee: ${hbar(maxFee)}.`), true);

  if (body.cryptoTransfer || body.tokenAirdrop) {
    const ct = body.cryptoTransfer ?? body.tokenAirdrop;
    d.title = body.tokenAirdrop ? T("Enviar tokens (airdrop)", "Send tokens (airdrop)") : T("Transferencia", "Transfer");
    for (const aa of ct.transfers?.accountAmounts ?? []) {
      const a = acc(aa.accountID);
      const amount = num(aa.amount);
      if (amount < 0n && isMe(a)) d.outgoingTinybars += -amount;
      if (amount > 0n) d.lines.push(T(`${hbar(amount)} → ${a}`, `${hbar(amount)} → ${a}`));
      if (amount < 0n && !isMe(a)) d.lines.push(T(`${a} paga ${hbar(amount)}${aa.isApproval ? " (con permiso)" : ""}`, `${a} pays ${hbar(amount)}${aa.isApproval ? " (with allowance)" : ""}`));
    }
    for (const l of ct.tokenTransfers ?? []) {
      const tokenId = tok(l.token);
      for (const aa of l.transfers ?? []) {
        const a = acc(aa.accountID);
        const amount = num(aa.amount);
        if (amount > 0n) d.lines.push(`${units(tokenId, amount)} → ${a}`);
        if (amount < 0n && !isMe(a)) d.lines.push(T(`${a} paga ${units(tokenId, amount)}`, `${a} pays ${units(tokenId, amount)}`));
      }
      for (const nt of l.nftTransfers ?? []) {
        d.lines.push(`NFT ${tokName(tokenId)} #${num(nt.serialNumber)}: ${acc(nt.senderAccountID)} → ${acc(nt.receiverAccountID)}`);
      }
    }
    const involved = [
      ...(ct.transfers?.accountAmounts ?? []).map((/** @type {any} */ aa) => acc(aa.accountID)),
      ...(ct.tokenTransfers ?? []).flatMap((/** @type {any} */ l) => [...(l.transfers ?? []).map((/** @type {any} */ aa) => acc(aa.accountID)), ...(l.nftTransfers ?? []).flatMap((/** @type {any} */ nt) => [acc(nt.senderAccountID), acc(nt.receiverAccountID)])]),
    ];
    const debited = [
      ...(ct.transfers?.accountAmounts ?? []).filter((/** @type {any} */ aa) => num(aa.amount) < 0n).map((/** @type {any} */ aa) => acc(aa.accountID)),
      ...(ct.tokenTransfers ?? []).flatMap((/** @type {any} */ l) => [
        ...(l.transfers ?? []).filter((/** @type {any} */ aa) => num(aa.amount) < 0n).map((/** @type {any} */ aa) => acc(aa.accountID)),
        ...(l.nftTransfers ?? []).map((/** @type {any} */ nt) => acc(nt.senderAccountID)),
      ]),
    ];
    if (debited.some(isVault)) vaultBlock();
    else if (involved.some(isVault)) warn(T("La transferencia incluye tu bóveda.", "The transfer involves your vault."));
    // ¿Salen varios activos de tu Cartera y no entra ninguno? Es lo que pide una web que roba («reclama tu
    // premio»): se lleva los HBAR, los tokens y los NFT en una sola firma.
    const leaving = new Set();
    let incoming = false;
    for (const aa of ct.transfers?.accountAmounts ?? []) {
      if (!isMe(acc(aa.accountID))) continue;
      if (num(aa.amount) < 0n) leaving.add("HBAR");
      else if (num(aa.amount) > 0n) incoming = true;
    }
    for (const l of ct.tokenTransfers ?? []) {
      for (const aa of l.transfers ?? []) {
        if (!isMe(acc(aa.accountID))) continue;
        if (num(aa.amount) < 0n) leaving.add(tok(l.token));
        else if (num(aa.amount) > 0n) incoming = true;
      }
      for (const nt of l.nftTransfers ?? []) {
        if (isMe(acc(nt.senderAccountID))) leaving.add(`${tok(l.token)}#${num(nt.serialNumber)}`);
        if (isMe(acc(nt.receiverAccountID))) incoming = true;
      }
    }
    if (leaving.size >= 3 && !incoming) {
      warn(
        T(
          `Salen ${leaving.size} activos distintos de tu Cartera y no recibes nada a cambio. Así vacía una cartera una web que roba: firma solo si lo has pedido tú.`,
          `${leaving.size} different assets leave your Wallet and you get nothing in return. This is how a scam site empties a wallet: sign only if you asked for it.`,
        ),
        true,
      );
    }
  } else if (body.cryptoApproveAllowance) {
    const al = body.cryptoApproveAllowance;
    d.title = T("Dar permiso para gastar", "Grant a spending allowance");
    const owners = [...(al.cryptoAllowances ?? []), ...(al.tokenAllowances ?? []), ...(al.nftAllowances ?? [])].map((/** @type {any} */ a) => (a.owner ? acc(a.owner) : payer));
    if (owners.some(isVault)) vaultBlock();
    for (const a of al.cryptoAllowances ?? []) {
      const amount = num(a.amount);
      d.lines.push(T(`${acc(a.spender)} podrá gastar ${amount >= UNLIMITED ? "HBAR sin límite" : hbar(amount)} de ${a.owner ? acc(a.owner) : payer}`, `${acc(a.spender)} may spend ${amount >= UNLIMITED ? "unlimited HBAR" : hbar(amount)} from ${a.owner ? acc(a.owner) : payer}`));
      if (amount >= UNLIMITED) warn(T("Permiso de HBAR sin límite.", "Unlimited HBAR allowance."), true);
    }
    for (const a of al.tokenAllowances ?? []) {
      const tokenId = tok(a.tokenId);
      const amount = num(a.amount);
      d.lines.push(T(`${acc(a.spender)} podrá gastar ${units(tokenId, amount)}`, `${acc(a.spender)} may spend ${units(tokenId, amount)}`));
      if (amount >= UNLIMITED) warn(T(`Permiso sin límite sobre ${meta(tokenId)?.symbol ?? tokenId}.`, `Unlimited allowance on ${meta(tokenId)?.symbol ?? tokenId}.`), true);
    }
    for (const a of al.nftAllowances ?? []) {
      const tokenId = tok(a.tokenId);
      if (a.approvedForAll?.value) {
        d.lines.push(T(`${acc(a.spender)} podrá mover TODOS tus NFT de ${tokName(tokenId)}`, `${acc(a.spender)} may move ALL your ${tokName(tokenId)} NFTs`));
        warn(T(`Permiso sobre toda la colección ${tokName(tokenId)}.`, `Allowance on the whole ${tokName(tokenId)} collection.`), true);
      } else {
        const serials = (a.serialNumbers ?? []).map((/** @type {any} */ x) => `#${num(x)}`).join(", ");
        d.lines.push(T(`${acc(a.spender)} podrá mover NFT ${tokName(tokenId)} ${serials}`, `${acc(a.spender)} may move NFT ${tokName(tokenId)} ${serials}`));
      }
    }
    warn(T("Un permiso deja a otra cuenta mover tus fondos sin volver a preguntarte. Concédelo solo a la dApp que estás usando (se quita en Ajustes → Permisos de gasto).", "An allowance lets another account move your funds without asking again. Grant it only to the dApp you are using (remove it in Settings → Spending allowances)."), true);
  } else if (body.cryptoDeleteAllowance) {
    d.title = T("Quitar permisos de NFT", "Remove NFT allowances");
  } else if (body.contractCall) {
    const c = body.contractCall;
    const amount = num(c.amount);
    d.title = T("Interactuar con un contrato", "Interact with a contract");
    d.lines.push(T(`Contrato ${con(c.contractID)}`, `Contract ${con(c.contractID)}`));
    if (c.functionParameters?.length >= 4) d.lines.push(T(`Función ${hexlify(c.functionParameters.slice(0, 4))}`, `Function ${hexlify(c.functionParameters.slice(0, 4))}`));
    if (amount > 0n) {
      d.lines.push(T(`Envía ${hbar(amount)} al contrato`, `Sends ${hbar(amount)} to the contract`));
      if (payer === account) d.outgoingTinybars += amount;
    }
    d.lines.push(T(`Gas máximo: ${num(c.gas).toString()}`, `Max gas: ${num(c.gas).toString()}`));
    warn(T("Un contrato puede mover lo que tenga permitido. Revisa que sea la dApp que esperas.", "A contract can move whatever it is allowed to. Check it's the dApp you expect."));
    // Lo mismo que un permiso o una transferencia, pero por la puerta EVM: se enseña y se avisa igual.
    const call = evmCallOf(c);
    const allowanceNote = T("Un permiso deja a otra cuenta mover tus fondos sin volver a preguntarte. Concédelo solo a la dApp que estás usando (se quita en Ajustes → Permisos de gasto).", "An allowance lets another account move your funds without asking again. Grant it only to the dApp you are using (remove it in Settings → Spending allowances).");
    if (call?.kind === "approve") {
      const nft = meta(call.tokenId)?.fungible === false;
      if (nft ? call.spender === "0.0.0" : call.amount === 0n) {
        d.lines.push(T(`Quita un permiso sobre ${tokName(call.tokenId)}`, `Removes an allowance on ${tokName(call.tokenId)}`));
      } else {
        d.title = T("Dar permiso para gastar", "Grant a spending allowance");
        d.lines.push(
          nft
            ? T(`${call.spender} podrá mover tu NFT ${tokName(call.tokenId)} #${call.amount}`, `${call.spender} may move your NFT ${tokName(call.tokenId)} #${call.amount}`)
            : T(`${call.spender} podrá gastar ${units(call.tokenId, call.amount)}`, `${call.spender} may spend ${units(call.tokenId, call.amount)}`),
        );
        if (!nft && call.amount >= UNLIMITED) warn(T(`Permiso sin límite sobre ${symOf(call.tokenId)}.`, `Unlimited allowance on ${symOf(call.tokenId)}.`), true);
        warn(allowanceNote, true);
      }
    } else if (call?.kind === "approveAll") {
      if (!call.approved) {
        d.lines.push(T(`Quita el permiso sobre la colección ${tokName(call.tokenId)}`, `Removes the allowance on the ${tokName(call.tokenId)} collection`));
      } else {
        d.title = T("Dar permiso para gastar", "Grant a spending allowance");
        d.lines.push(T(`${call.spender} podrá mover TODOS tus NFT de ${tokName(call.tokenId)}`, `${call.spender} may move ALL your ${tokName(call.tokenId)} NFTs`));
        warn(T(`Permiso sobre toda la colección ${tokName(call.tokenId)}.`, `Allowance on the whole ${tokName(call.tokenId)} collection.`), true);
        warn(allowanceNote, true);
      }
    } else if (call?.kind === "hbarApprove") {
      if (call.owner && isVault(call.owner)) vaultBlock();
      if (call.amount <= 0n) {
        d.lines.push(T("Quita un permiso sobre tus HBAR", "Removes an allowance on your HBAR"));
      } else {
        d.title = T("Dar permiso para gastar", "Grant a spending allowance");
        d.lines.push(T(`${call.spender} podrá gastar ${call.amount >= UNLIMITED ? "HBAR sin límite" : hbar(call.amount)}`, `${call.spender} may spend ${call.amount >= UNLIMITED ? "unlimited HBAR" : hbar(call.amount)}`));
        if (call.amount >= UNLIMITED) warn(T("Permiso de HBAR sin límite.", "Unlimited HBAR allowance."), true);
        warn(allowanceNote, true);
      }
    } else if (call?.kind === "transfer") {
      const what = meta(call.tokenId)?.fungible === false ? `NFT ${tokName(call.tokenId)} #${call.amount}` : units(call.tokenId, call.amount);
      d.title = T("Transferencia a través de un contrato", "Transfer through a contract");
      d.lines.push(call.from ? `${what}: ${call.from} → ${call.to}` : `${what} → ${call.to}`);
      if (call.from && isVault(call.from)) vaultBlock();
    } else if (call?.kind === "system") {
      warn(
        T(
          "Es una llamada directa a un contrato del sistema de Hedera con la llave de tu Cartera: puede mover tus tokens o dar permisos, y desde aquí no se ve cuál. Las dApps de la lista no lo necesitan.",
          "It's a direct call to a Hedera system contract with your Wallet's key: it can move your tokens or grant allowances, and which one can't be seen from here. The listed dApps don't need it.",
        ),
        true,
      );
    }
    // La bóveda también tiene dirección: llamarla como si fuera un contrato es intentar tocarla.
    if (isVault(evmName(con(c.contractID)))) vaultBlock();
    // Tu Cartera ES el «móvil» de la bóveda: llamando al notario abriría (o bloquearía) operaciones.
    if (isNotary(con(c.contractID))) block(T("Es una llamada al notario de tu bóveda: solo puede hacerla H10X Wallet. Bloqueado.", "It's a call to your vault's notary: only H10X Wallet can make it. Blocked."));
    if (isScheduleService(con(c.contractID))) block(T("Firmaría operaciones programadas con la llave de tu Cartera. Bloqueado.", "It would sign scheduled operations with your Wallet's key. Blocked."));
  } else if (body.tokenAssociate) {
    d.title = T("Añadir tokens a tu Cartera", "Add tokens to your Wallet");
    for (const t of body.tokenAssociate.tokens ?? []) d.lines.push(meta(tok(t))?.name ? `${meta(tok(t))?.name} (${tok(t)})` : tok(t));
  } else if (body.tokenDissociate) {
    d.title = T("Quitar tokens de tu Cartera", "Remove tokens from your Wallet");
    for (const t of body.tokenDissociate.tokens ?? []) d.lines.push(tok(t));
    warn(T("Si tienes saldo de esos tokens, no se podrá quitar.", "If you hold those tokens, it can't be removed."));
  } else if (body.tokenClaimAirdrop) {
    d.title = T("Reclamar un airdrop", "Claim an airdrop");
  } else if (body.tokenCancelAirdrop) {
    d.title = T("Cancelar un airdrop", "Cancel an airdrop");
  } else if (body.tokenReject) {
    d.title = T("Rechazar tokens (los devuelve a su tesorería)", "Reject tokens (returns them to the treasury)");
    // Sin dueño indicado, los tokens que se devuelven son los de quien paga.
    if (isVault(body.tokenReject.owner ? acc(body.tokenReject.owner) : payer)) vaultBlock();
    warn(T("Los tokens rechazados salen de tu Cartera.", "Rejected tokens leave your Wallet."), true);
  } else if (body.consensusSubmitMessage) {
    d.title = T("Publicar un mensaje en un tema", "Post a message to a topic");
  } else if (body.utilPrng) {
    d.title = T("Número aleatorio", "Random number");
  } else if (body.cryptoCreateAccount) {
    const amount = num(body.cryptoCreateAccount.initialBalance);
    d.title = T("Crear una cuenta", "Create an account");
    if (amount > 0n) d.lines.push(T(`Saldo inicial: ${hbar(amount)} (sale de tu Cartera)`, `Initial balance: ${hbar(amount)} (from your Wallet)`));
    d.outgoingTinybars += amount;
  } else if (body.tokenCreation || body.tokenMint || body.tokenBurn || body.tokenUpdate || body.tokenUpdateNfts || body.tokenFeeScheduleUpdate || body.tokenPause || body.tokenUnpause || body.tokenFreeze || body.tokenUnfreeze || body.tokenGrantKyc || body.tokenRevokeKyc || body.tokenWipe || body.tokenDeletion) {
    d.title = T("Gestionar un token que creaste", "Manage a token you created");
    warn(T("Operación de creador de tokens. Hazla solo si sabes lo que estás haciendo.", "Token creator operation. Do it only if you know what you're doing."));
  } else if (body.fileCreate || body.fileAppend) {
    d.title = T("Subir un archivo a la red", "Upload a file to the network");
  } else if (body.contractCreateInstance) {
    d.title = T("Desplegar un contrato", "Deploy a contract");
    warn(T("Desplegar un contrato cuesta HBAR.", "Deploying a contract costs HBAR."));
  } else if (body.scheduleCreate) {
    d.title = T("Programar una operación", "Schedule an operation");
    const inner = body.scheduleCreate.scheduledTransactionBody;
    if (inner && depth < 2) {
      // La programada la paga `payerAccountID` si viene; si no, quien la crea.
      const schedPayer = body.scheduleCreate.payerAccountID;
      if (schedPayer && acc(schedPayer) !== account) warn(T(`La operación programada la pagaría otra cuenta (${acc(schedPayer)}).`, `The scheduled operation would be paid by another account (${acc(schedPayer)}).`), true);
      const sub = describeDappTransaction({ ...inner, transactionID: schedPayer ? { accountID: schedPayer } : body.transactionID }, { account, vaultId, notaryId, meta, lang, depth: depth + 1 });
      d.lines.push(T(`Dentro: ${sub.title}`, `Inside: ${sub.title}`), ...sub.lines);
      d.warnings.push(...sub.warnings);
      if (sub.blocked) block(sub.blocked);
      d.danger ||= sub.danger;
    }
    warn(T("Se ejecutará más tarde, cuando reúna las firmas.", "It will run later, once it has the signatures."));
  } else if (body.scheduleSign) {
    d.title = T("Firmar una operación programada", "Sign a scheduled operation");
    d.lines.push(T(`Operación ${num(body.scheduleSign.scheduleID?.scheduleNum)}`, `Operation ${num(body.scheduleSign.scheduleID?.scheduleNum)}`));
    // Con la llave de la Cartera (la del «móvil») se completaría una operación de la bóveda: con el kit
    // filtrado, móvil + kit es la evacuación inmediata. Las dApps de la lista no lo necesitan.
    block(T("Firmar operaciones programadas ajenas puede mover dinero de tu bóveda. Bloqueado.", "Signing someone else's scheduled operations can move money from your vault. Blocked."));
  } else if (body.atomicBatch) {
    d.title = T("Varias operaciones juntas", "Several operations together");
    const inners = depth < 2 ? innerBatchBodies(body) : [];
    if (inners.length === 0) block(T("No se puede leer el lote de operaciones.", "The batch of operations can't be read."));
    for (const inner of inners) {
      const sub = describeDappTransaction(inner, { account, vaultId, notaryId, meta, lang, depth: depth + 1 });
      d.lines.push(`• ${sub.title}`, ...sub.lines.map((l) => `   ${l}`));
      d.warnings.push(...sub.warnings);
      d.outgoingTinybars += sub.outgoingTinybars;
      if (sub.blocked) block(sub.blocked);
      d.danger ||= sub.danger;
    }
  } else if (body.ethereumTransaction) {
    d.title = T("Transacción EVM", "EVM transaction");
    // Va firmada por dentro con otra llave: tu Cartera solo pondría el dinero, y aquí no se ve qué hace.
    block(T("Es una transacción EVM firmada con otra llave: tu Cartera solo pagaría su coste y no se puede ver qué hace. Bloqueado.", "It's an EVM transaction signed with another key: your Wallet would only pay for it and what it does can't be seen. Blocked."));
  } else if (body.cryptoUpdateAccount) {
    const u = body.cryptoUpdateAccount;
    d.title = T("Cambiar ajustes de una cuenta", "Change an account's settings");
    if (isVault(acc(u.accountIDToUpdate))) vaultBlock();
    const touched = presentFields(u).filter((k) => k !== "accountIDToUpdate");
    const harmless = new Set(["memo", "stakedNodeId", "declineReward", "maxAutomaticTokenAssociations"]);
    if (u.key) block(T("Una dApp nunca debe cambiar la llave de tu cuenta. Bloqueado.", "A dApp must never change your account key. Blocked."));
    // Hacer staking «a otra cuenta» le da a esa cuenta las recompensas de la tuya.
    else if (u.stakedAccountId) block(T("Mandaría las recompensas de staking de tu Cartera a otra cuenta. Bloqueado.", "It would send your Wallet's staking rewards to another account. Blocked."));
    else if (touched.some((k) => !harmless.has(k))) block(T("Cambia ajustes de seguridad de la cuenta. Bloqueado.", "It changes account security settings. Blocked."));
    else d.lines.push(...touched);
  } else if (body.cryptoDelete) {
    block(T("Borraría tu cuenta y enviaría todo a otra. Bloqueado.", "It would delete your account and send everything elsewhere. Blocked."));
    d.title = T("Borrar cuenta", "Delete account");
  } else {
    const kind = presentFields(body).find((k) => !["transactionID", "nodeAccountID", "transactionFee", "transactionValidDuration", "memo", "generateRecord", "maxCustomFees", "batchKey"].includes(k)) ?? "?";
    d.title = T(`Operación no permitida (${kind})`, `Operation not allowed (${kind})`);
    block(T("H10X Wallet no deja firmar este tipo de operación a una dApp.", "H10X Wallet doesn't let a dApp sign this kind of operation."));
  }

  if (depth === 0) {
    // Tokens con una web en el nombre (la estafa de los regalos) o que se hacen llamar HBAR.
    for (const tokenId of tokenIdsOfBodies([body])) {
      const m = meta(tokenId);
      if (!m) continue;
      if (hasLink(m.name) || hasLink(m.symbol)) {
        warn(T(`El token ${tokenId} trae una web en su nombre. Es típico de estafas: no la busques.`, `Token ${tokenId} has a website in its name. That's typical of scams: don't look it up.`), true);
      }
      if (fakesHbar(m.symbol) || fakesHbar(m.name)) warn(T(`El token ${tokenId} se hace llamar HBAR, pero no es HBAR.`, `Token ${tokenId} calls itself HBAR, but it isn't HBAR.`), true);
    }
    if (body.memo) {
      const note = hideLinks(String(body.memo).slice(0, 100), lang);
      d.lines.push(T(`Nota: ${note}`, `Memo: ${note}`));
      if (hasLink(String(body.memo))) warn(T("La nota trae una web. No la busques: H10X Wallet nunca te manda a una web a firmar ni a escribir tus palabras.", "The memo carries a website. Don't look it up: H10X Wallet never sends you to a website to sign or type your words."), true);
    }
    if (d.outgoingTinybars > 0n) d.lines.unshift(T(`Sale de tu Cartera: ${hbar(d.outgoingTinybars)}`, `Leaves your Wallet: ${hbar(d.outgoingTinybars)}`));
    d.lines.push(T(`Comisión máxima de red: ${hbar(maxFee)}`, `Max network fee: ${hbar(maxFee)}`));
  }
  if (!d.title) d.title = T("Operación", "Operation");
  return d;
}

// ---------------------------------------------------------------------------------------------
// Firmas (formato HIP-820)
// ---------------------------------------------------------------------------------------------

/** Lo que de verdad se firma en hedera_signMessage (con prefijo: así nunca vale como transacción). @param {string} message */
export const prefixedMessage = (message) => toUtf8Bytes(`\x19Hedera Signed Message:\n${message.length}${message}`);

/**
 * SignatureMap en base64 con una firma de la llave dada.
 * @param {import("@hiero-ledger/sdk").PrivateKey} key @param {Uint8Array} bytes
 */
export function signatureMapBase64(key, bytes) {
  const signature = key.sign(bytes);
  // El SDK sabe poner la firma en el campo que toca (ed25519 o ECDSA secp256k1).
  const pair = key.publicKey._toProtobufSignature(signature);
  return encodeBase64(proto.SignatureMap.encode({ sigPair: [pair] }).finish());
}

/**
 * Transacciones sin congelar (HIP-745): se completan con la Cartera como pagadora ANTES de enseñarlas,
 * para que lo que se ve sea exactamente lo que se firma.
 * @template {DappRequest} R @param {R} req @param {import("@hiero-ledger/sdk").Client} client @param {string} [accountId]
 * @returns {R}
 */
export function freezeDappRequest(req, client, accountId = req.method === "hedera_signAndExecuteTransaction" ? req.signer : "") {
  if (req.method !== "hedera_signAndExecuteTransaction") return req;
  const tx = Transaction.fromBytes(req.listBytes);
  if (tx.isFrozen()) return req;
  // Paga la Cartera (si la dApp no lo dijo): así nunca hace falta la llave para preparar la transacción.
  if (!tx.transactionId && accountId) tx.setTransactionId(TransactionId.generate(accountId));
  tx.freezeWith(client);
  const listBytes = tx.toBytes();
  return { ...req, listBytes, bodies: bodiesOfTransactionList(listBytes) };
}

/**
 * Atiende una petición ya aprobada por el usuario y devuelve el resultado HIP-820.
 * @param {DappRequest} req @param {{ client: import("@hiero-ledger/sdk").Client, key: import("@hiero-ledger/sdk").PrivateKey }} p
 */
export async function executeDappRequest(req, { client, key }) {
  switch (req.method) {
    case "hedera_getNodeAddresses":
      return { nodes: Object.values(client.network).map((n) => n.toString()) };
    case "hedera_signMessage":
      return { signatureMap: signatureMapBase64(key, prefixedMessage(req.message)) };
    case "hedera_signTransaction":
      return { signatureMap: signatureMapBase64(key, req.bodyBytes) };
    case "hedera_signAndExecuteTransaction": {
      const tx = Transaction.fromBytes(req.listBytes);
      if (!tx.isFrozen()) throw new DappError("not_frozen", tr("La transacción no estaba preparada.", "The transaction was not prepared."));
      await tx.sign(key);
      const response = await tx.execute(client);
      return response.toJSON();
    }
    case "hedera_executeTransaction": {
      const response = await Transaction.fromBytes(req.listBytes).execute(client);
      return response.toJSON();
    }
    default:
      throw new DappError("method_not_allowed", tr("H10X Wallet no permite esta petición.", "H10X Wallet doesn't allow this request."));
  }
}

/** Respuesta de error HIP-820 a partir de un código de estado de Hedera. @param {string} status */
export const hip820Error = (status) => ({ code: 9000, message: status, data: status });

/**
 * Texto del mensaje a firmar, preparado para enseñarlo (sin caracteres de control).
 * @param {string} message
 */
export const printableMessage = (message) => message.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "·").slice(0, 1500);

/** Las dApps que hay en la lista, con su texto en el idioma pedido. @param {import("./i18n.js").Lang} [lang] */
export const dappList = (lang = coreLanguage()) => DAPPS.map((d) => ({ ...d, description: tr(d.kind.es, d.kind.en, lang) }));

export { decodeBase64 as base64ToBytes };
