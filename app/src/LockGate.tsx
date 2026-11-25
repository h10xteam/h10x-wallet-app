// Bloqueo de la app con Face ID (o el código del iPhone si Face ID falla o no está).
// - Al abrir la app y al volver a ella tras más de 30 s fuera.
// - En el selector de apps de iOS se tapa el contenido (para que no se vean saldos).
import React, { useCallback, useEffect, useRef, useState } from "react";
import { AppState, StyleSheet, Text, View } from "react-native";
import * as LocalAuthentication from "expo-local-authentication";
import { Backdrop, Button, P } from "./ui";
import { H10XMark, VaultDial } from "./components/VaultDial";
import { colors, space, typeface } from "./theme";
import { t } from "./i18n";

const GRACE_MS = 30_000;

/**
 * Desbloqueada en esta sesión (0.10). Al cambiar de wallet la app se monta de nuevo (también este bloqueo): sin esto,
 * pediría Face ID otra vez. Vuelve a false cuando la app pasa más de 30 s fuera.
 */
let unlockedSession = false;

/** ¿Puede este iPhone pedir Face ID o código? Sin código configurado, no se bloquea (no habría forma de entrar). */
export async function canLock(): Promise<boolean> {
  try {
    return (await LocalAuthentication.getEnrolledLevelAsync()) > LocalAuthentication.SecurityLevel.NONE;
  } catch {
    return false;
  }
}

/** Pide Face ID. Devuelve true si la persona se identifica. */
export async function authenticate(reason: string): Promise<boolean> {
  try {
    const r = await LocalAuthentication.authenticateAsync({ promptMessage: reason, cancelLabel: t("Cancelar", "Cancel"), disableDeviceFallback: false });
    return r.success;
  } catch {
    return false;
  }
}

/**
 * La pantalla de bloqueo va ENCIMA de la app, sin desmontarla: al volver (p. ej. tras apuntar el kit con el móvil
 * bloqueado) cada pantalla sigue donde estaba. Antes se desmontaba y se perdía lo que hubiera en pantalla, incluidas
 * las 24 palabras recién creadas. `unlockedOnly` (avisos de dApps) solo se monta con la app abierta.
 */
export function LockGate({ enabled, children, unlockedOnly }: { enabled: boolean; children: React.ReactNode; unlockedOnly?: React.ReactNode }) {
  const [locked, setLocked] = useState(enabled && !unlockedSession);
  const [covered, setCovered] = useState(false);
  const [checking, setChecking] = useState(false);
  const leftAt = useRef<number | null>(null);
  const prompting = useRef(false);

  const unlock = useCallback(async () => {
    if (prompting.current) return;
    prompting.current = true;
    setChecking(true);
    try {
      if (!(await canLock()) || (await authenticate(t("Desbloquear H10X Wallet", "Unlock H10X Wallet")))) {
        unlockedSession = true;
        setLocked(false);
      }
    } finally {
      prompting.current = false;
      setChecking(false);
    }
  }, []);

  // Al activar el bloqueo en Ajustes no se bloquea en el acto; al desactivarlo, se abre.
  useEffect(() => {
    if (!enabled) setLocked(false);
  }, [enabled]);

  useEffect(() => {
    if (locked) void unlock();
  }, [locked, unlock]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      // El aviso de Face ID pone la app en "inactive": no hay que tapar ni contar por eso.
      if (prompting.current) return;
      if (s === "active") {
        setCovered(false);
        if (enabled && leftAt.current != null && Date.now() - leftAt.current > GRACE_MS) {
          unlockedSession = false;
          setLocked(true);
        }
        leftAt.current = null;
      } else {
        if (enabled) setCovered(true);
        if (s === "background" && leftAt.current == null) leftAt.current = Date.now();
      }
    });
    return () => sub.remove();
  }, [enabled]);

  const showLock = enabled && locked;
  return (
    <View style={{ flex: 1 }}>
      <View
        style={{ flex: 1 }}
        pointerEvents={showLock ? "none" : "auto"}
        accessibilityElementsHidden={showLock}
        importantForAccessibility={showLock ? "no-hide-descendants" : "auto"}
      >
        {children}
      </View>
      {showLock ? (
        <View style={StyleSheet.absoluteFill}>
          <Backdrop>
            <View style={styles.center}>
              <VaultDial fraction={0.75} size={220} center={<H10XMark width={104} />} />
              <Text style={[styles.name, typeface.display ? { fontFamily: typeface.displayBold, fontWeight: undefined } : null]}>H10X Wallet</Text>
              <P muted center style={{ marginBottom: space.xl }}>
                {t("Bloqueada. Usa Face ID para entrar.", "Locked. Use Face ID to get in.")}
              </P>
              <Button title={t("Desbloquear", "Unlock")} icon="faceid" busy={checking} onPress={() => void unlock()} style={{ alignSelf: "stretch" }} />
            </View>
          </Backdrop>
        </View>
      ) : (
        <>
          {unlockedOnly}
          {covered ? (
            <View style={StyleSheet.absoluteFill} pointerEvents="none">
              <Backdrop>
                <View style={styles.center}>
                  <H10XMark width={150} />
                </View>
              </Backdrop>
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl },
  name: { color: colors.text, fontSize: 34, fontWeight: "700", marginTop: space.l, marginBottom: space.s, letterSpacing: 0.5 },
});
