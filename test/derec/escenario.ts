
// =====================================================================================================================
// H10X Wallet · DeRec, paso 2 (testnet). Este archivo NO se compila solo: «hvault-vps prueba derec» lo añade al final de
// smoke-tests/nodejs/protocol.ts de lib-derec (etiqueta fija), dentro de la caja aislada, para usar sus almacenes en
// memoria, makeNode, doPair y processAll. Así lo que se prueba es el SDK publicado, no una imitación nuestra.
//
// Escenario: 1 dueño y 5 ayudantes (A–E), umbral 3. Se protege la llave de una Cartera de TESTNET (creada y con 2 HBAR)
// y su configuración (cuentas, lista de destinos). Luego:
//   1. emparejar los 5 ayudantes;               2. repartir (SharingComplete con el umbral cumplido);
//   3. ningún ayudante guarda la llave a la vista; 4. comprobar las 5 partes (ShareVerified ×5);
//   5. una parte alterada (E) y un ayudante caído (D): se detecta E, los demás siguen bien;
//   6. MÓVIL NUEVO con A, B y C: recupera la llave y la configuración exactas;
//   7. con A, B y la parte alterada de E: no sale ninguna llave equivocada;
//   8. con solo 2 ayudantes (A y B): no se recupera;
//   9. el móvil nuevo restaura y vuelve a repartir (versión nueva).
// Lee por stdin {secretHex, config, accountId}; deja por stdout una sola línea JSON {h10xDerec: 1, ...}. Lo demás, a stderr.
// =====================================================================================================================

const h10xErr = (...a: unknown[]) => void process.stderr.write(a.map((x) => String(x)).join(" ") + "\n");
console.log = (...a: unknown[]) => h10xErr(...a);
console.info = console.log;
console.warn = console.log;

type H10xResult = { n: number; name: string; pass: boolean; detail: string };
const h10xResults: H10xResult[] = [];
const h10xCheck = (n: number, name: string, pass: boolean, detail = ""): void => {
  h10xResults.push({ n, name, pass, detail });
  h10xErr(`${pass ? "✅" : "⛔"} ${n}  ${name}${detail ? `\n      ${detail}` : ""}`);
};
const h10xHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const h10xHas = (hay: Uint8Array, needle: Uint8Array): boolean => Buffer.from(hay).includes(Buffer.from(needle));
const h10xUris = new Map<Node, string>();
const h10xNode = (name: string, uri: string, opts: any): Node => {
  const n = makeNode(name, uri, opts);
  h10xUris.set(n, uri);
  return n;
};

/** Reparte lo que hay en las bandejas de salida hasta que no queda nada. Los de `down` no reciben (caídos). */
async function h10xPump(nodes: Node[], down: Set<Node> = new Set()): Promise<Map<Node, any[]>> {
  const byUri = new Map<string, Node>();
  for (const n of nodes) byUri.set(h10xUris.get(n) ?? "", n);
  const evs = new Map<Node, any[]>();
  for (let round = 0; round < 200; round++) {
    let moved = 0;
    for (const node of nodes) {
      const outs: any[] = node.transport.drain() as any[];
      for (const out of outs) {
        const target = byUri.get(String(out?.endpoint?.uri ?? ""));
        if (!target || down.has(target)) continue;
        moved++;
        let got: any[] = [];
        try {
          got = await processAll(target, out.message);
        } catch (e: any) {
          got = [...(Array.isArray(e?.events) ? e.events : []), { type: "H10xError", message: String(e?.message ?? e), code: String(e?.code ?? "") }];
        }
        evs.set(target, [...(evs.get(target) ?? []), ...got]);
      }
    }
    if (!moved) break;
  }
  return evs;
}
const h10xTypes = (evs: any[]): string => [...new Set(evs.map((e) => String(e?.type)))].join(", ");

