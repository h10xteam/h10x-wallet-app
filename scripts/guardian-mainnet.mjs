#!/usr/bin/env node
// Guardián de MAINNET (beta). Lo ejecuta el usuario hvault (desde root: «hvault-vps mainnet preparar | estado»).
//
//   node scripts/guardian-mainnet.mjs preparar   crea guardian/.env.mainnet con una clave NUEVA generada aquí
//                                                (permisos 600) y dice a qué dirección mandar HBAR
//   node scripts/guardian-mainnet.mjs estado     ¿existe ya la cuenta en mainnet y cuánto saldo tiene?
//
// La clave nunca se enseña ni sale del servidor: solo se imprime la dirección pública (0x…) para mandarle HBAR. Al
// llegar los HBAR, Hedera crea la cuenta sola; el guardián la encuentra por esa dirección (no hace falta OPERATOR_ID).
// Del .env de testnet se copian, si están, el correo, el aviso al administrador y la clave de SaucerSwap (sin enseñarlos).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@hiero-ledger/sdk";
import { MAINNET_BETA, NETWORKS } from "../core/src/config.js";
import { parsePrivateKey } from "../core/src/keys.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GUARDIAN = process.env.HVAULT_GUARDIAN_DIR ? resolve(process.env.HVAULT_GUARDIAN_DIR) : join(ROOT, "guardian");
const TESTNET_ENV = join(GUARDIAN, ".env");
const MAINNET_ENV = join(GUARDIAN, ".env.mainnet");
/** HBAR que conviene tener: cada llamada al notario cuesta unos 0,2 HBAR; por debajo de 10 el guardián avisa. */
const FUND_HBAR = 50;
const MIN_HBAR = 10;
/** Del .env de testnet se copian estas (si están). Nunca se imprimen sus valores. */
const COPY = ["EMAIL_PROVIDER", "EMAIL_API_KEY", "EMAIL_FROM", "EMAIL_FROM_NAME", "EMAIL_PER_DAY", "ADMIN_NTFY_URL", "SAUCERSWAP_API_KEY"];

/** Variables de un .env (sin comentarios). */
function readEnv(file) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const evmOf = (key) => `0x${key.publicKey.toEvmAddress()}`.toLowerCase();

