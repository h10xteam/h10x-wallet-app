// Avisos de H10X con el guardián real (proceso aparte), SIN red: nodo y mirror de testnet simulados para el guardián
// y un mirror de MAINNET simulado (HTTP local) con el topic de la DAO y los eventos de la bóveda de H10X.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AccountCreateTransaction, AccountId, Hbar, PrivateKey } from "@hiero-ledger/sdk";
import { H10X_MAINNET, createClient, submit } from "@boveda/core";
import { startFakeNetwork } from "./sim/fake-network.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GUARDIAN_PORT = 18792;
const MAINNET_PORT = 18793;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");

// Mirror de mainnet simulado
const messages = [];
const logs = [{ topics: ["0x76da6cf8b40dd2b2c223a5956831e0ff4e75522538a86782108a0bbe1577e298", "0x0000000000000000000000000000000000000000000000000000000000163b5a"], timestamp: "1791292795.640834104" }];
const mainnet = createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const send = (o) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(o));
  };
  if (u.pathname === `/api/v1/topics/${H10X_MAINNET.daoTopic}/messages`) {
    const gt = Number((u.searchParams.get("sequencenumber") || "gt:0").split(":")[1]);
    return send({ messages: messages.filter((m) => m.sequence_number > gt), links: { next: null } });
  }
  if (u.pathname === `/api/v1/contracts/${H10X_MAINNET.vaultId}/results/logs`) {
    if (u.searchParams.get("order") === "desc") return send({ logs: logs.slice(-1), links: { next: null } });
    const ts = Number((u.searchParams.get("timestamp") || "gt:0").split(":")[1]);
    return send({ logs: logs.filter((l) => Number(l.timestamp) > ts), links: { next: null } });
  }
  if (u.pathname.startsWith("/api/v1/tokens/")) return send({ symbol: "STEAM" });
  res.writeHead(404);
  res.end("{}");
});

let net;
let guardian;
let guardianLog = "";
let dataDir;

before(async () => {
  await new Promise((r) => mainnet.listen(MAINNET_PORT, "127.0.0.1", r));
  const operatorKey = PrivateKey.generateED25519();
  const guardianKey = PrivateKey.generateED25519();
  net = await startFakeNetwork({ operatorNum: 1001, operatorKey: operatorKey.publicKey });
  const op = createClient("local", { accountId: new AccountId(1001), key: operatorKey });
  const created = await submit(op, new AccountCreateTransaction().setKeyWithoutAlias(guardianKey.publicKey).setInitialBalance(new Hbar(50)));
  op.close();
  dataDir = mkdtempSync(join(tmpdir(), "guardian-h10x-"));
  guardian = spawn(process.execPath, ["guardian/src/index.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      HEDERA_NETWORK: "local",
      MIRROR_URL: "http://127.0.0.1:5551",
      OPERATOR_KEY: guardianKey.toStringDer(),
      OPERATOR_ID: created.receipt.accountId.toString(),
      PORT: String(GUARDIAN_PORT),
      DATA_DIR: dataDir,
      POLL_SECONDS: "2",
      H10X_ALERTS: "1",
      H10X_MIRROR_URL: `http://127.0.0.1:${MAINNET_PORT}`,
      H10X_POLL_SECONDS: "5",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  guardian.stdout.on("data", (d) => (guardianLog += d));
  guardian.stderr.on("data", (d) => (guardianLog += d));
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${GUARDIAN_PORT}/health`)).ok) break;
    } catch {
      // arrancando
    }
    if (i > 60) throw new Error(`el guardián no arranca\n${guardianLog}`);
    await sleep(500);
  }
});

after(() => {
  guardian?.kill("SIGTERM");
  net?.stop();
  mainnet.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

const stateFile = () => {
  try {
    return JSON.parse(readFileSync(join(dataDir, "state.json"), "utf8"));
  } catch {
    return {};
  }
};
async function until(what, fn, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`tiempo agotado: ${what}\n${guardianLog}`);
    await sleep(500);
  }
}

test("el guardián lee la DAO y la cesta de H10X en mainnet y avisa (sin avisar de lo pasado)", async () => {
  // Primera vuelta: toma nota del último evento de la bóveda y no avisa de nada
  await until("primera lectura de H10X", () => stateFile().h10x?.init === true);
  assert.equal(stateFile().h10x.logTs, "1791292795.640834104");
  assert.doesNotMatch(guardianLog, /aviso de H10X/);

  // Ronda nueva publicada por la cuenta oficial
  const now = Math.floor(Date.now() / 1000);
  messages.push({
    sequence_number: 1,
    consensus_timestamp: `${now}.000000001`,
    payer_account_id: H10X_MAINNET.daoOps,
    message: b64({ v: 1, type: "round", round: "2027Q1", proposeEnd: now + 3600, voteStart: now + 7200, voteEnd: now + 7 * 86400 + 7200, slots: 2 }),
  });
  await until("aviso de ronda nueva", () => /aviso de H10X \(dao-open 2027Q1\) → 0 bóvedas/.test(guardianLog));
  assert.equal(stateFile().h10x.topicSeq, 1);

  // La cesta cambia: entra un token
  logs.push({ topics: ["0x76da6cf8b40dd2b2c223a5956831e0ff4e75522538a86782108a0bbe1577e298", "0x000000000000000000000000000000000000000000000000000000000030fb8b"], timestamp: `${now}.5` });
  await until("aviso de cesta", () => /aviso de H10X \(basket\) → 0 bóvedas/.test(guardianLog));
  assert.ok((await fetch(`http://127.0.0.1:${GUARDIAN_PORT}/health`)).ok, "el guardián sigue bien");
});
