// Compila el notario con solc-js y genera core/src/artifact.js (y el doble del Schedule Service para pruebas).
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const solc = require("solc");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = ["contracts/VaultNotary.sol", "contracts/VaultNotary2.sol", "contracts/VaultNotary3.sol", "contracts/test/MockHSS.sol", "contracts/test/RogueCaller.sol"];
const sources = Object.fromEntries(files.map((f) => [f, { content: readFileSync(join(root, f), "utf8") }]));
const settings = {
  optimizer: { enabled: true, runs: 200 },
  evmVersion: "cancun",
  outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
};
const out = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources, settings })));
for (const e of out.errors ?? []) console.error(e.formattedMessage);
if ((out.errors ?? []).some((e) => e.severity === "error")) process.exit(1);

const notary = out.contracts["contracts/VaultNotary.sol"].VaultNotary;
const artifact = {
  compiler: solc.version(),
  sourceSha256: createHash("sha256").update(sources["contracts/VaultNotary.sol"].content).digest("hex"),
  abi: notary.abi,
  bytecode: `0x${notary.evm.bytecode.object}`,
};
writeFileSync(
  join(root, "core/src/artifact.js"),
  `// Generado por scripts/compile.mjs a partir de contracts/VaultNotary.sol. No editar a mano.\n` +
    `export const NOTARY_ARTIFACT = ${JSON.stringify(artifact, null, 2)};\n`,
);
const mock = out.contracts["contracts/test/MockHSS.sol"].MockHSS;
mkdirSync(join(root, "test/build"), { recursive: true });
writeFileSync(
  join(root, "test/build/MockHSS.json"),
  JSON.stringify({ abi: mock.abi, deployedBytecode: `0x${mock.evm.deployedBytecode.object}` }, null, 2),
);
writeFileSync(
  join(root, "test/build/VaultNotary.json"),
  JSON.stringify({ abi: notary.abi, bytecode: artifact.bytecode, deployedBytecode: `0x${notary.evm.deployedBytecode.object}` }, null, 2),
);
console.log(`VaultNotary: ${(notary.evm.deployedBytecode.object.length) / 2} bytes (${artifact.compiler})`);

// ---- notario v2 (dos carriles) y contrato trampa de las pruebas de ataque ----------------------
const notary2 = out.contracts["contracts/VaultNotary2.sol"].VaultNotary2;
const artifact2 = {
  compiler: solc.version(),
  sourceSha256: createHash("sha256").update(sources["contracts/VaultNotary2.sol"].content).digest("hex"),
  abi: notary2.abi,
  bytecode: `0x${notary2.evm.bytecode.object}`,
};
writeFileSync(
  join(root, "core/src/artifact2.js"),
  `// Generado por scripts/compile.mjs a partir de contracts/VaultNotary2.sol. No editar a mano.\n` +
    `export const NOTARY2_ARTIFACT = ${JSON.stringify(artifact2, null, 2)};\n`,
);
writeFileSync(
  join(root, "test/build/VaultNotary2.json"),
  JSON.stringify({ abi: notary2.abi, bytecode: artifact2.bytecode, deployedBytecode: `0x${notary2.evm.deployedBytecode.object}` }, null, 2),
);
const rogue = out.contracts["contracts/test/RogueCaller.sol"].RogueCaller;
writeFileSync(
  join(root, "test/build/RogueCaller.json"),
  JSON.stringify({ abi: rogue.abi, bytecode: `0x${rogue.evm.bytecode.object}`, deployedBytecode: `0x${rogue.evm.deployedBytecode.object}` }, null, 2),
);
console.log(`VaultNotary2: ${notary2.evm.deployedBytecode.object.length / 2} bytes · RogueCaller: ${rogue.evm.deployedBytecode.object.length / 2} bytes`);