function preparar() {
  if (existsSync(MAINNET_ENV)) {
    const env = readEnv(MAINNET_ENV);
    if (!env.OPERATOR_KEY) {
      console.error(`⛔ ${MAINNET_ENV} existe pero no tiene OPERATOR_KEY. Revísalo a mano (no lo sobrescribo).`);
      process.exit(1);
    }
    console.log("Ya estaba preparado (no lo toco).");
    console.log(`Dirección del guardián de mainnet: ${evmOf(parsePrivateKey(env.OPERATOR_KEY, env.OPERATOR_KEY_TYPE))}`);
    console.log("Siguiente: hvault-vps mainnet estado");
    return;
  }
  const testnet = readEnv(TESTNET_ENV);
  const testnetPort = Number(testnet.PORT || 8787);
  const port = testnetPort === 8798 ? 8799 : 8798;
  const key = PrivateKey.generateECDSA();
  const copied = COPY.filter((k) => testnet[k]);
  const lines = [
    "# Guardián de MAINNET (beta). Lo creó «hvault-vps mainnet preparar»: la clave se generó en este servidor y nunca",
    "# debe salir de aquí. Dinero de verdad: los topes de la beta son obligatorios (sin ellos el guardián no arranca).",
    "HEDERA_NETWORK=mainnet",
    `OPERATOR_KEY=${key.toStringDer()}`,
    "# Cuenta: se encuentra sola por la dirección de la clave (cuenta creada al recibir HBAR).",
    "OPERATOR_ID=",
    "HOST=127.0.0.1",
    `PORT=${port}`,
    "DATA_DIR=data-mainnet",
    "POLL_SECONDS=10",
    "",
    "# Topes de la beta: HBAR por bóveda y bóvedas que vigila como mucho. La app de mainnet trae además su propio tope",
    `# (${MAINNET_BETA.maxVaultHbar} HBAR) y aplica el más bajo de los dos.`,
    `MAX_VAULT_HBAR=${MAINNET_BETA.maxVaultHbar}`,
    "MAX_VAULTS=25",
    "",
    "# Llamadas al notario que paga el guardián, por bóveda y día (completar, bloquear y congelar).",
    `BUDGET_APPROVES_DAY=${MAINNET_BETA.budget.approve}`,
    `BUDGET_VETOES_DAY=${MAINNET_BETA.budget.veto}`,
    `BUDGET_FREEZES_DAY=${MAINNET_BETA.budget.freeze}`,
    `MIN_BALANCE_HBAR=${MIN_HBAR}`,
    "RESERVE_HBAR=2",
    "",
    "# Avisos de H10X (DAO y cesta).",
    "H10X_ALERTS=1",
    "",
    ...(copied.length ? ["# Copiado del .env de testnet:", ...copied.map((k) => `${k}=${testnet[k]}`)] : []),
    "",
  ];
  // wx: nunca sobrescribe; 600: solo lo lee hvault.
  writeFileSync(MAINNET_ENV, lines.join("\n"), { mode: 0o600, flag: "wx" });
  console.log(`✅ Creado ${MAINNET_ENV} (permisos 600) con una clave nueva, puerto ${port} y topes ${MAINNET_BETA.maxVaultHbar} HBAR / 25 bóvedas.`);
  if (copied.length) console.log(`   Copiado del .env de testnet: ${copied.join(", ")}`);
  console.log("");
  console.log(`Manda ${FUND_HBAR} HBAR desde HashPack (mainnet) a esta dirección:`);
  console.log(`   ${evmOf(key)}`);
  console.log("Hedera crea la cuenta al llegar el dinero. Después: hvault-vps mainnet estado");
}

async function estado() {
  const env = readEnv(MAINNET_ENV);
  if (!env.OPERATOR_KEY) {
    console.error("⛔ Falta guardian/.env.mainnet. Primero: hvault-vps mainnet preparar");
    process.exit(1);
  }
  const evm = evmOf(parsePrivateKey(env.OPERATOR_KEY, env.OPERATOR_KEY_TYPE));
  console.log(`Dirección del guardián de mainnet: ${evm}`);
  console.log(`Topes: ${env.MAX_VAULT_HBAR || "—"} HBAR por bóveda · ${env.MAX_VAULTS || "—"} bóvedas · puerto ${env.PORT || "—"}`);
  const mirror = env.MIRROR_URL || NETWORKS.mainnet.mirror;
  let res;
  try {
    res = await fetch(`${mirror}/api/v1/accounts/${evm}`, { signal: AbortSignal.timeout(15000) });
  } catch (e) {
    console.error(`⛔ No puedo leer el mirror de mainnet: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  if (res.status === 404) {
    console.log(`⏳ La cuenta aún no existe: manda ${FUND_HBAR} HBAR a ${evm} desde HashPack (mainnet).`);
    process.exit(2);
  }
  if (!res.ok) {
    console.error(`⛔ El mirror de mainnet responde ${res.status}`);
    process.exit(1);
  }
  const acc = await res.json();
  const hbar = Number(acc?.balance?.balance ?? 0) / 1e8;
  console.log(`Cuenta ${acc.account} · ${hbar.toFixed(2)} HBAR`);
  if (hbar < MIN_HBAR) {
    console.log(`⏳ Con menos de ${MIN_HBAR} HBAR el guardián solo bloquea. Recárgala hasta unos ${FUND_HBAR} HBAR.`);
    process.exit(2);
  }
  console.log("✅ Lista. Siguiente: hvault-vps mainnet activar");
}

const cmd = process.argv[2];
if (cmd === "preparar") preparar();
else if (cmd === "estado") await estado();
else {
  console.error("Uso: node scripts/guardian-mainnet.mjs preparar | estado");
  process.exit(1);
}
