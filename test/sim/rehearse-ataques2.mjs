// Ensayo de test/ataques-testnet2.mjs contra la red simulada, con el guardián de verdad.
//   npm run ensayo:ataques2
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AccountCreateTransaction, AccountId, Hbar, PrivateKey } from "@hiero-ledger/sdk";
import { createClient, submit } from "@boveda/core";
import { startFakeNetwork } from "./fake-network.mjs";

const opKey = PrivateKey.generateED25519();
const guardianKey = PrivateKey.generateED25519();
const net = await startFakeNetwork({ operatorNum: 1001, operatorKey: opKey.publicKey });
const op = createClient("local", { accountId: new AccountId(1001), key: opKey });
const g = await submit(op, new AccountCreateTransaction().setKeyWithoutAlias(guardianKey.publicKey).setInitialBalance(new Hbar(100)));
op.close();
const root = fileURLToPath(new URL("../../", import.meta.url));
const gdir = mkdtempSync(join(tmpdir(), "ensayo2-guardian-"));
const port = 18797;
const guardian = spawn(process.execPath, [join(root, "guardian/src/index.js")], {
  env: { ...process.env, HEDERA_NETWORK: "local", MIRROR_URL: "http://127.0.0.1:5551", OPERATOR_KEY: guardianKey.toStringDer(), OPERATOR_ID: g.receipt.accountId.toString(), PORT: String(port), DATA_DIR: gdir, POLL_SECONDS: "3" },
  stdio: ["ignore", "pipe", "pipe"],
});
let glog = "";
guardian.stdout.on("data", (d) => (glog += d));
guardian.stderr.on("data", (d) => (glog += d));
for (let i = 0; i < 40; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
  } catch {
    await new Promise((r) => setTimeout(r, 300));
  }
}
const work = mkdtempSync(join(tmpdir(), "ensayo2-"));
const child = spawn(process.execPath, [join(root, "test/ataques-testnet2.mjs")], {
  cwd: work,
  env: { ...process.env, HEDERA_NETWORK: "local", MIRROR_URL: "http://127.0.0.1:5551", OPERATOR_KEY: opKey.toStringDer(), OPERATOR_ID: "0.0.1001", GUARDIAN_URL: `http://127.0.0.1:${port}`, ATAQUE_RETIRADA: process.env.ATAQUE_RETIRADA ?? "8" },
  stdio: "inherit",
});
const code = await new Promise((r) => child.on("exit", r));
try {
  console.log(`\n${readFileSync(join(work, "informe-ataques2.md"), "utf8")}`);
} catch {
  console.log("\n(el ensayo no llegó a escribir el informe)");
}
if (process.env.SHOW_GUARDIAN_LOG) console.log(glog);
guardian.kill("SIGTERM");
net.stop();
rmSync(work, { recursive: true, force: true });
rmSync(gdir, { recursive: true, force: true });
process.exit(code ?? 1);
