import { useEffect, useState } from "react";
import * as ScreenCapture from "expo-screen-capture";
import { Alert, Linking } from "react-native";
import * as Haptics from "expo-haptics";
import { NETWORKS, nowSeconds } from "@boveda/core";
import { NETWORK } from "./env";
import { t } from "./i18n";

/** Ejecuta una acción y, si falla, lo explica en un aviso. */
export async function run<T>(what: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/cancel/i.test(msg)) return undefined; // Face ID cancelado
    haptic.error();
    Alert.alert(what, msg);
    return undefined;
  }
}

/** Confirmación con dos botones. */
export function confirm(title: string, message: string, ok = t("Confirmar", "Confirm"), destructive = false): Promise<boolean> {
  return new Promise((resolve) =>
    Alert.alert(title, message, [
      { text: t("Cancelar", "Cancel"), style: "cancel", onPress: () => resolve(false) },
      { text: ok, style: destructive ? "destructive" : "default", onPress: () => resolve(true) },
    ]),
  );
}

/** Reloj que se actualiza cada segundo (para las cuentas atrás). */
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(nowSeconds());
  useEffect(() => {
    const t = setInterval(() => setNow(nowSeconds()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** "0.0.5@1794479350.965951975" → enlace de HashScan. */
export function txLink(txId: string) {
  const [account, ts] = txId.split("@");
  const [s, n] = (ts ?? "").split(".");
  return `${NETWORKS[NETWORK].hashscan}/transaction/${account}-${s}-${n}`;
}

export const accountLink = (id: string) => `${NETWORKS[NETWORK].hashscan}/account/${id}`;

export const open = (url: string) => void Linking.openURL(url);

/** Respuesta háptica (vibraciones suaves de iOS). Nunca rompe nada si no está disponible. */
export const haptic = {
  tap: () => void Haptics.selectionAsync().catch(() => undefined),
  success: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined),
  warn: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined),
  error: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined),
};

/**
 * Pantallas con las 24 palabras: difuminadas en el selector de apps y con aviso si se hace una captura.
 * Donde se escriben las palabras (rescate, evacuar…) tampoco se deja grabar ni capturar. Donde se enseñan al crear el
 * kit (`allowScreenshots`), el dueño decidió permitir la captura para pasarla a papel: se deja, con un aviso.
 */
export function useProtectSecrets({ allowScreenshots = false }: { allowScreenshots?: boolean } = {}) {
  useEffect(() => {
    let sub: { remove: () => void } | null = null;
    if (!allowScreenshots) void ScreenCapture.preventScreenCaptureAsync("hvault-palabras").catch(() => undefined);
    void ScreenCapture.enableAppSwitcherProtectionAsync(0.9).catch(() => undefined);
    try {
      sub = ScreenCapture.addScreenshotListener(() =>
        Alert.alert(
          t("Captura de pantalla", "Screenshot"),
          allowScreenshots
            ? t(
                "Esa captura tiene tu kit y ahora está en este móvil (y en la nube si tienes Fotos de iCloud o Google Fotos). Con el móvil y el kit juntos se vacía la bóveda al momento. Pásala a papel o a otro dispositivo y bórrala de Fotos y de «Eliminado».",
                "That screenshot has your kit and it's now on this phone (and in the cloud if you use iCloud Photos or Google Photos). With the phone and the kit together the vault can be emptied instantly. Copy it to paper or another device and delete it from Photos and from “Recently Deleted”.",
              )
            : t(
                "Acabas de hacer una captura donde pueden salir tus 24 palabras. Bórrala de Fotos y de «Eliminado»: cualquiera que la vea (o una copia en la nube) puede usar tu kit.",
                "You just took a screenshot that may show your 24 words. Delete it from Photos and from “Recently Deleted”: anyone who sees it (or a cloud copy) can use your kit.",
              ),
        ),
      );
    } catch {
      // sin el módulo (p. ej. en la web): nada que hacer
    }
    return () => {
      if (!allowScreenshots) void ScreenCapture.allowScreenCaptureAsync("hvault-palabras").catch(() => undefined);
      void ScreenCapture.disableAppSwitcherProtectionAsync().catch(() => undefined);
      sub?.remove();
    };
  }, [allowScreenshots]);
}