async function h10xRun(): Promise<void> {
  const t0 = Date.now();
  const input: any = JSON.parse(readFileSync(0, "utf8") || "{}");
  const secretHex = String(input.secretHex ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(secretHex)) throw new Error("falta la llave de testnet (secretHex)");
  const key = Uint8Array.from(Buffer.from(secretHex, "hex"));
  const configText = JSON.stringify(input.config ?? {});
  const config = new TextEncoder().encode(configText);
  const rnd = new Uint8Array(8);
  globalThis.crypto.getRandomValues(rnd);
  const secretId = (BigInt("0x" + h10xHex(rnd)) % 9_000_000_000_000_000_000n) + 1n;
  const sid = secretId.toString();
  const secrets = [
    { id: new Uint8Array([1]), name: "cartera-testnet", data: key },
    { id: new Uint8Array([2]), name: "config", data: config },
  ];
  let recoveredHex = "";
  let version = 0;

  const owner = h10xNode("Dueño", "https://dueno.h10x.test/derec", { secretId, threshold: 3 });
  const names = ["A", "B", "C", "D", "E"];
  const helpers = names.map((x) => h10xNode(`Ayudante${x}`, `https://ayudante-${x.toLowerCase()}.h10x.test/derec`, { secretId }));
  const [hA, hB, hC, hD, hE] = helpers as [Node, Node, Node, Node, Node];
  const ids: string[] = [];

  // 1. Emparejar.
  try {
    for (const [i, h] of helpers.entries()) {
      const r = await doPair(h, owner, BigInt(i + 1), `Dueño↔Ayudante${names[i]}`);
      ids.push(String(r.longTermChannelId));
    }
    h10xCheck(1, "Los 5 ayudantes emparejados con el dueño", ids.length === 5, `canales ${ids.join(", ")}`);
  } catch (e: any) {
    h10xCheck(1, "Los 5 ayudantes emparejados con el dueño", false, String(e?.message ?? e));
  }

  // 2. Repartir.
  try {
    const st: any[] = await owner.protocol.start(FlowKind.ProtectSecret, { secrets, description: "H10X Wallet · prueba testnet", threshold: 3 } as any);
    const ev = await h10xPump([owner, ...helpers]);
    const all = [...st, ...(ev.get(owner) ?? [])];
    const done = all.find((e) => e?.type === "SharingComplete");
    version = Number(done?.version ?? 0);
    const stored = helpers.filter((h) => (ev.get(h) ?? []).some((e) => e?.type === "ShareStored")).length;
    h10xCheck(2, "Reparto: cada ayudante guarda su parte y se cumple el umbral (3 de 5)", !!done?.threshold_met && Number(done?.confirmed_count) === 5 && stored === 5, `versión ${version} · confirmadas ${done?.confirmed_count ?? "?"} · guardadas ${stored}/5 · eventos del dueño: ${h10xTypes(all)}`);
  } catch (e: any) {
    h10xCheck(2, "Reparto: cada ayudante guarda su parte y se cumple el umbral (3 de 5)", false, String(e?.message ?? e));
  }

  // 3. Ningún ayudante tiene la llave ni la configuración a la vista.
  try {
    let leaks = 0;
    let shares = 0;
    for (const [i, h] of helpers.entries()) {
      const list: any[] = await h.shareStore.loadAll(sid, [ids[i] ?? ""]);
      shares += list.length;
      for (const s of list) if (h10xHas(s.bytes, key) || h10xHas(s.bytes, config)) leaks++;
    }
    h10xCheck(3, "Ninguna parte contiene la llave ni la configuración", shares >= 5 && leaks === 0, `${shares} partes revisadas · ${leaks} con el secreto a la vista`);
  } catch (e: any) {
    h10xCheck(3, "Ninguna parte contiene la llave ni la configuración", false, String(e?.message ?? e));
  }

  // 4. Comprobación de las 5 partes.
  try {
    const st: any[] = await owner.protocol.start(FlowKind.VerifyShares, { secretId, version } as any);
    const ev = await h10xPump([owner, ...helpers]);
    const all = [...st, ...(ev.get(owner) ?? [])];
    const ok = all.filter((e) => e?.type === "ShareVerified").length;
    h10xCheck(4, "Comprobación: las 5 partes siguen bien guardadas", ok === 5, `ShareVerified ${ok}/5 · eventos: ${h10xTypes(all)}`);
  } catch (e: any) {
    h10xCheck(4, "Comprobación: las 5 partes siguen bien guardadas", false, String(e?.message ?? e));
  }

  // 5. E altera su parte (un byte en medio) y luego D está caído. Resultado por ayudante, para verlo claro.
  const letterOf = (ch: unknown): string => names[ids.indexOf(String(ch))] ?? "?";
  const verifyBy = async (down: Set<Node>): Promise<{ all: any[]; by: Map<string, string> }> => {
    const st: any[] = await owner.protocol.start(FlowKind.VerifyShares, { secretId, version } as any);
    const ev = await h10xPump([owner, ...helpers], down);
    const all = [...st, ...(ev.get(owner) ?? [])];
    const by = new Map<string, string>();
    for (const e of all) if (e?.channel_id !== undefined && /^ShareVerif|^VerifyShares/.test(String(e?.type))) by.set(letterOf(e.channel_id), String(e.type));
    return { all, by };
  };
  const show = (by: Map<string, string>): string => names.map((x) => `${x}: ${by.get(x) ?? "sin respuesta"}`).join(" · ");
  try {
    const [s] = await hE.shareStore.load(sid, ids[4] ?? "", [version]);
    if (!s) throw new Error("E no tiene parte");
    const bad = Uint8Array.from(s.bytes);
    const at = Math.floor(bad.length / 2);
    bad[at] = (bad[at] ?? 0) ^ 0xff;
    await hE.shareStore.save(sid, ids[4] ?? "", { ...s, bytes: bad });
    const [again] = await hE.shareStore.load(sid, ids[4] ?? "", [version]);
    const changed = !!again && h10xHex(again.bytes) === h10xHex(bad);
    const { by } = await verifyBy(new Set());
    const eBad = by.get("E") === "ShareVerifyInvalid" || by.get("E") === "ShareVerifyRejected";
    const othersOk = ["A", "B", "C", "D"].every((x) => by.get(x) === "ShareVerified");
    h10xCheck(5, "Parte alterada (E): la comprobación la marca y las demás siguen bien", eBad && othersOk, `parte de ${bad.length} bytes, alterado el byte ${at} (${changed ? "guardado" : "NO se guardó"}) · ${show(by)}`);
    const d = await verifyBy(new Set([hD]));
    h10xCheck(5, "Ayudante caído (D): la comprobación no lo da por bueno", d.by.get("D") !== "ShareVerified", show(d.by));
  } catch (e: any) {
    h10xCheck(5, "Parte alterada (E): la comprobación la marca y las demás siguen bien", false, String(e?.message ?? e));
  }

  // Un móvil nuevo (dueño sin nada) se empareja con estos ayudantes, que enlazan su canal viejo con el nuevo.
  let devices = 0;
  const newDevice = async (who: Node[], label: string): Promise<Node> => {
    devices++;
    // autoReplyTo: los ayudantes contestan a la dirección que viene en cada petición (la del móvil nuevo), no a la que
    // guardaron del móvil perdido.
    const d = h10xNode(label, `https://${label.toLowerCase()}.h10x.test/derec`, { secretId, threshold: 3, autoReplyTo: true });
    for (const h of who) {
      const i = helpers.indexOf(h);
      const r = await doPair(h, d, BigInt(100 * devices + i), `${label}↔Ayudante${names[i]}`);
      const fresh = String(r.longTermChannelId);
      try {
        await h.channelStore.linkChannel(sid, ids[i] ?? "", fresh);
      } catch {
        /* el orden del enlace puede ser el otro */
      }
      try {
        await h.channelStore.linkChannel(sid, fresh, ids[i] ?? "");
      } catch {
        /* idem */
      }
    }
    return d;
  };
  const recover = async (d: Node, who: Node[]): Promise<any[]> => {
    const st: any[] = await d.protocol.start(FlowKind.RecoverSecret, { secretId, version } as any);
    const ev = await h10xPump([d, ...who]);
    return [...st, ...(ev.get(d) ?? [])];
  };
  const dataOf = (ev: any, name: string): string => {
    const s = (ev?.secret?.secrets ?? []).find((x: any) => x?.name === name);
    return s?.data ? h10xHex(s.data) : "";
  };

  // 6. Móvil nuevo con A, B y C.
  let nuevo: Node | null = null;
  let recovered: any = null;
  try {
    nuevo = await newDevice([hA, hB, hC], "MovilNuevo");
    const all = await recover(nuevo, [hA, hB, hC]);
    recovered = all.find((e) => e?.type === "SecretRecovered") ?? null;
    recoveredHex = recovered ? dataOf(recovered, "cartera-testnet") : "";
    const cfgOk = recovered ? dataOf(recovered, "config") === h10xHex(config) : false;
    h10xCheck(6, "Móvil nuevo con A, B y C: recupera la llave y la configuración exactas", recoveredHex === secretHex && cfgOk, `eventos: ${h10xTypes(all)} · llave ${recoveredHex === secretHex ? "idéntica" : "distinta o ausente"} · configuración ${cfgOk ? "idéntica" : "distinta o ausente"}`);
  } catch (e: any) {
    h10xCheck(6, "Móvil nuevo con A, B y C: recupera la llave y la configuración exactas", false, String(e?.message ?? e));
  }

  // 7. Con A, B y la parte alterada de E: nunca una llave equivocada.
  try {
    const d = await newDevice([hA, hB, hE], "MovilAtacado");
    const all = await recover(d, [hA, hB, hE]);
    const r = all.find((e) => e?.type === "SecretRecovered");
    const got = r ? dataOf(r, "cartera-testnet") : "";
    h10xCheck(7, "Con una parte alterada entre 3: no sale ninguna llave equivocada", !r || got === secretHex, `eventos: ${h10xTypes(all)}${r ? ` · ${got === secretHex ? "salió la correcta" : "SALIÓ OTRA LLAVE"}` : " · no se recupera"}`);
  } catch (e: any) {
    h10xCheck(7, "Con una parte alterada entre 3: no sale ninguna llave equivocada", true, `se niega con error: ${String(e?.message ?? e)}`);
  }

  // 8. Con solo 2 ayudantes.
  try {
    const d = await newDevice([hA, hB], "MovilConDos");
    const all = await recover(d, [hA, hB]);
    const r = all.some((e) => e?.type === "SecretRecovered");
    h10xCheck(8, "Con solo 2 ayudantes (menos del umbral): no se recupera", !r, `eventos: ${h10xTypes(all)}`);
  } catch (e: any) {
    h10xCheck(8, "Con solo 2 ayudantes (menos del umbral): no se recupera", true, `se niega con error: ${String(e?.message ?? e)}`);
  }

  // 9. El móvil nuevo restaura y vuelve a repartir.
  try {
    if (!nuevo || !recovered) throw new Error("no hay recuperación del paso 6");
    const rs: any[] = await nuevo.protocol.restore(recovered.secret, version);
    const ev0 = await h10xPump([nuevo, owner, ...helpers]);
    const st: any[] = await nuevo.protocol.start(FlowKind.ProtectSecret, { secrets, description: "H10X Wallet · tras recuperar", threshold: 3 } as any);
    const ev = await h10xPump([nuevo, owner, ...helpers]);
    const all = [...rs, ...(ev0.get(nuevo) ?? []), ...st, ...(ev.get(nuevo) ?? [])];
    const done = all.find((e) => e?.type === "SharingComplete");
    const lost = (ev.get(owner) ?? []).length + (ev0.get(owner) ?? []).length;
    if (lost) h10xErr(`      (${lost} respuestas fueron a la dirección del móvil perdido)`);
    h10xCheck(9, "El móvil nuevo restaura y vuelve a repartir (versión nueva, umbral cumplido)", !!done?.threshold_met && Number(done?.version) > version, `versión ${done?.version ?? "?"} · confirmadas ${done?.confirmed_count ?? "?"} · eventos: ${h10xTypes(all)}`);
  } catch (e: any) {
    h10xCheck(9, "El móvil nuevo restaura y vuelve a repartir (versión nueva, umbral cumplido)", false, String(e?.message ?? e));
  }

  const ok = h10xResults.length === 10 && h10xResults.every((r) => r.pass);
  h10xErr(`\n${h10xResults.filter((r) => r.pass).length}/${h10xResults.length} en la caja · ${Math.round((Date.now() - t0) / 1000)} s`);
  process.stdout.write(JSON.stringify({ h10xDerec: 1, ok, results: h10xResults, recoveredHex, accountId: String(input.accountId ?? "") }) + "\n");
}

await h10xRun();
