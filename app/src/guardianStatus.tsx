// Aviso de emergencia y topes de la beta, tal como los publica el guardián (GET /notice).
//
// Se piden cada minuto y al volver a la app. Lo que llega se limpia otra vez aquí (core/src/notice.js): solo texto,
// sin enlaces, cuentas ni direcciones, aunque el servidor dijera otra cosa. Si el guardián no responde, se mantiene lo
// último que se supo: un fallo de red no quita un aviso de evacuar ni levanta un tope.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { AppState } from "react-native";
import { cleanLimits, cleanNotice, effectiveCap, type BetaLimits, type GuardianNotice } from "@boveda/core";
import { buildMaxVaultHbar, guardianUrl } from "./env";
import { useWallet } from "./wallet";

type GuardianStatusCtx = {
  /** Aviso en vigor (null si no hay o ya se cerró, en el caso de los informativos). */
  notice: GuardianNotice | null;
  limits: BetaLimits;
  /** Cierra un aviso informativo hasta que se reinicie la app. Los de evacuar no se pueden cerrar. */
  dismiss: (id: string) => void;
};

// Sin respuesta del guardián manda el tope de la compilación (en mainnet siempre hay uno).
const NO_LIMITS: BetaLimits = { maxVaultHbar: buildMaxVaultHbar, maxVaults: 0 };
const Ctx = createContext<GuardianStatusCtx>({ notice: null, limits: NO_LIMITS, dismiss: () => {} });
export const useGuardianStatus = () => useContext(Ctx);

async function load(url: string): Promise<{ notice: GuardianNotice | null; limits: BetaLimits } | null> {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8000);
    const res = await fetch(`${url}/notice`, { signal: ac.signal }).finally(() => clearTimeout(timer));
    if (!res.ok) return null;
    const body = (await res.json()) as { notice?: unknown; limits?: unknown };
    return { notice: cleanNotice(body?.notice), limits: cleanLimits(body?.limits) };
  } catch {
    return null;
  }
}

export function GuardianStatusProvider({ children }: { children: React.ReactNode }) {
  const { profile } = useWallet();
  const url = guardianUrl() ?? profile?.guardian?.url ?? null;
  const [notice, setNotice] = useState<GuardianNotice | null>(null);
  const [limits, setLimits] = useState<BetaLimits>(NO_LIMITS);
  const [dismissed, setDismissed] = useState<string[]>([]);

  useEffect(() => {
    if (!url) return;
    let alive = true;
    const tick = () =>
      void load(url).then((r) => {
        if (!alive || !r) return;
        setNotice((old) => (old?.id === r.notice?.id ? old : r.notice));
        // El tope que se aplica es el más bajo entre el de la compilación y el del guardián.
        const next = { ...r.limits, maxVaultHbar: effectiveCap(buildMaxVaultHbar, r.limits.maxVaultHbar) };
        setLimits((old) => (old.maxVaultHbar === next.maxVaultHbar && old.maxVaults === next.maxVaults ? old : next));
      });
    tick();
    let timer = setInterval(tick, 60_000);
    const sub = AppState.addEventListener("change", (s) => {
      clearInterval(timer);
      if (s === "active") {
        tick();
        timer = setInterval(tick, 60_000);
      }
    });
    return () => {
      alive = false;
      clearInterval(timer);
      sub.remove();
    };
  }, [url]);

  const dismiss = useCallback((id: string) => setDismissed((d) => (d.includes(id) ? d : [...d, id])), []);
  const visible = notice && (notice.level === "evacuar" || !dismissed.includes(notice.id)) ? notice : null;
  const value = useMemo(() => ({ notice: visible, limits, dismiss }), [visible, limits, dismiss]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
