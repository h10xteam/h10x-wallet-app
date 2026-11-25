// @ts-check
// Textos para mostrar una operación de la bóveda (app y avisos del guardián).
import { formatHbar, formatUnits } from "./format.js";
import { coreLanguage, tr } from "./i18n.js";


/**
 * "10 HBAR + 5 SAUCE + NFT Gatos #12".
 * @param {{ tinybars: bigint, tokens: { tokenId: string, amount: bigint }[], nfts?: { tokenId: string, serial: number }[] }} a
 * @param {(tokenId: string) => import("./mirror.js").TokenInfo | null | undefined} meta @param {import("./i18n.js").Lang} [lang]
 */
export function assetsText(a, meta, lang = coreLanguage()) {
  const parts = [];
  if (a.tinybars > 0n) parts.push(`${formatHbar(a.tinybars, 4, lang)} HBAR`);
  for (const t of a.tokens) {
    const m = meta(t.tokenId);
    parts.push(m ? `${formatUnits(t.amount, m.decimals, 4, lang)} ${m.symbol}` : `${t.amount.toString()} × ${t.tokenId}`);
  }
  const nfts = a.nfts ?? [];
  if (nfts.length > 3) parts.push(`${nfts.length} NFT`);
  else for (const n of nfts) parts.push(`NFT ${meta(n.tokenId)?.name || n.tokenId} #${n.serial}`);
  return parts.join(" + ") || "0 HBAR";
}

/**
 * Título, destino y comisión de una operación de la bóveda.
 * @param {import("./mirror.js").ScheduleAction} action
 * @param {{ lane?: "withdraw" | "recovery", meta?: (tokenId: string) => import("./mirror.js").TokenInfo | null | undefined, lang?: import("./i18n.js").Lang }} [opts]
 * @returns {{ title: string, detail: string, fee: string | null, unusual: boolean }}
 */
export function summarizeAction(action, { lane = "withdraw", meta = () => null, lang = coreLanguage() } = {}) {
  const recovery = lane === "recovery";
  if (action.kind === "transfer") {
    const what = assetsText(action, meta, lang);
    const extra = action.extra.map((e) => tr(`y ${formatHbar(e.tinybars, 4, lang)} HBAR a ${e.to}`, `and ${formatHbar(e.tinybars, 4, lang)} HBAR to ${e.to}`, lang));
    return {
      title: recovery ? tr(`Recuperación de ${what}`, `Recovery of ${what}`, lang) : tr(`Retirada de ${what}`, `Withdrawal of ${what}`, lang),
      detail: [tr(`a ${action.to}`, `to ${action.to}`, lang), ...extra].join(" "),
      fee: action.fee ? tr(`Comisión del servicio: ${formatHbar(action.fee.tinybars, 4, lang)} HBAR`, `Service fee: ${formatHbar(action.fee.tinybars, 4, lang)} HBAR`, lang) : null,
      unusual: action.extra.length > 0,
    };
  }
  if (action.kind === "staking") {
    const detail = tr("Los HBAR no salen de la bóveda; las recompensas llegan a ella.", "The HBAR never leave the vault; rewards arrive in it.", lang);
    if (action.nodeId == null) return { title: tr("Desactivar el rendimiento (staking)", "Turn off yield (staking)", lang), detail: "", fee: null, unusual: false };
    return {
      title: tr(`Rendimiento: staking en el nodo ${action.nodeId}`, `Yield: staking on node ${action.nodeId}`, lang),
      detail,
      fee: null,
      // Rechazar las recompensas no tiene sentido en una bóveda: la app nunca lo pide.
      unusual: action.declineReward === true,
    };
  }
  if (action.kind === "settings") {
    if (action.autoAssociations === -1) return { title: tr("Activar tokens en la bóveda", "Enable tokens in the vault", lang), detail: "", fee: null, unusual: false };
    return { title: tr("Cambio de ajustes de la bóveda", "Vault settings change", lang), detail: "", fee: null, unusual: true };
  }
  if (action.kind === "keyChange") return { title: tr("Cambio de llaves de la bóveda", "Vault key change", lang), detail: "", fee: null, unusual: true };
  return { title: recovery ? tr("Recuperación", "Recovery", lang) : tr("Operación desconocida", "Unknown operation", lang), detail: "", fee: null, unusual: true };
}

/** Ids de token que aparecen en una operación. @param {import("./mirror.js").ScheduleAction} action */
export const actionTokenIds = (action) =>
  action.kind === "transfer" ? [...new Set([...action.tokens.map((t) => t.tokenId), ...(action.nfts ?? []).map((n) => n.tokenId)])] : [];

/**
 * ¿Puede ir esta operación por el carril de retirada (el del móvil)? La app solo pide por ahí
 * transferencias, activar los tokens y el staking de la propia bóveda. Cualquier otra cosa (cambiar
 * llaves, ajustes de seguridad, mandar las recompensas a otra cuenta…) no la ha pedido la app: el
 * guardián la bloquea en cuanto la ve.
 * @param {import("./mirror.js").ScheduleAction} action @param {string} vaultId
 * @returns {boolean}
 */
export function allowedInWithdrawLane(action, vaultId) {
  if (action.kind === "transfer") return true;
  if (action.kind === "settings") return action.account === vaultId && action.autoAssociations === -1;
  if (action.kind === "staking") return action.account === vaultId && action.declineReward !== true;
  return false;
}
