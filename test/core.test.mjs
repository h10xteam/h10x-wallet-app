// Pruebas unitarias del núcleo (sin red).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ContractId, KeyList, PrivateKey, ScheduleId } from "@hiero-ledger/sdk";
import {
  HBAR,
  buildVaultKey,
  decodeNotaryLog,
  describeScheduledBody,
  formatCountdown,
  formatDelay,
  formatHbar,
  isValidDestination,
  isVaultKeyFor,
  keyFingerprint,
  notaryInitcode,
  NOTARY_ARTIFACT,
  parseHbar,
  scheduleAddress,
  scheduleIdFromAddress,
  signRegistration,
  vaultDeviceKey,
  verifyRegistration,
} from "@boveda/core";

test("importes: formato y lectura en español", () => {
  assert.equal(formatHbar(0n), "0");
  assert.equal(formatHbar(123_456_789n), "1,2345");
  assert.equal(formatHbar(1_234_500_000_000n), "12.345");
  assert.equal(formatHbar(-HBAR / 2n), "-0,5");
  assert.equal(parseHbar("1,5"), 150_000_000n);
  assert.equal(parseHbar(" 2.25 "), 225_000_000n);
  assert.equal(parseHbar("0"), null);
  assert.equal(parseHbar("1,123456789"), null);
  assert.equal(parseHbar("abc"), null);
});

test("tiempos legibles", () => {
  assert.equal(formatCountdown(0), "ya");
  assert.equal(formatCountdown(45), "45 s");
  assert.equal(formatCountdown(125), "2 min 05 s");
  assert.equal(formatCountdown(3725), "1 h 02 min");
  assert.equal(formatCountdown(2 * 86400 + 3600), "2 d 1 h");
  assert.equal(formatDelay(120), "2 minutos");
  assert.equal(formatDelay(172800), "48 horas");
  assert.equal(formatDelay(3600), "1 hora");
});

test("destinos válidos", () => {
  assert.ok(isValidDestination("0.0.1234"));
  assert.ok(isValidDestination("0x" + "a".repeat(40)));
  assert.ok(!isValidDestination("0.0.x"));
  assert.ok(!isValidDestination("0x123"));
});

