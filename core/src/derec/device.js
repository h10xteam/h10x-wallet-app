// H10X Wallet · DeRec: el «motor» de un móvil. Une el SDK de DeRec (inyectado: @derec-alliance/react-native en la app,
// @derec-alliance/nodejs en el servidor de pruebas), los almacenes persistentes, el buzón HCS y las reglas de la wallet:
//
//  - Emparejar (y el paso previo PrePair): solo con códigos que este móvil acaba de enseñar (caducan a los 15 min).
//  - Guardar y comprobar partes de un amigo ya emparejado: automático (el amigo no ve nada de lo que guarda).
//  - Dar una parte para recuperar: SIEMPRE lo confirma la persona (salvo el modo robot de las pruebas en testnet).
//  - Lo demás (pre-emparejar, peticiones raras): se rechaza.
//
// Un móvil puede ser dueño (protege su Cartera) y ayudante (guarda partes de otros) a la vez. El SDK trabaja con una
// instancia por secreto (secretId); el motor abre las que hagan falta sobre los mismos almacenes y reparte cada mensaje
// del buzón a la instancia que lo entiende.
import { decodeBase64, encodeBase64 } from "ethers";
import { decodeFriendCode, encodeFriendCode, shortFingerprint } from "./contact.js";
import { derecStores, secretIdsWithChannel } from "./stores.js";

/** Plazos de DeRec ajustados a móviles que abren la app de vez en cuando y a HCS (segundos). */
export const DEREC_TIMEOUTS = Object.freeze({
  pairing_secs: 900,
  inbound_message_secs: 30 * 24 * 3600,
  sharing_round_secs: 30 * 24 * 3600,
  get_share_response_secs: 2 * 24 * 3600,
  unpair_ack_secs: 24 * 3600,
});
/** Un código enseñado o escaneado vale 15 minutos. */
export const DEREC_CODE_TTL_MS = 15 * 60 * 1000;
/** Umbral por defecto: mayoría de los amigos (mínimo 2). @param {number} helpers */
export const derecThreshold = (helpers) => Math.max(2, Math.floor(helpers / 2) + 1);
/** Ids de los secretos que protege la wallet. */
export const DEREC_SECRET_IDS = Object.freeze({ cartera: Uint8Array.from([1]), perfil: Uint8Array.from([2]) });

