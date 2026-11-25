// Ensayo de test/testnet-tokens.mjs contra la red simulada y el guardián real, para no gastar HBAR en balde.
//   npm run ensayo:tokens
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountCreateTransaction, AccountId, Hbar, PrivateKey } from "@hiero-ledger/sdk";
import { createClient, submit } from "@boveda/core";
import { startFakeNetwork } from "./fake-network.mjs";

const opKey = PrivateKey.generateED25519();
const net = await startFakeNetwork({ operatorNum: 1001, operatorKey: opKey.publicKey });
const op = createClient("local", { accountId: new AccountId(1001), key: opKey });
const gKey = PrivateKey.generateED25519();
const g = await submit(op, new AccountCreateTransaction().setKeyWithoutAlias(gKey.publicKey).setInitialBalance(new Hbar(60)));
op.close();
const dataDir = mkdtempSync(join(tmpdir(), "guardian-"));
const common = { ...process.env, HEDERA_NETWORK: "local", MIRROR_URL: "http://127.0.0.1:5551" };
const guardian = spawn(process.execPath, ["guardian/src/index.js"], {
  env: { ...common, OPERATOR_KEY: gKey.toStringDer(), OPERATOR_ID: g.receipt.accountId.toString(), PORT: "18791", DATA_DIR: dataDir, POLL_SECONDS: "3" },
  stdio: "ignore",
});
await new Promise((r) => setTimeout(r, 1500));
// Como en el VPS: paga la misma cuenta que usa el guardián.
const e2e = spawn(process.execPath, ["test/testnet-tokens.mjs"], {
  env: { ...common, OPERATOR_KEY: gKey.toStringDer(), OPERATOR_ID: g.receipt.accountId.toString(), GUARDIAN_URL: "http://127.0.0.1:18791", DELAY_SECONDS: "5", RECOVERY_SECONDS: "8" },
  stdio: "inherit",
});
const code = await new Promise((r) => e2e.on("exit", r));
guardian.kill("SIGTERM");
net.stop();
rmSync(dataDir, { recursive: true, force: true });
process.exit(code ?? 1);