test("clave de la bóveda: forma, notario y dispositivo", () => {
  const device = PrivateKey.generateECDSA().publicKey;
  const rescue = PrivateKey.generateED25519().publicKey;
  const notary = new ContractId(777);
  const key = buildVaultKey({ devices: [device], notaryId: notary, rescue: [rescue] });
  assert.ok(key instanceof KeyList);
  assert.equal(keyFingerprint(key), `1[all[secp256k1:${device.toStringRaw()},contract:0.0.777],ED25519:${rescue.toStringRaw()}]`);
  assert.ok(isVaultKeyFor(key, notary));
  assert.ok(!isVaultKeyFor(key, new ContractId(778)));
  assert.ok(!isVaultKeyFor(device, notary));
  assert.equal(keyFingerprint(vaultDeviceKey(key)), keyFingerprint(device));
  const multi = buildVaultKey({ devices: [device, rescue], deviceThreshold: 1, notaryId: notary, rescue: [rescue, device], rescueThreshold: 2 });
  assert.match(keyFingerprint(multi), /^1\[all\[1\[.*\],contract:0\.0\.777\],2\[/);
  assert.throws(() => buildVaultKey({ devices: [], notaryId: notary, rescue: [rescue] }));
});

test("initcode del notario: bytecode + argumentos pegados", () => {
  const code = notaryInitcode({ quorum: "0x" + "1".repeat(40), vetoers: ["0x" + "2".repeat(40)], delaySeconds: 120 });
  const hex = Buffer.from(code).toString("hex");
  assert.ok(hex.startsWith(NOTARY_ARTIFACT.bytecode.slice(2)));
  assert.ok(hex.endsWith("2".repeat(40)));
  assert.equal(hex.length - (NOTARY_ARTIFACT.bytecode.length - 2), 64 * 5);
});

test("direcciones de transacciones programadas", () => {
  const id = new ScheduleId(11424223);
  assert.equal(scheduleAddress(id), "0x0000000000000000000000000000000000ae51df");
  assert.equal(scheduleIdFromAddress(scheduleAddress(id)).toString(), "0.0.11424223");
});

test("decodifica datos reales de testnet (prueba del 12/11/2026)", () => {
  assert.deepEqual(describeScheduledBody("CIDC1y9KHgocCgwKBRjco7kFEICEr18KDAoFGN6juQUQ/4OvXw=="), {
    kind: "transfer",
    from: "0.0.11424222",
    to: "0.0.11424220",
    tinybars: HBAR,
    tokens: [],
    nfts: [],
    fee: null,
    extra: [],
  });
  assert.deepEqual(
    decodeNotaryLog({
      topics: ["0x4a559439990691109183b4ff5601206c4f0afd91f61380896af5a62b318a0d79", "0x0000000000000000000000000000000000000000000000000000000000ae51df"],
      data: "0x000000000000000000000000000000000000000000000000000000006af59502000000000000000000000000000000000000000000000000000000006af5953e",
    }),
    { kind: "requested", schedule: "0x0000000000000000000000000000000000ae51df", requestedAt: 1794479362, executableAt: 1794479422 },
  );
  assert.equal(decodeNotaryLog({ topics: ["0x" + "0".repeat(64)], data: "0x" }), null);
});

test("registro en el guardián: firma del móvil", () => {
  const key = PrivateKey.generateECDSA();
  const fields = { vaultId: "0.0.1", notaryId: "0.0.2", pocketId: "0.0.3", pushToken: "ExponentPushToken[x]", timestamp: 1700000000 };
  const signed = signRegistration(key, fields);
  assert.ok(verifyRegistration(key.publicKey, signed));
  assert.ok(!verifyRegistration(key.publicKey, { ...signed, pushToken: "ExponentPushToken[otro]" }));
  assert.ok(!verifyRegistration(PrivateKey.generateECDSA().publicKey, signed));
  assert.ok(!verifyRegistration(key.publicKey, { ...signed, signature: "0x1234" }));
});

test("v2: la clave de la bóveda tiene sus tres rutas y se reconoce", async () => {
  const { ContractId, KeyList, PrivateKey } = await import("@hiero-ledger/sdk");
  const { buildVaultKeyV2, isVaultKeyV2For, notary2Initcode, revertName2, notary2Abi } = await import("@boveda/core");
  const device = PrivateKey.generateECDSA().publicKey;
  const rescue = PrivateKey.generateED25519().publicKey;
  const notaryId = ContractId.fromString("0.0.4242");
  const key = buildVaultKeyV2({ deviceKey: device, rescueKey: rescue, notaryId });
  assert.equal(key.threshold, 1);
  assert.equal(key.toArray().length, 3);
  assert.ok(isVaultKeyV2For(key, notaryId));
  assert.ok(!isVaultKeyV2For(key, ContractId.fromString("0.0.4243")), "otro notario");
  assert.ok(!isVaultKeyV2For(buildVaultKeyV2({ deviceKey: device, rescueKey: device, notaryId }), notaryId), "móvil y kit iguales");
  assert.ok(!isVaultKeyV2For(new KeyList([device, rescue], 1), notaryId));
  // Initcode con argumentos pegados y errores legibles.
  const init = notary2Initcode({ device: `0x${"12".repeat(20)}`, rescue: `0x${"34".repeat(20)}`, guardian: null, withdrawDelay: 30, recoveryDelay: 60 });
  assert.ok(init.length > 3900);
  assert.match(revertName2(notary2Abi.encodeErrorResult("NotRescue", [`0x${"34".repeat(20)}`])), /^NotRescue\(0x3434/i);
});

test("una clave v2 no se confunde con una v1 (ni al revés)", async () => {
  const { ContractId, PrivateKey } = await import("@hiero-ledger/sdk");
  const { buildVaultKey, buildVaultKeyV2, isVaultKeyFor, isVaultKeyV2For } = await import("@boveda/core");
  const device = PrivateKey.generateECDSA().publicKey;
  const rescue = PrivateKey.generateED25519().publicKey;
  const notaryId = ContractId.fromString("0.0.777");
  const v1 = buildVaultKey({ devices: [device], notaryId, rescue: [rescue] });
  const v2 = buildVaultKeyV2({ deviceKey: device, rescueKey: rescue, notaryId });
  assert.ok(isVaultKeyFor(v1, notaryId) && !isVaultKeyV2For(v1, notaryId));
  assert.ok(isVaultKeyV2For(v2, notaryId) && !isVaultKeyFor(v2, notaryId));
});

test("formatos en español e inglés", async () => {
  const { formatUnits, parseUnits, formatFiat, formatCountdown: fc, formatDelay: fd, setCoreLanguage, tr } = await import("@boveda/core");
  assert.equal(formatHbar(1_234_500_000_000n, 2, "en"), "12,345");
  assert.equal(formatHbar(123_456_789n, 4, "en"), "1.2345");
  assert.equal(formatUnits(1_500_000n, 6, 2, "es"), "1,5");
  assert.equal(formatUnits(7n, 0, 4, "en"), "7");
  assert.equal(parseUnits("1.000,5", 8), 100_050_000_000n);
  assert.equal(parseUnits("1,000.5", 8), 100_050_000_000n);
  assert.equal(parseUnits("2,5", 6), 2_500_000n);
  assert.equal(parseUnits("3", 0), 3n);
  assert.equal(parseUnits("0,1", 0), null);
  assert.equal(parseUnits("1.1234567", 6), null);
  assert.equal(fc(0, "en"), "now");
  assert.equal(fd(172800, "en"), "48 hours");
  assert.equal(fd(7 * 86400, "en"), "7 days");
  assert.equal(fd(60, "en"), "1 minute");
  assert.match(formatFiat(1234.5, "EUR", "es"), /^1\.?234,50\s?€$/);
  assert.match(formatFiat(12345.5, "EUR", "es"), /^12\.345,50\s?€$/);
  assert.match(formatFiat(1234.5, "USD", "en"), /^\$1,234\.50$/);
  setCoreLanguage("en");
  assert.equal(tr("hola", "hello"), "hello");
  assert.equal(formatCountdown(0), "now");
  setCoreLanguage("es");
  assert.equal(formatCountdown(0), "ya");
});

test("transferencia de la bóveda: comisión en la misma transacción y nunca por encima del tope", async () => {
  const { AccountId, TransferTransaction } = await import("@hiero-ledger/sdk");
  const { buildVaultTransfer, describeScheduledBody: describe, MAX_SERVICE_FEE_TINYBARS } = await import("@boveda/core");
  const { proto } = await import("@hiero-ledger/proto");
  const vaultId = AccountId.fromString("0.0.500");
  const to = AccountId.fromString("0.0.600");
  const collector = AccountId.fromString("0.0.700");
  const toBase64 = (/** @type {TransferTransaction} */ tx) => {
    const body = proto.SchedulableTransactionBody.create({ cryptoTransfer: tx._makeTransactionData() });
    return Buffer.from(proto.SchedulableTransactionBody.encode(body).finish()).toString("base64");
  };
  const tx = buildVaultTransfer({ vaultId, to, tinybars: 5n * HBAR, fee: { collector, tinybars: 2n * HBAR } });
  const legs = Object.fromEntries(tx._makeTransactionData().transfers.accountAmounts.map((x) => [`0.0.${x.accountID.accountNum}`, String(x.amount)]));
  assert.deepEqual(legs, { "0.0.500": String(-7n * HBAR), "0.0.600": String(5n * HBAR), "0.0.700": String(2n * HBAR) });
  const a = describe(toBase64(tx), "0.0.700");
  assert.deepEqual(a, { kind: "transfer", from: "0.0.500", to: "0.0.600", tinybars: 5n * HBAR, tokens: [], nfts: [], fee: { to: "0.0.700", tinybars: 2n * HBAR }, extra: [] });
  // Sin saber quién cobra, el abono extra no se esconde.
  const b = describe(toBase64(tx));
  assert.deepEqual(b.extra, [{ to: "0.0.700", tinybars: 2n * HBAR }]);
  // Token + comisión.
  const t = describe(toBase64(buildVaultTransfer({ vaultId, to, tokens: [{ tokenId: "0.0.42", amount: 9n, decimals: 0 }], fee: { collector, tinybars: 2n * HBAR } })), "0.0.700");
  assert.deepEqual(t, { kind: "transfer", from: "0.0.500", to: "0.0.600", tinybars: 0n, tokens: [{ tokenId: "0.0.42", amount: 9n }], nfts: [], fee: { to: "0.0.700", tinybars: 2n * HBAR }, extra: [] });
  assert.throws(() => buildVaultTransfer({ vaultId, to, tinybars: HBAR, fee: { collector, tinybars: MAX_SERVICE_FEE_TINYBARS + 1n } }), /demasiado alta/);
  assert.throws(() => buildVaultTransfer({ vaultId, to }), /nada que mover/);
});

test("registro en el guardián con idioma firmado (v2) y sin él (v1)", () => {
  const key = PrivateKey.generateECDSA();
  const base = { vaultId: "0.0.1", notaryId: "0.0.2", pocketId: "0.0.3", pushToken: null, timestamp: 1000 };
  const v2 = signRegistration(key, { ...base, lang: "en" });
  assert.ok(verifyRegistration(key.publicKey, v2));
  assert.ok(!verifyRegistration(key.publicKey, { ...v2, lang: "es" }), "cambiar el idioma invalida la firma");
  const v1 = signRegistration(key, base);
  assert.ok(verifyRegistration(key.publicKey, v1));
});

test("precios: CoinGecko y, si falla, tasa de Hedera + cambio del BCE", async () => {
  const { fetchPrices, fiatOf } = await import("@boveda/core");
  const reply = (body, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body });
  const gecko = async (url) => (String(url).includes("coingecko") ? reply({ "hedera-hashgraph": { usd: 0.2, eur: 0.18 } }) : reply({}, false));
  const p = await fetchPrices({ fetchImpl: gecko });
  assert.deepEqual(p.hbar, { usd: 0.2, eur: 0.18 });
  assert.equal(p.source, "coingecko");
  const fallback = async (url) => {
    const u = String(url);
    if (u.includes("coingecko")) return reply({}, false);
    if (u.includes("exchangerate")) return reply({ current_rate: { cent_equivalent: 600, hbar_equivalent: 30 } });
    if (u.includes("frankfurter")) return reply({ rates: { EUR: 0.9 } });
    return reply({}, false);
  };
  const q = await fetchPrices({ fetchImpl: fallback });
  assert.equal(q.hbar.usd, 0.2);
  assert.ok(Math.abs(q.hbar.eur - 0.18) < 1e-9);
  const withTokens = async (url, init) => {
    if (String(url).endsWith("/tokens")) {
      assert.equal(init.headers["x-api-key"], "clave");
      return reply([{ id: "0.0.42", priceUsd: 2 }, { id: "0.0.43", priceUsd: 0 }]);
    }
    return gecko(url);
  };
  const r = await fetchPrices({ fetchImpl: withTokens, saucerswapKey: "clave" });
  assert.deepEqual(Object.keys(r.tokens), ["0.0.42"]);
  assert.ok(Math.abs(r.tokens["0.0.42"].eur - 1.8) < 1e-9);
  assert.ok(Math.abs(fiatOf(150_000_000n, 8, 0.2) - 0.3) < 1e-12);
});