const te = new TextEncoder();
const td = new TextDecoder();
/** @param {any} o */
const J = (o) => te.encode(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
/** @param {Uint8Array | null} b @returns {any} */
const P = (b) => (b ? JSON.parse(td.decode(b)) : null);
/** Id aleatorio de secreto (u63, decimal). @param {() => Uint8Array} rnd */
export const newSecretId = (rnd) => {
  const b = rnd();
  let n = 0n;
  for (const x of b.slice(0, 8)) n = (n << 8n) | BigInt(x);
  return ((n % 9_000_000_000_000_000_000n) + 1n).toString();
};

/**
 * @typedef {{ kind: "accept" | "reject" | "ask", why?: string }} Decision
 * @typedef {{ id: string, secretId: string, channelId: string, kind: string, name: string, at: number, fingerprint?: string }} PendingApproval
 */

export class DerecDevice {
  /**
   * @param {{
   *   sdk: any,                      // módulo del SDK de DeRec (nodejs o react-native)
   *   kv: import("./stores.js").DerecKV,
   *   transport: { send(endpoints: ReadonlyArray<{ uri: string, protocol: string }>, message: Uint8Array): Promise<void> },
   *   inbox: { poll(): Promise<{ seq: number, at: string, from: string, bytes: Uint8Array }[]> },
   *   ownUri: string,                // buzón de este móvil (endpoint https)
   *   network: string,
   *   name: string,                  // lo que verán los amigos
   *   robot?: boolean,               // pruebas: da partes sin preguntar (solo a canales enlazados para recuperar)
   *   contactMode?: "inline" | "hashed",
   *   now?: () => number,
   *   log?: (s: string) => void,
   * }} o
   */
  constructor(o) {
    this.sdk = o.sdk;
    this.kv = o.kv;
    this.transport = o.transport;
    this.inbox = o.inbox;
    this.ownUri = o.ownUri;
    this.network = o.network;
    this.name = String(o.name ?? "").slice(0, 40);
    this.robot = o.robot === true;
    this.contactMode = o.contactMode ?? "hashed";
    this.now = o.now ?? Date.now;
    this.log = o.log ?? (() => {});
    this.stores = derecStores(o.kv, { refusal: typeof o.sdk.shareStoreRefusal === "function" ? o.sdk.shareStoreRefusal : undefined, now: this.now });
    /** @type {Map<string, any>} secretId → instancia del SDK */
    this.instances = new Map();
  }

  // ---- Instancias ---------------------------------------------------------------------------------------------------

  /** Abre (o devuelve) la instancia de un secreto. @param {string} secretId @param {{ threshold?: number }} [opt] */
  instance(secretId, opt = {}) {
    const sid = String(secretId);
    const cur = this.instances.get(sid);
    if (cur) return cur;
    const { DeRecProtocolBuilder } = this.sdk;
    let b = new DeRecProtocolBuilder(BigInt(sid))
      .withStores(this.stores)
      .withTransport(this.transport)
      .withOwnTransports([{ uri: this.ownUri, protocol: "https" }])
      .withCommunicationInfo({ name: this.name })
      .withTimeouts({ ...DEREC_TIMEOUTS })
      .withAutoReplyTo(true)
      .withAutoRespondOnFailure(true);
    if (opt.threshold) b = b.withThreshold(opt.threshold);
    const p = b.build();
    this.instances.set(sid, p);
    return p;
  }

  /** Instancias que hay que tener abiertas: la propia (si protege algo) y una por cada amigo al que ayuda. */
  async openAll() {
    const own = await this.ownSecretId(false);
    if (own) this.instance(own);
    for (const pre of ["ow/", "pc/"]) {
      for (const k of await this.kv.keys(pre)) {
        const j = P(await this.kv.get(k));
        if (j?.secretId) this.instance(String(j.secretId));
      }
    }
  }

  close() {
    for (const p of this.instances.values()) {
      try {
        p.free();
      } catch {
        /* ya liberada */
      }
    }
    this.instances.clear();
  }

  /** Canal nuevo para un código (u63 aleatorio, como pide el SDK en sus pruebas). */
  freshChannelId() {
    const b = new Uint8Array(8);
    globalThis.crypto.getRandomValues(b);
    return BigInt(newSecretId(() => b));
  }

  /** El secretId de la Cartera de este móvil (se crea la primera vez). @param {boolean} create */
  async ownSecretId(create = true) {
    const cur = P(await this.kv.get("me/secret"));
    if (cur?.secretId) return String(cur.secretId);
    if (!create) return null;
    const rnd = () => {
      const b = new Uint8Array(8);
      globalThis.crypto.getRandomValues(b);
      return b;
    };
    const secretId = newSecretId(rnd);
    await this.kv.set("me/secret", J({ secretId, createdAt: this.now() }));
    return secretId;
  }

  // ---- Códigos de amigo -----------------------------------------------------------------------------------------------

  /**
   * DUEÑO: el código que enseña a un amigo para que le ayude (QR o enlace). Lo escanea el amigo en «Ayudar».
   * En recuperación (móvil nuevo), `recovering` = true: mismo código; los amigos eligen a quién ayudan antes de escanear.
   * @param {{ recovering?: boolean, secretId?: string }} [o]
   */
  async ownerCode(o = {}) {
    const secretId = o.secretId ?? (await this.ownSecretId(true));
    const p = this.instance(String(secretId));
    const mode = this.contactMode === "inline" ? this.sdk.ContactMode.InlineKeys : this.sdk.ContactMode.HashedKeys;
    const contact = await p.createContact(this.freshChannelId(), mode);
    await this.kv.set(`pc/${contact.channel_id}`, J({ role: "owner", secretId: String(secretId), createdAt: this.now(), recovering: !!o.recovering }));
    return encodeFriendCode({ purpose: o.recovering ? "recover" : "pair", name: this.name, network: this.network, contact, secretId: String(secretId) });
  }

  /**
   * AYUDANTE: escanea el código de un amigo. Para guardar sus partes («pair»), o para ayudarle a recuperar
   * («recover»): entonces `forOwnerChannel` dice a qué amigo de los que ya ayuda corresponde ese móvil nuevo.
   * @param {string} text @param {{ forOwnerChannel?: string }} [o]
   */
  async helperScan(text, o = {}) {
    const code = decodeFriendCode(text);
    if (code.network !== this.network) throw new Error(`DeRec: ese código es de ${code.network}`);
    if (!code.secretId) throw new Error("DeRec: código sin secreto");
    if (code.purpose === "recover" && !o.forOwnerChannel) throw new Error("DeRec: elige primero a qué amigo ayudas");
    const p = this.instance(code.secretId);
    // Se apunta ANTES de empezar: la respuesta puede llegar en cuanto sale la petición.
    await this.kv.set(
      `pc/${code.contact.channel_id}`,
      J({ role: "helper", secretId: code.secretId, name: code.name, createdAt: this.now(), ...(o.forOwnerChannel ? { link: String(o.forOwnerChannel) } : {}) }),
    );
    const ev = await p.start(this.sdk.FlowKind.Pairing, { kind: this.sdk.SenderKind.Helper, contact: code.contact });
    return { code, events: ev };
  }

  /**
   * AYUDANTE enseña el código (dirección B). Para emparejar sin saber aún quién es el dueño se usa la instancia propia
   * del ayudante; para RECUPERAR, el ayudante elige antes al amigo (canal viejo) y el código lleva su secreto y versión.
   * @param {{ forOwnerChannel?: string, version?: number }} [o]
   */
  async helperCode(o = {}) {
    // `secretId`: la instancia donde vive el canal con el amigo; `ownerSecretId`: el secreto del amigo (va en el código).
    let secretId;
    let ownerSecretId = "";
    if (o.forOwnerChannel) {
      const ow = P(await this.kv.get(`ow/${o.forOwnerChannel}`));
      if (!ow?.secretId) throw new Error("DeRec: no ayudas a ese amigo");
      secretId = String(ow.secretId);
      ownerSecretId = String(ow.ownerSecretId ?? ow.secretId);
    } else secretId = /** @type {string} */ (await this.ownSecretId(true));
    const p = this.instance(secretId);
    const mode = this.contactMode === "inline" ? this.sdk.ContactMode.InlineKeys : this.sdk.ContactMode.HashedKeys;
    const contact = await p.createContact(this.freshChannelId(), mode);
    await this.kv.set(`pc/${contact.channel_id}`, J({ role: "helper", secretId, createdAt: this.now(), ...(o.forOwnerChannel ? { link: String(o.forOwnerChannel) } : {}) }));
    return encodeFriendCode({
      purpose: o.forOwnerChannel ? "recover" : "pair",
      name: this.name,
      network: this.network,
      contact,
      ...(o.forOwnerChannel ? { secretId: ownerSecretId, ...(o.version ? { version: o.version } : {}) } : {}),
    });
  }

  /**
   * DUEÑO escanea el código de un amigo (dirección B). En un móvil nuevo, el código de recuperación trae el secreto:
   * este móvil abre esa instancia y se empareja como dueño.
   * @param {string} text
   */
  async ownerScan(text) {
    const code = decodeFriendCode(text);
    if (code.network !== this.network) throw new Error(`DeRec: ese código es de ${code.network}`);
    const secretId = code.purpose === "recover" ? String(code.secretId ?? "") : /** @type {string} */ (await this.ownSecretId(true));
    if (!secretId) throw new Error("DeRec: código de recuperación sin secreto");
    const p = this.instance(secretId);
    await this.kv.set(`pc/${code.contact.channel_id}`, J({ role: "owner", secretId, name: code.name, createdAt: this.now(), recovering: code.purpose === "recover", ...(code.version ? { version: code.version } : {}) }));
    if (code.purpose === "recover") {
      const cur = P(await this.kv.get("me/recovering"));
      if (cur?.secretId && String(cur.secretId) !== secretId) throw new Error("DeRec: ese código es de otra wallet");
      await this.kv.set("me/recovering", J({ secretId, version: Math.max(Number(cur?.version ?? 0), Number(code.version ?? 1)) }));
    }
    const ev = await p.start(this.sdk.FlowKind.Pairing, { kind: this.sdk.SenderKind.Owner, contact: code.contact });
    return { code, events: ev };
  }

  // ---- Dueño --------------------------------------------------------------------------------------------------------

  /** Amigos emparejados (dueño). @returns {Promise<{ channelId: string, name: string, pairedAt: number }[]>} */
  async friends() {
    const out = [];
    for (const k of await this.kv.keys("fr/")) {
      const j = P(await this.kv.get(k));
      if (j) out.push({ channelId: k.slice(3), name: String(j.name ?? ""), pairedAt: Number(j.pairedAt ?? 0) });
    }
    return out;
  }

  /**
   * Reparte la Cartera y el perfil entre los amigos emparejados.
   * @param {{ cartera: Uint8Array, perfil: Uint8Array, threshold?: number, description?: string }} p
   */
  async protect({ cartera, perfil, threshold, description = "H10X Wallet" }) {
    const sid = /** @type {string} */ (await this.ownSecretId(true));
    const n = (await this.friends()).length;
    const t = threshold ?? derecThreshold(n);
    if (n < t) throw new Error(`DeRec: hacen falta al menos ${t} amigos`);
    const p = this.instance(sid);
    const secrets = [
      { id: DEREC_SECRET_IDS.cartera, name: "cartera", data: cartera },
      { id: DEREC_SECRET_IDS.perfil, name: "perfil", data: perfil },
    ];
    const ev = await p.start(this.sdk.FlowKind.ProtectSecret, { secrets, description, threshold: t });
    await this.kv.set("me/protect", J({ startedAt: this.now(), threshold: t, helpers: n }));
    return ev;
  }

  /** Comprueba que cada amigo sigue guardando bien su parte. @param {number} version */
  async verify(version) {
    const sid = await this.ownSecretId(false);
    if (!sid) throw new Error("DeRec: no hay nada protegido");
    await this.kv.set("me/verify", J({ startedAt: this.now(), version }));
    return this.instance(sid).start(this.sdk.FlowKind.VerifyShares, { secretId: BigInt(sid), version });
  }

  /** Pide las partes para recuperar (móvil nuevo, ya emparejado con los amigos). @param {string} secretId @param {number} version */
  async recover(secretId, version) {
    return this.instance(secretId).start(this.sdk.FlowKind.RecoverSecret, { secretId: BigInt(secretId), version });
  }

  /** Pregunta a los amigos emparejados qué secretos y versiones guardan. @param {string} secretId */
  async discover(secretId) {
    return this.instance(secretId).start(this.sdk.FlowKind.Discovery, {});
  }

  /**
   * Tras recuperar: este móvil pasa a ser el dueño de ese secreto (lo apunta) y DeRec rehace los canales.
   * @param {any} recovered secreto del evento SecretRecovered @param {string} secretId @param {number} version
   */
  async adopt(recovered, secretId, version) {
    await this.kv.set("me/secret", J({ secretId: String(secretId), createdAt: this.now(), recoveredFrom: version }));
    const ev = await this.instance(secretId).restore(recovered, version);
    // Los amigos pasan a ser los de lo recuperado (sus canales de siempre); los canales de la recuperación se cierran.
    const helpers = Array.isArray(recovered?.helpers) ? recovered.helpers : [];
    const keep = new Set(helpers.map((/** @type {any} */ h) => String(h?.channel_id)));
    if (keep.size) {
      for (const k of await this.kv.keys("fr/")) if (!keep.has(k.slice(3))) await this.kv.del(k);
      for (const h of helpers) {
        const ch = String(h?.channel_id);
        if (!(await this.kv.get(`fr/${ch}`))) await this.kv.set(`fr/${ch}`, J({ name: String(h?.communication_info?.name ?? ""), pairedAt: this.now(), restored: true, secretId: String(secretId) }));
      }
    }
    await this.kv.del("me/recovering");
    return ev;
  }

  /** Móvil nuevo: de qué secreto y versión es la recuperación en curso (sale del primer código de recuperación). */
  async recoveryTarget() {
    const j = P(await this.kv.get("me/recovering"));
    return j?.secretId ? { secretId: String(j.secretId), version: Number(j.version ?? 1) } : null;
  }

  // ---- Buzón y reglas ----------------------------------------------------------------------------------------------

  /** Lee el buzón, entrega cada mensaje a su instancia y aplica las reglas. @returns {Promise<any[]>} eventos */
  async pump() {
    await this.openAll();
    const msgs = await this.inbox.poll();
    const out = [];
    for (const m of msgs) out.push(...(await this.deliver(m.bytes)));
    for (const p of this.instances.values()) {
      try {
        out.push(...((await p.tick()) ?? []));
      } catch (e) {
        this.log(`tick: ${errText(e)}`);
      }
    }
    return out;
  }

  /** Un mensaje: prueba cada instancia hasta que una lo entienda. @param {Uint8Array} bytes */
  async deliver(bytes) {
    const tried = [];
    for (const [sid, p] of this.instances) {
      let ev = [];
      try {
        ev = (await p.process(bytes)) ?? [];
      } catch (e) {
        tried.push(`${sid.slice(0, 6)}…: ${errText(e)}`);
        continue;
      }
      const useful = ev.filter((/** @type {any} */ e) => e?.type !== "MessageIgnored");
      if (!useful.length) {
        tried.push(`${sid.slice(0, 6)}…: ignorado`);
        continue;
      }
      const out = [...ev];
      for (const e of ev) if (e?.type === "ActionRequired") out.push(...(await this.act(sid, p, e)));
      for (const e of out) {
        await this.remember(e, sid);
        await this.track(e);
      }
      return out.map((e) => ({ ...e, h10xSecretId: sid }));
    }
    this.log(`mensaje sin dueño (${tried.join(" · ")})`);
    return [{ type: "H10xUndelivered", detail: tried.join(" · ") }];
  }

  /** Reglas de la wallet para lo que pide el otro móvil. @param {string} sid @param {any} p @param {any} e */
  async act(sid, p, e) {
    const d = await this.decide(sid, e);
    this.log(`${e.action_kind} en ${String(e.channel_id).slice(0, 8)}… → ${d.kind}${d.why ? ` (${d.why})` : ""}`);
    if (d.kind === "accept") {
      try {
        return (await p.accept(e.action)) ?? [];
      } catch (err) {
        return [{ type: "H10xAcceptFailed", action_kind: e.action_kind, message: errText(err) }];
      }
    }
    if (d.kind === "reject") {
      try {
        await p.reject(e.action, this.sdk.StatusEnum.Rejected, d.why ?? "rechazado");
      } catch (err) {
        this.log(`reject: ${errText(err)}`);
      }
      return [];
    }
    // Preguntar a la persona: se guarda la acción para la pantalla.
    const id = String(e.trace_id ?? `${e.channel_id}-${this.now()}`);
    const fingerprint = await p
      .getFingerprint(BigInt(e.channel_id))
      .then((/** @type {string} */ f) => shortFingerprint(f))
      .catch(() => "");
    const ow = P(await this.kv.get(`ow/${e.channel_id}`));
    await this.kv.set(
      `pa/${id}`,
      J({ id, secretId: sid, channelId: String(e.channel_id), kind: String(e.action_kind), name: String(e.peer_communication_info?.name ?? ow?.name ?? ""), at: this.now(), fingerprint, action: encodeBase64(e.action) }),
    );
    return [{ type: "H10xApprovalNeeded", id, action_kind: e.action_kind, channel_id: String(e.channel_id) }];
  }

  /** @param {string} sid @param {any} e @returns {Promise<Decision>} */
  async decide(sid, e) {
    const k = String(e.action_kind);
    const ch = String(e.channel_id);
    if (k === "StoreShare" && e.share_secret_id) {
      const ow = P(await this.kv.get(`ow/${ch}`));
      if (ow && ow.ownerSecretId !== String(e.share_secret_id)) await this.kv.set(`ow/${ch}`, J({ ...ow, ownerSecretId: String(e.share_secret_id), version: e.version ?? ow.version ?? null }));
    }
    // Con códigos «hashed» (QR pequeño) el otro móvil pide primero las llaves (PrePair) y luego se empareja (Pairing):
    // las dos solo para un código que este móvil acaba de enseñar (así no sirve para que un extraño le haga hablar).
    if (k === "Pairing" || k === "PrePair") {
      const pc = P(await this.kv.get(`pc/${ch}`));
      if (!pc) return { kind: "reject", why: "código desconocido" };
      if (this.now() - Number(pc.createdAt) > DEREC_CODE_TTL_MS) return { kind: "reject", why: "código caducado" };
      return { kind: "accept" };
    }
    if (k === "StoreShare" || k === "VerifyShare" || k === "Discovery" || k === "UpdateChannelInfo" || k === "Unpair") return { kind: "accept" };
    if (k === "GetShare") {
      if (!this.robot) return { kind: "ask" };
      // Robot de pruebas: solo a canales enlazados para recuperar.
      const linked = P(await this.kv.get(`lk/${ch}`));
      return linked ? { kind: "accept" } : { kind: "reject", why: "canal no enlazado para recuperar" };
    }
    return { kind: "reject", why: `no se acepta ${k}` };
  }

  /** Lo que la pantalla tiene que preguntar. @returns {Promise<PendingApproval[]>} */
  async pendingApprovals() {
    const out = [];
    for (const k of await this.kv.keys("pa/")) {
      const j = P(await this.kv.get(k));
      if (j) out.push({ id: j.id, secretId: j.secretId, channelId: j.channelId, kind: j.kind, name: j.name, at: j.at, fingerprint: j.fingerprint });
    }
    return out.sort((a, b) => a.at - b.at);
  }

  /** La persona decide. @param {string} id @param {boolean} yes */
  async answer(id, yes) {
    const j = P(await this.kv.get(`pa/${id}`));
    if (!j) throw new Error("DeRec: esa petición ya no está");
    await this.kv.del(`pa/${id}`);
    const p = this.instance(String(j.secretId));
    const action = Uint8Array.from(decodeBase64(j.action));
    if (yes) return (await p.accept(action)) ?? [];
    await p.reject(action, this.sdk.StatusEnum.Rejected, "no confirmado por el amigo");
    return [];
  }

  /**
   * Apunta lo que la wallet necesita recordar de cada evento (amigos, a quién ayuda, enlaces de recuperación).
   * @param {any} ev @param {string} sid instancia que lo produjo
   */
  async remember(ev, sid) {
    if (ev?.type !== "PairingCompleted") return;
    const pc = P(await this.kv.get(`pc/${ev.pairing_channel_id}`));
    const ch = String(ev.channel_id);
    const name = String(ev.peer_communication_info?.name ?? pc?.name ?? "");
    if (pc?.role === "owner") await this.kv.set(`fr/${ch}`, J({ name, pairedAt: this.now(), recovering: !!pc.recovering, secretId: sid }));
    if (pc?.role === "helper") {
      await this.kv.set(`ow/${ch}`, J({ name, secretId: String(pc.secretId ?? sid), pairedAt: this.now() }));
      if (pc.link) {
        // Móvil nuevo de un amigo: su canal nuevo se enlaza con el viejo (en las zonas donde exista el viejo).
        const zones = new Set([String(pc.secretId), ...(await secretIdsWithChannel(this.kv, pc.link))]);
        for (const z of zones) await this.stores.channelStore.linkChannel(z, pc.link, ch);
        await this.kv.set(`lk/${ch}`, J({ old: pc.link, secretId: pc.secretId, at: this.now() }));
      }
    }
    if (pc) await this.kv.del(`pc/${ev.pairing_channel_id}`);
  }

  /**
   * Apunta resultados para el semáforo: el último reparto y, por amigo, la última comprobación.
   * @param {any} e
   */
  async track(e) {
    const t = String(e?.type ?? "");
    if (t === "SharingComplete") {
      await this.kv.set("me/shared", J({ version: Number(e.version), confirmed: Number(e.confirmed_count ?? 0), failed: Number(e.failed_count ?? 0), met: !!e.threshold_met, at: this.now() }));
    } else if (t === "ShareVerified" || t === "ShareVerifyInvalid" || t === "ShareVerifyRejected") {
      await this.kv.set(`vr/${String(e.channel_id)}`, J({ ok: t === "ShareVerified", kind: t, version: Number(e.version ?? 0), at: this.now() }));
    }
  }

  /**
   * Semáforo del dueño: cada amigo con su estado. verde = comprobado hace menos de 8 días; ámbar = sin comprobar o
   * hace tiempo; rojo = la última comprobación falló.
   * @returns {Promise<{ shared: { version: number, confirmed: number, failed: number, met: boolean, at: number } | null,
   *   friends: { channelId: string, name: string, pairedAt: number, light: "green" | "amber" | "red", checkedAt: number | null }[] }>}
   */
  async ownerStatus() {
    const shared = P(await this.kv.get("me/shared"));
    const verify = P(await this.kv.get("me/verify"));
    const out = [];
    for (const f of await this.friends()) {
      const v = P(await this.kv.get(`vr/${f.channelId}`));
      /** @type {"green" | "amber" | "red"} */
      let light = "amber";
      if (v && !v.ok) light = "red";
      else if (v?.ok && this.now() - Number(v.at) < 8 * 86400_000) light = "green";
      // Pedimos comprobar hace más de un día y este amigo no ha contestado: rojo.
      if (verify && this.now() - Number(verify.startedAt) > 86400_000 && (!v || Number(v.at) < Number(verify.startedAt))) light = "red";
      out.push({ ...f, light, checkedAt: v?.at ?? null });
    }
    return { shared, friends: out };
  }

  /** Código corto (6 cifras) de un canal, para leerlo por teléfono con el otro móvil. @param {string} channelId */
  async fingerprintFor(channelId) {
    const fr = P(await this.kv.get(`fr/${channelId}`));
    const ow = P(await this.kv.get(`ow/${channelId}`));
    const sid = String(fr?.secretId ?? ow?.secretId ?? (await this.ownSecretId(false)) ?? "");
    if (!sid) return "";
    try {
      return shortFingerprint(await this.instance(sid).getFingerprint(BigInt(channelId)));
    } catch {
      return "";
    }
  }

  /** ¿Hay algo a medias que pida mirar el buzón a menudo? (códigos recientes, peticiones por confirmar, un reparto) */
  async busy() {
    for (const k of await this.kv.keys("pc/")) {
      const j = P(await this.kv.get(k));
      if (j && this.now() - Number(j.createdAt) < DEREC_CODE_TTL_MS) return true;
    }
    if ((await this.kv.keys("pa/")).length) return true;
    const pr = P(await this.kv.get("me/protect"));
    const sh = P(await this.kv.get("me/shared"));
    return !!pr && (!sh || Number(sh.at) < Number(pr.startedAt)) && this.now() - Number(pr.startedAt) < 3600_000;
  }

  /** ¿Usa DeRec esta wallet? (para no mirar el buzón si nunca se activó) */
  async active() {
    return (await this.kv.keys("fr/")).length > 0 || (await this.kv.keys("ow/")).length > 0 || (await this.kv.keys("pc/")).length > 0;
  }

  /** Amigos a los que este móvil ayuda. @returns {Promise<{ channelId: string, name: string, secretId: string, pairedAt: number }[]>} */
  async helping() {
    const out = [];
    for (const k of await this.kv.keys("ow/")) {
      const j = P(await this.kv.get(k));
      if (j) out.push({ channelId: k.slice(3), name: String(j.name ?? ""), secretId: String(j.secretId ?? ""), pairedAt: Number(j.pairedAt ?? 0) });
    }
    return out;
  }
}

/** @param {unknown} e */
function errText(e) {
  const x = /** @type {any} */ (e);
  return String(x?.message ?? x).slice(0, 200) + (x?.code ? ` [${x.code}]` : "");
}
