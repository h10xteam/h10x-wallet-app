// Navegador interno: la dApp se abre dentro de H10X Wallet, como en HashPack. Solo se navega por los dominios
// de la lista; cualquier otro enlace sale a Safari. La dApp conecta con el protocolo de HashPack y de
// las extensiones de Hedera, y H10X Wallet pide permiso en su propia hoja (y Face ID para cada firma).
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { WebView, type WebViewMessageEvent, type WebViewNavigation } from "react-native-webview";
import type { ShouldStartLoadRequest, WebViewOpenWindowEvent } from "react-native-webview/lib/WebViewTypes";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Clipboard from "expo-clipboard";
import * as Crypto from "expo-crypto";
import { DAPPS, browserBridgeScript, browserDecision, dappForUrl, hostOf, parseBridgeMessage } from "@boveda/core";
import { Backdrop, Button, Card, Icon, P } from "../ui";
import { colors, radius, space } from "../theme";
import { useWallet } from "../wallet";
import { WALLET_META, isWcUri, useDapps } from "../walletconnect";
import { t } from "../i18n";
import { confirm, haptic, open, run } from "../helpers";

/** El navegador decide cada carga por su cuenta (browserDecision); sin esto, la librería abriría sola otros esquemas. */
const ALL_ORIGINS = ["*"];

// Los tipos de react-native-webview ponen `P = undefined` por defecto (y `Props & undefined` es `never`).
type Web = WebView<{}>;

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

type Nav = { url: string; canGoBack: boolean; canGoForward: boolean; loading: boolean };

