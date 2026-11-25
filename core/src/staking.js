// @ts-check
// Rendimiento de la bóveda con el staking nativo de Hedera.
//
// La cuenta solo dice a qué nodo apoya: los HBAR no se mueven, no hay bloqueo ni penalizaciones y las
// recompensas llegan a la propia bóveda. Elegir nodo es una actualización de la cuenta, así que en una
// bóveda ya creada va por el carril de retirada, con su cuenta atrás, como cualquier otra operación.

/** ¿Tiene el nodo más stake con recompensa que su máximo? (entonces paga menos) @param {import("./mirror.js").StakingNode} n */
export const nodeIsFull = (n) => n.maxStake > 0 && n.stakeRewarded >= n.maxStake;

/**
 * Rendimiento anual aproximado de un nodo, en %, a partir de lo que pagó el último día.
 * (`rewardRateStart` son tinybars por HBAR y día: × 365 / 10⁸ × 100.)
 * @param {import("./mirror.js").StakingNode} n
 */
export const nodeAprPercent = (n) => (n.rewardRateStart > 0 ? (n.rewardRateStart * 365) / 1e6 : 0);

/**
 * Nodo por defecto para una bóveda: el que más paga entre los que no están llenos; a igualdad, el
 * menos lleno. Devuelve null si no hay nodos.
 * @param {import("./mirror.js").StakingNode[]} nodes
 * @returns {number | null}
 */
export function pickStakingNode(nodes) {
  const valid = nodes.filter((n) => Number.isSafeInteger(n.nodeId) && n.nodeId >= 0);
  const open = valid.filter((n) => !nodeIsFull(n));
  const pool = open.length ? open : valid;
  if (!pool.length) return null;
  const fill = (/** @type {import("./mirror.js").StakingNode} */ n) => (n.maxStake > 0 ? n.stakeRewarded / n.maxStake : 1);
  return [...pool].sort((a, b) => b.rewardRateStart - a.rewardRateStart || fill(a) - fill(b) || a.nodeId - b.nodeId)[0].nodeId;
}

/**
 * Nombre corto de un nodo para la app: «Nodo 3 · Google» (la descripción del mirror, recortada).
 * @param {import("./mirror.js").StakingNode} n @param {import("./i18n.js").Lang} [lang]
 */
export function nodeLabel(n, lang = "es") {
  const word = lang === "en" ? "Node" : "Nodo";
  const d = n.description.replace(/\s+/g, " ").replace(/^hosted (by|for)\s+/i, "").slice(0, 40).trim();
  return d ? `${word} ${n.nodeId} · ${d}` : `${word} ${n.nodeId}`;
}
