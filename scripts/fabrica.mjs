#!/usr/bin/env node
// Fábrica de notarios: se despliega UNA vez por red y la paga la cuenta del guardián de esa red. Lo ejecuta el usuario
// hvault (desde root: «hvault-vps fabrica …»).
//
//   node scripts/fabrica.mjs estado [--mainnet]
//   node scripts/fabrica.mjs desplegar [--mainnet] [--confirmar]
//
// Escribe guardian/data/fabrica.json (o data-mainnet/ con --mainnet). El guardián la anuncia en /info y la app, antes de
// usarla, comprueba que su código en la red es exactamente el compilado (core/src/factory.js). En mainnet cuesta unos
// 2,3 $ (≈ 45 HBAR) y hay que pasar --confirmar: sin él solo dice lo que haría.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FACTORY3_RUNTIME_KECCAK, Mirror, NETWORKS, checkNotaryFactory, createClient, deployNotaryFactory, formatHbar, parsePrivateKey } from "../core/src/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GUARDIAN = process.env.HVAULT_GUARDIAN_DIR ? resolve(process.env.HVAULT_GUARDIAN_DIR) : join(ROOT, "guardian");
const args = process.argv.slice(2);
const MAINNET = args.includes("--mainnet");
const CONFIRM = args.includes("--confirmar");
const cmd = args.find((a) => !a.startsWith("--")) ?? "estado";
/** Lo que cuesta, en dólares (testnet, nov. 2026: 45,1 HBAR con el HBAR a 0,0496 $ = 2,24 $). */
const COST_USD = 2.3;
/** Lo que debe quedarle al guardián después (por debajo de 10 HBAR solo bloquea). */
const KEEP_HBAR = 12;

/** Variables del .env del guardián (solo se usan estas; nunca se imprimen). */
function readEnv(file) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && ["OPERATOR_KEY", "OPERATOR_KEY_TYPE", "OPERATOR_ID", "HEDERA_NETWORK", "MIRROR_URL", "DATA_DIR"].includes(m[1])) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = readEnv(join(GUARDIAN, MAINNET ? ".env.mainnet" : ".env"));
const network = /** @type {import("../core/src/config.js").NetworkName} */ ((env.HEDERA_NETWORK || (MAINNET ? "mainnet" : "testnet")).toLowerCase());
if (MAINNET !== (network === "mainnet")) {
  console.error(`⛔ El .env del guardián dice «${network}»: ${MAINNET ? "para mainnet usa guardian/.env.mainnet" : "sin --mainnet es para testnet"}.`);
  process.exit(1);
}
if (!NETWORKS[network]) {
  console.error(`⛔ Red desconocida: ${network}`);
  process.exit(1);
}
const dataDir = resolve(GUARDIAN, env.DATA_DIR || (MAINNET ? "data-mainnet" : "data"));
const FILE = join(dataDir, "fabrica.json");
const mirror = new Mirror(env.MIRROR_URL || NETWORKS[network].mirror);
console.log(`Red ${network.toUpperCase()} · huella de la fábrica buena ${FACTORY3_RUNTIME_KECCAK.slice(0, 18)}…`);

function saved() {
  if (!existsSync(FILE)) return null;
  try {
    return JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    return null;
  }
}

async function estado() {
  const f = saved();
  if (!f?.factoryId) {
    console.log("Sin fábrica desplegada: la app crea los notarios directamente (≈ 28 HBAR por bóveda).");
    console.log(`Para desplegarla: hvault-vps fabrica desplegar${MAINNET ? " --mainnet" : ""}`);
    return;
  }
  const ok = await checkNotaryFactory({ mirror, factoryId: f.factoryId });
  console.log(`Fábrica ${f.factoryId} · desplegada ${f.deployedAt ?? "?"}`);
  console.log(ok ? "✅ Su código en la red es el bueno y nadie puede cambiarla: el guardián la anuncia y la app la usa." : "❌ No pasa la comprobación (código o clave de administrador): ni el guardián la anuncia ni la app la usaría.");
}

