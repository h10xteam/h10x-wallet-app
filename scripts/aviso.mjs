#!/usr/bin/env node
// Aviso de emergencia para todas las bóvedas. Lo ejecuta el usuario hvault (desde root: «hvault-vps aviso …»).
//
//   node scripts/aviso.mjs ver
//   node scripts/aviso.mjs poner evacuar "Texto en español" "Text in English"
//   node scripts/aviso.mjs poner info "Texto en español" "Text in English"
//   node scripts/aviso.mjs quitar
//   … --mainnet   lo mismo para el guardián de mainnet (guardian/.env.mainnet, data-mainnet/)
//
// Escribe guardian/data/aviso.json (o el DATA_DIR de guardian/.env). El guardián lo lee en su siguiente vuelta
// (≈ 10 s), lo manda UNA vez a todas las bóvedas por push (y por correo si es «evacuar») y la app lo enseña arriba
// en Inicio mientras siga puesto. El texto se limpia: sin enlaces, cuentas ni direcciones (core/src/notice.js).
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanNotice, readNoticeFile } from "../core/src/notice.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GUARDIAN = process.env.HVAULT_GUARDIAN_DIR ? resolve(process.env.HVAULT_GUARDIAN_DIR) : join(ROOT, "guardian");

const args = process.argv.slice(2);
/** --mainnet: el aviso es para el guardián de mainnet. */
const MAINNET = args.includes("--mainnet");

/** DATA_DIR del guardián: el de su .env si lo cambia (solo se lee esa línea; nada más del .env). */
function dataDir() {
  const envFile = join(GUARDIAN, MAINNET ? ".env.mainnet" : ".env");
  let dir = MAINNET ? "data-mainnet" : "data";
  if (existsSync(envFile)) {
    const line = readFileSync(envFile, "utf8")
      .split("\n")
      .find((l) => /^\s*DATA_DIR\s*=/.test(l));
    if (line) dir = line.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "") || dir;
  }
  return resolve(GUARDIAN, dir);
}

const file = join(dataDir(), "aviso.json");
const [cmd, level, es, en] = args.filter((a) => a !== "--mainnet");
if (MAINNET) console.log("Guardián de MAINNET");

function show(n) {
  if (!n) return console.log("Sin aviso puesto.");
  console.log(`Aviso «${n.id}» · nivel ${n.level} · desde ${n.at ? new Date(n.at * 1000).toISOString() : "?"}`);
  console.log(`  ES: ${n.es}`);
  console.log(`  EN: ${n.en}`);
}

if (cmd === "ver" || !cmd) {
  show(existsSync(file) ? readNoticeFile((f) => readFileSync(f, "utf8"), file) : null);
} else if (cmd === "quitar") {
  rmSync(file, { force: true });
  console.log("✅ Aviso quitado. La app deja de enseñarlo en su siguiente comprobación (≈ 1 min).");
} else if (cmd === "poner") {
  if (level !== "evacuar" && level !== "info") {
    console.error('Uso: poner evacuar|info "Texto en español" "Text in English"');
    process.exit(1);
  }
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 12);
  const notice = cleanNotice({ id: `${level}-${stamp}`, level, es: es ?? "", en: en ?? "", at: Math.floor(now.getTime() / 1000) });
  if (!notice) {
    console.error("⛔ El aviso no vale: hace falta al menos un texto.");
    process.exit(1);
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(notice, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  console.log("✅ Aviso puesto. Así lo verán (enlaces, cuentas y direcciones se ocultan):");
  show(notice);
  console.log("El guardián lo manda a todas las bóvedas en su siguiente vuelta (≈ 10 s). Para quitarlo: quitar.");
} else {
  console.error('Uso: ver | poner evacuar|info "Texto ES" "Text EN" | quitar');
  process.exit(1);
}
