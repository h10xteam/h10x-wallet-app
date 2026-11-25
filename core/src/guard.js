// @ts-check
// Reglas del guardián que no necesitan red y conviene poder probar solas: el presupuesto diario de lo que
// paga por cada bóveda y qué hacer con una petición que no ha podido leer.

/** Día (UTC) de una marca de tiempo en segundos. @param {number} now */
export const budgetDay = (now) => Math.floor(now / 86400);

/**
 * @typedef {{ approve: number, veto: number, freeze: number, email?: number }} BudgetLimits
 * @typedef {{ day: number, approve: number, veto: number, freeze: number, email?: number }} BudgetSpend
 */

/**
 * Gasta una llamada del presupuesto diario de una bóveda. Devuelve false, sin gastar, si ya llegó al tope.
 * Cada llamada al notario la paga el guardián: sin tope, cualquiera con una bóveda propia podría hacerle
 * gastar hasta dejarlo sin saldo, y sin saldo no bloquea nada de nadie.
 * @param {{ spend?: BudgetSpend }} v @param {"approve" | "veto" | "freeze" | "email"} kind @param {BudgetLimits} limits @param {number} now
 */
export function takeBudget(v, kind, limits, now) {
  const day = budgetDay(now);
  if (!v.spend || v.spend.day !== day) v.spend = { day, approve: 0, veto: 0, freeze: 0 };
  const used = v.spend[kind] ?? 0;
  if (used >= (limits[kind] ?? 0)) return false;
  v.spend[kind] = used + 1;
  return true;
}

/**
 * Bóveda que sale del guardián para hacer sitio a otra cuando está lleno, o null (entonces la nueva espera: 503).
 * Nunca sale una en modo robo o con algo pendiente: esas se vigilan hasta el final. De las demás, la de menos saldo, y
 * solo si tiene menos que la que llega (así nadie echa a una bóveda de verdad con bóvedas vacías). Las que tienen
 * correo salen las últimas (no se blindan del todo: si no, bastaría llenar el guardián de bóvedas vacías con correo).
 * Quien llama avisa a la que sale: antes salía en silencio y su dueño seguía creyendo que estaba vigilada.
 * @param {{ id: string, balance: bigint, busy: boolean, email: boolean, theft: boolean }[]} candidates
 * @param {bigint} wanted saldo de la bóveda que llega
 * @returns {string | null}
 */
export function pickEviction(candidates, wanted) {
  for (const withEmail of [false, true]) {
    /** @type {{ id: string, balance: bigint } | null} */
    let poorest = null;
    for (const c of candidates) {
      if (c.busy || c.theft || c.email !== withEmail) continue;
      if (!poorest || c.balance < poorest.balance) poorest = c;
    }
    if (poorest && poorest.balance < wanted) return poorest.id;
  }
  return null;
}

/**
 * Lo que dice el guardián de una bóveda en GET /vaults/<id>, según quién pregunta:
 *   "admin": desde el propio servidor, sin pasar por Caddy ni por el túnel de Expo (pruebas y administración): todo;
 *   "owner": la app de esa bóveda, con el código de lectura que le dio el registro: lo que enseña la app;
 *   "public": cualquiera: solo si está registrada. Antes cualquiera veía si tenía correo, avisos, modo robo y sus
 *   operaciones pendientes, y así podía elegir a quién robar.
 * @param {any} v la entrada del estado del guardián (o undefined si no está registrada)
 * @param {"admin" | "owner" | "public"} who
 * @param {{ now: number, mask: (email: string) => string }} p
 */
export function vaultStatusView(v, who, { now, mask }) {
  if (!v) return { registered: false };
  if (who === "public") return { registered: true };
  const emailPending = v.emailPending && v.emailPending.expires > now ? mask(v.emailPending.address) : null;
  const base = { registered: true, pushes: Boolean(v.pushToken), theft: v.theft ?? null, email: v.email ? mask(v.email.address) : null, emailPending, h10x: v.h10x ?? null };
  return who === "admin" ? { ...base, pending: v.pending } : base;
}

/**
 * Quién pregunta, a partir de la conexión: "admin" solo si llega del propio servidor y SIN cabecera X-Forwarded-For
 * (Caddy y el túnel de Expo siempre la ponen); "owner" si trae el código de lectura bueno; si no, "public".
 * @param {{ remote: string | undefined, forwarded: string | string[] | undefined, tokenOk: boolean }} p
 * @returns {"admin" | "owner" | "public"}
 */
export function statusAudience({ remote, forwarded, tokenOk }) {
  const local = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  if (local && forwarded === undefined) return "admin";
  return tokenOk ? "owner" : "public";
}

/**
 * Qué hacer con una petición que el guardián todavía no ha podido leer en el mirror:
 *   "wait":    queda margen, se vuelve a mirar en la siguiente vuelta;
 *   "block":   ha pasado media cuenta atrás sin poder leerla: lo que no se puede leer, no sale;
 *   "expired": ya no puede ejecutarse (pasó la vida máxima de una programada): se olvida.
 * @param {{ executableAt: number, requestedAt?: number }} p @param {number} now @param {number} maxLifetime
 * @returns {"wait" | "block" | "expired"}
 */
export function uncheckedVerdict(p, now, maxLifetime) {
  if (now > p.executableAt + maxLifetime) return "expired";
  const start = p.requestedAt ?? p.executableAt - 120;
  const deadline = start + Math.floor(Math.max(0, p.executableAt - start) / 2);
  return now >= deadline ? "block" : "wait";
}