async function desplegar() {
  const prev = saved();
  if (prev?.factoryId && (await checkNotaryFactory({ mirror, factoryId: prev.factoryId }))) {
    console.log(`✅ Ya hay una fábrica buena en esta red: ${prev.factoryId}. No hace falta otra.`);
    return;
  }
  if (!env.OPERATOR_KEY) {
    console.error(`⛔ Falta OPERATOR_KEY en guardian/${MAINNET ? ".env.mainnet" : ".env"}.`);
    process.exit(1);
  }
  const key = parsePrivateKey(env.OPERATOR_KEY, env.OPERATOR_KEY_TYPE);
  const acc = env.OPERATOR_ID ? await mirror.account(env.OPERATOR_ID) : await mirror.account(`0x${key.publicKey.toEvmAddress()}`);
  if (!acc) {
    console.error("⛔ No encuentro la cuenta del guardián en la red.");
    process.exit(1);
  }
  const rate = await fetch(`${mirror.baseUrl}/api/v1/network/exchangerate`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const usd = rate ? rate.current_rate.cent_equivalent / rate.current_rate.hbar_equivalent / 100 : null;
  const costHbar = usd ? Math.ceil((COST_USD / usd) * 1.15) : 60;
  const needed = BigInt(costHbar + KEEP_HBAR) * 100_000_000n;
  console.log(`Paga el guardián ${acc.id} · saldo ${formatHbar(acc.balance)} HBAR`);
  console.log(`Coste: unos ${COST_USD} $ (${usd ? `≈ ${Math.ceil(COST_USD / usd)} HBAR al cambio de la red, ${usd.toFixed(4)} $` : "sin cambio de la red"}), una sola vez.`);
  if (acc.balance < needed) {
    console.log(`⛔ Hacen falta al menos ${formatHbar(needed)} HBAR (el coste con margen y ${KEEP_HBAR} HBAR que le deben quedar al guardián).`);
    console.log(`   Recarga la cuenta ${acc.id} (${acc.evmAddress}) y vuelve a lanzarlo.`);
    process.exit(2);
  }
  if (MAINNET && !CONFIRM) {
    console.log("Todo listo. Para desplegarla de verdad: hvault-vps fabrica desplegar --mainnet --confirmar");
    return;
  }
  const build = JSON.parse(readFileSync(join(ROOT, "scripts/build/NotaryFactory3.json"), "utf8"));
  if (build.runtimeKeccak !== FACTORY3_RUNTIME_KECCAK) {
    console.error("⛔ scripts/build/NotaryFactory3.json no es la fábrica que espera la app (npm run compile).");
    process.exit(1);
  }
  const client = createClient(network, { accountId: acc.id, key });
  console.log("Subiendo el código y creando la fábrica (un par de minutos)…");
  try {
    const out = await deployNotaryFactory({ client, mirror, initcode: build.bytecode, maxFeeHbar: Math.min(80, costHbar) });
    mkdirSync(dataDir, { recursive: true });
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify({ network, factoryId: out.factoryId, evmAddress: out.evmAddress, txId: out.txId, runtimeKeccak: FACTORY3_RUNTIME_KECCAK, deployedAt: new Date().toISOString() }, null, 2) + "\n");
    renameSync(tmp, FILE);
    const after = await mirror.account(acc.id.toString()).catch(() => null);
    console.log(`✅ Fábrica ${out.factoryId} desplegada sin clave de administrador y con el código bueno.`);
    if (after) console.log(`   Coste real: ${formatHbar(acc.balance - after.balance)} HBAR · le quedan ${formatHbar(after.balance)} HBAR al guardián.`);
    console.log("   El guardián la anuncia en menos de un minuto; las bóvedas nuevas ya la usan.");
  } finally {
    client.close();
  }
}

if (cmd === "estado") await estado();
else if (cmd === "desplegar") await desplegar();
else {
  console.error("Uso: node scripts/fabrica.mjs estado | desplegar [--mainnet] [--confirmar]");
  process.exit(1);
}
