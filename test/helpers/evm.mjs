// EVM local mínima para probar el notario sin red: @ethereumjs/vm + un doble del Schedule Service en 0x16b.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createVM } from "@ethereumjs/vm";
import { Common, Hardfork, Mainnet } from "@ethereumjs/common";
import { createBlock } from "@ethereumjs/block";
import { Account, bytesToHex, createAddressFromString, hexToBytes } from "@ethereumjs/util";
import { Interface } from "ethers";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const artifact = (name) => JSON.parse(readFileSync(join(root, "build", `${name}.json`), "utf8"));

export const HSS = "0x000000000000000000000000000000000000016b";
export const notaryArtifact = artifact("VaultNotary");
export const mockArtifact = artifact("MockHSS");
export const notaryAbi = new Interface(notaryArtifact.abi);
export const mockAbi = new Interface(mockArtifact.abi);
export const notary2Artifact = artifact("VaultNotary2");
export const notary2Abi = new Interface(notary2Artifact.abi);
export const notary3Artifact = artifact("VaultNotary3");
export const notary3Abi = new Interface(notary3Artifact.abi);
export const rogueArtifact = artifact("RogueCaller");
export const rogueAbi = new Interface(rogueArtifact.abi);

const addr = (hex) => createAddressFromString(hex);

export class LocalChain {
  static async create() {
    const common = new Common({ chain: Mainnet, hardfork: Hardfork.Cancun });
    const vm = await createVM({ common });
    const chain = new LocalChain(vm, common);
    // El doble ocupa la dirección del contrato de sistema, igual que el real en Hedera.
    await vm.stateManager.putCode(addr(HSS), hexToBytes(mockArtifact.deployedBytecode));
    return chain;
  }

  constructor(vm, common) {
    this.vm = vm;
    this.common = common;
    this.now = 1_800_000_000n; // "tiempo de consenso" simulado, en segundos
  }

  advance(seconds) {
    this.now += BigInt(seconds);
  }

  /** @param {{ from: string, to?: string, data: `0x${string}`, isStatic?: boolean }} opts */
  async #run({ from, to, data, isStatic = false }) {
    const block = createBlock(
      { header: { timestamp: this.now, number: 1n, gasLimit: 30_000_000n } },
      { common: this.common },
    );
    const res = await this.vm.evm.runCall({
      caller: addr(from),
      origin: addr(from),
      to: to ? addr(to) : undefined,
      data: hexToBytes(data),
      gasLimit: 10_000_000n,
      block,
      isStatic,
    });
    return {
      ok: res.execResult.exceptionError === undefined,
      returnData: bytesToHex(res.execResult.returnValue),
      gasUsed: res.execResult.executionGasUsed,
      logs: res.execResult.logs ?? [],
      createdAddress: res.createdAddress ? res.createdAddress.toString() : undefined,
    };
  }

  /**
   * Despliega en una dirección fija, como hace Hedera con ContractCreate (la long-zero del ContractID):
   * dentro del contrato, `address(this)` es esa dirección.
   * @param {{ from: string, at: string, data: string }} opts
   */
  async deployAt({ from, at, data }) {
    const where = addr(at);
    await this.vm.stateManager.putAccount(where, new Account());
    const block = createBlock({ header: { timestamp: this.now, number: 1n, gasLimit: 30_000_000n } }, { common: this.common });
    const res = await this.vm.evm.runCode({ code: hexToBytes(/** @type {`0x${string}`} */ (data)), data: new Uint8Array(), to: where, caller: addr(from), origin: addr(from), gasLimit: 10_000_000n, block });
    const ok = res.exceptionError === undefined;
    if (ok) await this.vm.stateManager.putCode(where, res.returnValue);
    else await this.vm.stateManager.deleteAccount(where);
    return { ok, returnData: bytesToHex(res.returnValue), gasUsed: res.executionGasUsed, logs: res.logs ?? [], createdAddress: ok ? at.toLowerCase() : undefined };
  }

  /**
   * Llamada o creación con datos ya codificados (lo usan el nodo simulado y la simulación previa al despliegue).
   * @param {{ from: string, to?: string, data: string, isStatic?: boolean }} opts
   */
  raw(opts) {
    if (!opts.data.startsWith("0x")) throw new Error("data debe empezar por 0x");
    return this.#run({ ...opts, data: /** @type {`0x${string}`} */ (opts.data) });
  }

  async deploy(art, abi, args, from) {
    const data = art.bytecode + abi.encodeDeploy(args).slice(2);
    return this.#run({ from, data });
  }

  /** Llama a una función que cambia estado. Devuelve { ok, error?, gasUsed, events }. */
  async send(abi, to, from, fn, args = []) {
    const res = await this.#run({ from, to, data: abi.encodeFunctionData(fn, args) });
    /** @type {{ ok: boolean, gasUsed: bigint, events: { name: string, args: any }[], error: { name: string, args: any } | undefined }} */
    const out = { ok: res.ok, gasUsed: res.gasUsed, events: [], error: undefined };
    if (res.ok) {
      for (const [, topics, data] of res.logs) {
        const parsed = abi.parseLog({ topics: topics.map(bytesToHex), data: bytesToHex(data) });
        if (parsed) out.events.push({ name: parsed.name, args: parsed.args });
      }
    } else {
      const parsed = res.returnData.length >= 10 ? abi.parseError(res.returnData) : null;
      out.error = parsed ? { name: parsed.name, args: parsed.args } : { name: "<sin datos>", args: [] };
    }
    return out;
  }

  /** Lee una función view. */
  async read(abi, to, fn, args = []) {
    const res = await this.#run({
      from: "0x00000000000000000000000000000000000000aa",
      to,
      data: abi.encodeFunctionData(fn, args),
      isStatic: true,
    });
    if (!res.ok) throw new Error(`read ${fn} falló`);
    return abi.decodeFunctionResult(fn, res.returnData);
  }
}