/** `path`: parte que se añade a la web de la dApp al abrirla (p. ej. "/#dao"); solo la que empieza por / o #. */
export function DappBrowser({ dappId, path, onClose }: { dappId: string; path?: string; onClose: () => void }) {
  const dapp = DAPPS.find((d) => d.id === dappId) ?? DAPPS[0];
  const startUrl = path && /^[/#][\w/#?=&.-]*$/.test(path) ? `${dapp.url.replace(/\/$/, "")}${path}` : dapp.url;
  const start = { ...dapp, url: startUrl };
  const insets = useSafeAreaInsets();
  const { status, sessions, pair, disconnect } = useDapps();
  const { profile } = useWallet();
  const web = useRef<Web>(null);
  // Código secreto de esta apertura: solo el script que inyecta H10X Wallet lo conoce.
  const token = useMemo(() => toHex(Crypto.getRandomBytes(16)), []);
  const script = useMemo(() => browserBridgeScript({ token, wallet: WALLET_META }), [token]);
  const [nav, setNav] = useState<Nav>({ url: start.url, canGoBack: false, canGoForward: false, loading: true });
  const navUrl = useRef(start.url);
  const [progress, setProgress] = useState(0);
  const [failed, setFailed] = useState<string | null>(null);
  const [tipHidden, setTipHidden] = useState(false);
  const schemeWarned = useRef(false);

  const page = dappForUrl(nav.url) ?? start;
  const host = hostOf(nav.url) ?? start.domains[0];
  const session = sessions.find((s) => s.dapp.id === page.id) ?? null;
  const account = profile?.pocket.accountId ?? null;

  // Si la dApp pide conectar nada más cargar y WalletConnect aún arranca, se espera a que esté listo.
  const pending = useRef<{ uri: string; openedFrom?: string } | null>(null);
  const warned = useRef(false);
  const connect = useCallback(
    (uri: string, opts: { openedFrom?: string; explicit?: boolean } = {}) => {
      const problem = !account
        ? t("Tu Cartera todavía no existe en la red: recibe algo de HBAR primero.", "Your Wallet doesn't exist on the network yet: receive some HBAR first.")
        : status === "off"
          ? t("WalletConnect no está configurado en esta versión de la app.", "WalletConnect isn't configured in this build of the app.")
          : status === "error"
            ? t("WalletConnect no ha podido arrancar. Cierra y vuelve a abrir H10X Wallet.", "WalletConnect couldn't start. Close and reopen H10X Wallet.")
            : null;
      if (problem) {
        // Una dApp que intenta conectar sola en cada carga no debe llenar la pantalla de avisos.
        if (opts.explicit || !warned.current) Alert.alert(t("No se puede conectar", "Can't connect"), problem);
        warned.current = true;
        return;
      }
      if (status !== "ready") {
        pending.current = { uri, openedFrom: opts.openedFrom };
        return;
      }
      haptic.tap();
      void run(t("No se pudo conectar", "Could not connect"), () => pair(uri, opts.openedFrom ? { openedFrom: opts.openedFrom } : undefined));
    },
    [account, pair, status],
  );
  useEffect(() => {
    const p = pending.current;
    if (status === "ready" && p) {
      pending.current = null;
      connect(p.uri, { openedFrom: p.openedFrom });
    }
  }, [status, connect]);

  // Una sola pregunta a la vez: una web no puede llenar la pantalla de avisos abriendo enlaces.
  const asking = useRef(false);
  const leave = useCallback(async (url: string) => {
    if (asking.current) return;
    asking.current = true;
    try {
      const where = hostOf(url) ?? url.replace(/^mailto:/i, "");
      const ok = await confirm(
        t("Salir de H10X Wallet", "Leave H10X Wallet"),
        t(`${where} no está en la lista de dApps. Se abrirá fuera de H10X Wallet.`, `${where} isn't on the dApp list. It will open outside H10X Wallet.`),
        t("Abrir fuera", "Open outside"),
      );
      if (ok) open(url);
    } finally {
      asking.current = false;
    }
  }, []);

  /** Cada carga (de la página o de sus iframes) pasa por aquí antes de empezar. */
  const onShouldStart = useCallback(
    (req: ShouldStartLoadRequest) => {
      const d = browserDecision({ url: req.url, isTopFrame: req.isTopFrame !== false });
      if (d.action === "allow") return true;
      if (d.action === "external") void leave(d.url);
      // La web intenta abrir otra cartera sin enlace de conexión: se explica una vez qué elegir.
      if (d.action === "block" && d.reason === "scheme" && req.isTopFrame !== false && !schemeWarned.current) {
        const app = /^([a-z][a-z0-9+.-]*):\/\//i.exec(req.url)?.[1];
        if (app && !/^(https?|about|data|blob|javascript|itms-apps?|tel|sms)$/i.test(app)) {
          schemeWarned.current = true;
          Alert.alert(
            t("Aquí la cartera es H10X Wallet", "Here the wallet is H10X Wallet"),
            t(
              `La web ha intentado abrir otra app (${app}). Para conectar H10X Wallet, en «Connect» elige «HashPack» (sale como detectada) o una cartera de la lista de WalletConnect. Si te enseña un enlace, cópialo y pulsa «Sin conectar» → «Pegar enlace».`,
              `The site tried to open another app (${app}). To connect H10X Wallet, under “Connect” choose “HashPack” (it shows as detected) or a wallet from the WalletConnect list. If it shows a link, copy it and tap “Not connected” → “Paste link”.`,
            ),
          );
        }
      }
      // Enlace de conexión al elegir una cartera en la dApp: se conecta H10X Wallet. No vale como prueba del
      // dominio (pudo lanzarlo un iframe), así que decide WalletConnect Verify, como con un QR.
      if (d.action === "pair") connect(d.uri, { explicit: true });
      return false;
    },
    [connect, leave],
  );

  /** window.open / target=_blank: lo de la lista en esta misma pestaña; lo demás, igual que arriba. */
  const onOpenWindow = useCallback(
    ({ nativeEvent }: WebViewOpenWindowEvent) => {
      const url = nativeEvent.targetUrl;
      const d = browserDecision({ url, isTopFrame: true });
      if (d.action === "allow") web.current?.injectJavaScript(`window.location.href = ${JSON.stringify(url)}; true;`);
      else if (d.action === "external") void leave(d.url);
      else if (d.action === "pair") connect(d.uri, { explicit: true });
    },
    [connect, leave],
  );

  /** Aviso del script inyectado: solo con el código secreto y desde la página de una dApp de la lista. */
  const onMessage = useCallback(
    ({ nativeEvent }: WebViewMessageEvent) => {
      const msg = parseBridgeMessage(nativeEvent.data, token);
      if (!msg) return;
      const from = dappForUrl(nativeEvent.url);
      const current = dappForUrl(navUrl.current);
      if (!from || !current || from.id !== current.id) return;
      connect(msg.uri, { openedFrom: from.id, explicit: msg.via === "hashconnect" });
    },
    [connect, token],
  );

  const onNav = useCallback((s: WebViewNavigation) => {
    navUrl.current = s.url;
    setNav({ url: s.url, canGoBack: s.canGoBack, canGoForward: s.canGoForward, loading: s.loading });
    if (!s.loading) setFailed(null);
  }, []);

  const onChip = () => {
    haptic.tap();
    if (session) {
      Alert.alert(
        t(`Conectada a ${page.name}`, `Connected to ${page.name}`),
        t(`${page.name} ve tu Cartera (${account ?? "—"}) y puede pedirte firmas. Cada una la apruebas con Face ID.`, `${page.name} sees your Wallet (${account ?? "—"}) and can ask you for signatures. You approve each one with Face ID.`),
        [
          { text: t("Cerrar", "Close"), style: "cancel" },
          { text: t("Desconectar", "Disconnect"), style: "destructive", onPress: () => void disconnect(session.topic).then(() => web.current?.reload()) },
        ],
      );
      return;
    }
    Alert.alert(
      t("Conectar H10X Wallet", "Connect H10X Wallet"),
      t(
        "En la web, pulsa «Connect wallet» y elige HashPack o WalletConnect: H10X Wallet te pedirá permiso aquí mismo. Si la dApp te enseña un enlace de WalletConnect, cópialo y pulsa «Pegar enlace».",
        "On the site, tap “Connect wallet” and choose HashPack or WalletConnect: H10X Wallet will ask for your permission right here. If the dApp shows a WalletConnect link, copy it and tap “Paste link”.",
      ),
      [
        { text: t("Entendido", "Got it"), style: "cancel" },
        {
          text: t("Pegar enlace", "Paste link"),
          onPress: () =>
            void (async () => {
              const text = (await Clipboard.getStringAsync()).trim();
              if (!isWcUri(text)) {
                Alert.alert(t("No hay enlace", "No link"), t("En el portapapeles no hay un enlace de WalletConnect.", "There's no WalletConnect link on the clipboard."));
                return;
              }
              connect(text, { explicit: true });
            })(),
        },
      ],
    );
  };

  return (
    <Backdrop>
      <View style={{ paddingTop: insets.top }}>
        <View style={styles.bar}>
          <IconButton icon="xmark" label={t("Cerrar", "Close")} onPress={onClose} />
          <View style={styles.titleBox}>
            <Text style={styles.title} numberOfLines={1}>
              {page.name}
            </Text>
            <View style={styles.hostRow}>
              <Icon name="lock.fill" size={10} color={colors.safe} />
              <Text style={styles.host} numberOfLines={1}>
                {host}
              </Text>
            </View>
          </View>
          <IconButton icon="safari" label={t("Abrir en Safari", "Open in Safari")} onPress={() => open(nav.url)} />
        </View>
        <View style={styles.strip}>
          <Pressable onPress={onChip} accessibilityRole="button" style={({ pressed }) => [styles.chip, session ? styles.chipOn : null, pressed ? { opacity: 0.7 } : null]}>
            <View style={[styles.dot, session ? { backgroundColor: colors.safe } : styles.dotOff]} />
            <Text style={[styles.chipText, session ? { color: colors.safe } : null]} numberOfLines={1}>
              {session ? t(`Conectada · ${account ?? ""}`, `Connected · ${account ?? ""}`) : t("Sin conectar", "Not connected")}
            </Text>
          </Pressable>
          <View style={{ flex: 1 }} />
          <IconButton icon="chevron.left" label={t("Atrás", "Back")} disabled={!nav.canGoBack} onPress={() => web.current?.goBack()} small />
          <IconButton icon="chevron.right" label={t("Adelante", "Forward")} disabled={!nav.canGoForward} onPress={() => web.current?.goForward()} small />
          <IconButton icon="arrow.clockwise" label={t("Recargar", "Reload")} onPress={() => web.current?.reload()} small />
        </View>
        {!session && !tipHidden && !failed ? (
          <View style={styles.tip}>
            <Icon name="info.circle.fill" size={14} color={colors.brass} />
            <Text style={styles.tipText}>
              {t(
                "Para conectar, pulsa «Connect» en la web y elige «HashPack» (sale como detectada: es H10X Wallet) o cualquier cartera de WalletConnect.",
                "To connect, tap “Connect” on the site and choose “HashPack” (it shows as detected: it's H10X Wallet) or any WalletConnect wallet.",
              )}
            </Text>
            <Pressable onPress={() => setTipHidden(true)} hitSlop={10} accessibilityRole="button" accessibilityLabel={t("Ocultar", "Hide")}>
              <Icon name="xmark" size={12} color={colors.muted} />
            </Pressable>
          </View>
        ) : null}
        <View style={styles.progressTrack}>{nav.loading && progress < 1 ? <View style={[styles.progress, { width: `${Math.max(8, progress * 100)}%` }]} /> : null}</View>
      </View>

      {failed ? (
        <View style={{ flex: 1, padding: space.l, paddingBottom: insets.bottom + space.l }}>
          <Card tone="warn">
            <P>{t(`No se pudo abrir ${page.name}.`, `${page.name} could not be opened.`)}</P>
            <P muted style={{ marginBottom: 0 }}>{failed}</P>
          </Card>
          <Button
            title={t("Reintentar", "Try again")}
            icon="arrow.clockwise"
            onPress={() => {
              setFailed(null);
              web.current?.reload();
            }}
          />
        </View>
      ) : null}
      <WebView<{}>
        ref={web}
        source={{ uri: start.url }}
        style={[styles.web, failed ? styles.hidden : null]}
        containerStyle={failed ? styles.hidden : undefined}
        originWhitelist={ALL_ORIGINS}
        injectedJavaScriptBeforeContentLoaded={script}
        injectedJavaScriptBeforeContentLoadedForMainFrameOnly
        onMessage={onMessage}
        onShouldStartLoadWithRequest={onShouldStart}
        onOpenWindow={onOpenWindow}
        onNavigationStateChange={onNav}
        onLoadProgress={({ nativeEvent }) => setProgress(nativeEvent.progress)}
        onError={({ nativeEvent }) => setFailed(nativeEvent.description || t("Sin conexión.", "No connection."))}
        applicationNameForUserAgent="H10XWallet/1.0"
        allowsBackForwardNavigationGestures
        pullToRefreshEnabled
        allowsInlineMediaPlayback
        dataDetectorTypes="none"
        decelerationRate="normal"
        allowsLinkPreview={false}
        keyboardDisplayRequiresUserAction={false}
        fraudulentWebsiteWarningEnabled
      />
    </Backdrop>
  );
}

function IconButton({ icon, label, onPress, disabled, small }: { icon: React.ComponentProps<typeof Icon>["name"]; label: string; onPress: () => void; disabled?: boolean; small?: boolean }) {
  return (
    <Pressable
      onPress={() => {
        haptic.tap();
        onPress();
      }}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [small ? styles.iconSmall : styles.icon, pressed ? { backgroundColor: colors.surfaceStrong } : null, disabled ? { opacity: 0.3 } : null]}
    >
      <Icon name={icon} size={small ? 15 : 16} color={colors.text} weight="semibold" />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", paddingHorizontal: space.m, paddingVertical: space.s, gap: space.s },
  titleBox: { flex: 1, alignItems: "center" },
  title: { color: colors.text, fontSize: 16, fontWeight: "600" },
  hostRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2 },
  host: { color: colors.muted, fontSize: 12 },
  icon: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface },
  iconSmall: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  strip: { flexDirection: "row", alignItems: "center", paddingHorizontal: space.m, paddingBottom: space.s, gap: 2 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: space.m,
    height: 30,
    borderRadius: radius.l,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
    backgroundColor: colors.surface,
    maxWidth: "62%",
  },
  chipOn: { backgroundColor: colors.safeSoft, borderColor: colors.safeLine },
  chipText: { color: colors.muted, fontSize: 13, fontWeight: "600", fontVariant: ["tabular-nums"] },
  dot: { width: 7, height: 7, borderRadius: 4 },
  dotOff: { borderWidth: 1.5, borderColor: colors.muted },
  tip: { flexDirection: "row", alignItems: "flex-start", gap: space.s, paddingHorizontal: space.m, paddingVertical: space.s, backgroundColor: colors.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.hairline },
  tipText: { flex: 1, color: colors.muted, fontSize: 12, lineHeight: 16 },
  progressTrack: { height: 2, backgroundColor: colors.hairline },
  progress: { height: 2, backgroundColor: colors.brass },
  web: { flex: 1, backgroundColor: colors.steelBottom },
  hidden: { display: "none" },
});
