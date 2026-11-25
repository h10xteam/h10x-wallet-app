// Ensayo de test/ataques-testnet.mjs contra la red simulada, para no gastar HBAR en balde.
//   npm run ensayo:ataques
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AccountId, PrivateKey } from "@hiero-ledger/sdk";
import { startFakeNetwork } from "./fake-network.mjs";

const opKey = PrivateKey.generateED25519();
const net = await startFakeNetwork({ operatorNum: 1001, operatorKey: opKey.publicKey });
const work = mkdtempSync(join(tmpdir(), "ataques-"));
const script = fileURLToPath(new URL("../ataques-testnet.mjs", import.meta.url));
const child = spawn(process.execPath, [script], {
  cwd: work,
  env: {
    ...process.env,
    HEDERA_NETWORK: "local",
    MIRROR_URL: "http://127.0.0.1:5551",
    OPERATOR_KEY: opKey.toStringDer(),
    OPERATOR_ID: new AccountId(1001).toString(),
    ATAQUE_RETIRADA: process.env.ATAQUE_RETIRADA ?? "4",
    ATAQUE_RECUPERACION: process.env.ATAQUE_RECUPERACION ?? "8",
  },
  stdio: "inherit",
});
const code = await new Promise((r) => child.on("exit", r));
try {
  console.log(`\n(informe del ensayo: ${readFileSync(join(work, "informe-ataques.md"), "utf8").split("\n").length} líneas)`);
} catch {
  console.log("\n(el ensayo no llegó a escribir el informe)");
}
net.stop();
rmSync(work, { recursive: true, force: true });
process.exit(code ?? 1);