// ---- notario v3 (v2 + contraseña de desempate) ---------------------------------------------------
// El v3 se compila con el optimizador IR y runs = 1: así su código cabe en una sola transacción de
// Hedera (máximo 6 KB). Con la configuración del v2 ocupa 6,8 KB y habría que subirlo como archivo,
// que en testnet costó unos 21 HBAR más por bóveda.
// La fábrica (contracts/NotaryFactory3.sol) se compila en la misma pasada y con los mismos ajustes: el notario que crea
// es así byte a byte el mismo que el de la app.
const settings3 = {
  ...settings,
  viaIR: true,
  optimizer: { enabled: true, runs: 1 },
  outputSelection: { "*": { "": ["ast"], "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "evm.deployedBytecode.immutableReferences"] } },
};
const factorySource = readFileSync(join(root, "contracts/NotaryFactory3.sol"), "utf8");
const out3 = JSON.parse(
  solc.compile(
    JSON.stringify({
      language: "Solidity",
      sources: { "contracts/VaultNotary3.sol": sources["contracts/VaultNotary3.sol"], "contracts/NotaryFactory3.sol": { content: factorySource } },
      settings: settings3,
    }),
  ),
);
for (const e of out3.errors ?? []) console.error(e.formattedMessage);
if ((out3.errors ?? []).some((e) => e.severity === "error")) process.exit(1);
const notary3 = out3.contracts["contracts/VaultNotary3.sol"].VaultNotary3;
// Dónde guarda el código en ejecución cada dato fijo (immutable) del notario, por nombre: con esto la app reconstruye el
// código exacto que debe tener un notario con unos datos y lo compara byte a byte con el que hay en la red.
/** @type {Record<number, string>} */
const immutableNames = {};
(function walk(node) {
  if (!node || typeof node !== "object") return;
  if (node.nodeType === "VariableDeclaration" && node.mutability === "immutable") immutableNames[node.id] = node.name;
  for (const v of Object.values(node)) if (v && typeof v === "object") walk(v);
})(out3.sources["contracts/VaultNotary3.sol"].ast);
/** @type {Record<string, { start: number, length: number }[]>} */
const immutables = {};
for (const [id, refs] of Object.entries(notary3.evm.deployedBytecode.immutableReferences ?? {})) {
  const name = immutableNames[Number(id)];
  if (!name) throw new Error(`immutable sin nombre: ${id}`);
  immutables[name] = refs.map((/** @type {{ start: number, length: number }} */ r) => ({ start: r.start, length: r.length }));
}
for (const name of ["device", "rescue", "guardian", "tiebreaker", "withdrawDelay", "recoveryDelay"]) {
  if (!immutables[name]?.length) throw new Error(`falta el immutable ${name}`);
}
const artifact3 = {
  compiler: solc.version(),
  sourceSha256: createHash("sha256").update(sources["contracts/VaultNotary3.sol"].content).digest("hex"),
  abi: notary3.abi,
  bytecode: `0x${notary3.evm.bytecode.object}`,
  deployedBytecode: `0x${notary3.evm.deployedBytecode.object}`,
  immutables,
};
writeFileSync(
  join(root, "core/src/artifact3.js"),
  `// Generado por scripts/compile.mjs a partir de contracts/VaultNotary3.sol. No editar a mano.\n` +
    `export const NOTARY3_ARTIFACT = ${JSON.stringify(artifact3, null, 2)};\n`,
);
writeFileSync(
  join(root, "test/build/VaultNotary3.json"),
  JSON.stringify({ abi: notary3.abi, bytecode: artifact3.bytecode, deployedBytecode: `0x${notary3.evm.deployedBytecode.object}` }, null, 2),
);
console.log(`VaultNotary3: ${notary3.evm.deployedBytecode.object.length / 2} bytes (initcode ${notary3.evm.bytecode.object.length / 2}, IR, runs 1)`);

// ---- fábrica de notarios v3 ------------------------------------------------------------------------------------
// La app solo lleva su ABI y la huella (keccak-256) de su código en ejecución: con ella comprueba que la fábrica que le
// anuncian es exactamente esta. El código para desplegarla (initcode) va aparte, en scripts/build, para el VPS.
const factory = out3.contracts["contracts/NotaryFactory3.sol"].NotaryFactory3;
const { keccak256 } = await import("ethers");
const factoryArtifact = {
  compiler: solc.version(),
  sourceSha256: createHash("sha256").update(factorySource).digest("hex"),
  abi: factory.abi,
  runtimeKeccak: keccak256(`0x${factory.evm.deployedBytecode.object}`),
};
writeFileSync(
  join(root, "core/src/artifact-factory3.js"),
  `// Generado por scripts/compile.mjs a partir de contracts/NotaryFactory3.sol. No editar a mano.\n` +
    `export const FACTORY3_ARTIFACT = ${JSON.stringify(factoryArtifact, null, 2)};\n`,
);
mkdirSync(join(root, "scripts/build"), { recursive: true });
writeFileSync(
  join(root, "scripts/build/NotaryFactory3.json"),
  JSON.stringify({ ...factoryArtifact, bytecode: `0x${factory.evm.bytecode.object}`, deployedBytecode: `0x${factory.evm.deployedBytecode.object}` }, null, 2) + "\n",
);
console.log(`NotaryFactory3: ${factory.evm.deployedBytecode.object.length / 2} bytes (initcode ${factory.evm.bytecode.object.length / 2}) · huella ${factoryArtifact.runtimeKeccak}`);
