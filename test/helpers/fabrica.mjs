// Compila la fábrica de notarios (experimental) con los mismos ajustes que el notario v3 de la app (IR, runs = 1), para
// que el notario que crea sea byte a byte el mismo que el de la app. Solo para pruebas: la app no la usa.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** @returns {{ factory: { abi: any[], bytecode: string, deployedBytecode: string }, notary3: { bytecode: string, deployedBytecode: string }, compiler: string }} */
export function compileFactory() {
  const solc = require("solc");
  const files = ["contracts/VaultNotary3.sol", "contracts/NotaryFactory3.sol"];
  const sources = Object.fromEntries(files.map((f) => [f, { content: readFileSync(join(root, f), "utf8") }]));
  const settings = {
    optimizer: { enabled: true, runs: 1 },
    viaIR: true,
    evmVersion: "cancun",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources, settings })));
  const errors = (out.errors ?? []).filter((e) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join("\n"));
  const f = out.contracts["contracts/NotaryFactory3.sol"].NotaryFactory3;
  const n = out.contracts["contracts/VaultNotary3.sol"].VaultNotary3;
  return {
    factory: { abi: f.abi, bytecode: `0x${f.evm.bytecode.object}`, deployedBytecode: `0x${f.evm.deployedBytecode.object}` },
    notary3: { bytecode: `0x${n.evm.bytecode.object}`, deployedBytecode: `0x${n.evm.deployedBytecode.object}` },
    compiler: solc.version(),
  };
}
