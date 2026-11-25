// dApps por WalletConnect: las de la lista (con navegador interno), otras con su QR o enlace (con aviso), sesiones
// activas y la hoja que enseña cada petición.
import React, { useRef, useState } from "react";
import { Modal, ScrollView, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { CameraView, useCameraPermissions } from "expo-camera";
import { SafeAreaView } from "react-native-safe-area-context";
import { dappsFor, hostOf } from "@boveda/core";
import { NETWORK } from "../env";
import { Backdrop, Badge, Button, Card, Group, H2, Icon, ListRow, Mono, P, Screen, SectionTitle } from "../ui";
import { colors, radius, space } from "../theme";
import { useWallet } from "../wallet";
import { isWcUri, useDapps, type DappVia, type Prompt } from "../walletconnect";
import { t, when } from "../i18n";
import { confirm, haptic, run } from "../helpers";

const describeDapp = (id: string) =>
  ({
    saucerswap: t("Intercambia tokens y aporta liquidez.", "Swap tokens and provide liquidity."),
    sentx: t("Compra y vende NFT.", "Buy and sell NFTs."),
    hsuite: t("DeFi y herramientas de Hedera.", "Hedera DeFi and tools."),
    hashpack: t("Portal de HashPack.", "HashPack portal."),
    kabila: t("Mercado y herramientas de NFT.", "NFT market and tools."),
  })[id] ?? "";

/** Texto corto de cómo se comprobó el dominio de una dApp conectada. */
export const viaText = (verified: boolean, via: DappVia) =>
  via === "browser" ? t("Abierta en H10X Wallet", "Opened in H10X Wallet") : verified ? t("Dominio verificado", "Verified domain") : t("Dominio sin verificar", "Unverified domain");

export function DappsHome({ footer, onScan, onOpen }: { footer: React.ReactNode; onScan: () => void; onOpen: (dappId: string) => void }) {
  const { status, error, sessions, pair, disconnect } = useDapps();
  const { profile } = useWallet();
  const [busy, setBusy] = useState(false);
  const paste = () =>
    void run(t("No se pudo conectar", "Could not connect"), async () => {
      const text = (await Clipboard.getStringAsync()).trim();
      if (!isWcUri(text)) throw new Error(t("En el portapapeles no hay un enlace de WalletConnect. En la dApp, elige WalletConnect y pulsa «Copiar enlace».", "There's no WalletConnect link on the clipboard. In the dApp, choose WalletConnect and tap “Copy link”."));
      setBusy(true);
      try {
        await pair(text);
      } finally {
        setBusy(false);
      }
    });

  return (
    <Screen title="dApps" footer={footer}>
      <Card tone="brass">
        <P style={{ marginBottom: 0 }}>
          {t(
            "Pulsa una dApp para abrirla dentro de H10X Wallet. Otras dApps de Hedera se conectan con su código QR o su enlace, con aviso si no están en la lista. Siempre solo tu Cartera (nunca la bóveda), y cada operación se enseña antes de firmarla con Face ID.",
            "Tap a dApp to open it inside H10X Wallet. Other Hedera dApps connect with their QR code or link, with a warning if they're not on the list. Always only your Wallet (never the vault), and every operation is shown before you sign it with Face ID.",
          )}
        </P>
      </Card>

      {status === "off" ? (
        <Card tone="warn">
          <P style={{ marginBottom: 0 }}>
            {t(
              "WalletConnect aún no está configurado en esta versión de la app (falta el ID de proyecto de Reown).",
              "WalletConnect isn't configured in this build of the app yet (the Reown project ID is missing).",
            )}
          </P>
        </Card>
      ) : null}
      {status === "error" ? (
        <Card tone="danger">
          <P style={{ marginBottom: 0 }}>{t(`No se pudo arrancar WalletConnect: ${error}`, `WalletConnect could not start: ${error}`)}</P>
        </Card>
      ) : null}
      {!profile?.pocket.accountId ? (
        <Card tone="warn">
          <P style={{ marginBottom: 0 }}>{t("Tu Cartera todavía no existe en la red: recibe algo de HBAR primero.", "Your Wallet doesn't exist on the network yet: receive some HBAR first.")}</P>
        </Card>
      ) : null}

      <SectionTitle>{t("dApps conocidas", "Known dApps")}</SectionTitle>
      <Group>
        {dappsFor(NETWORK).map((d) => {
          const on = sessions.some((s) => s.dapp.id === d.id);
          return (
            <ListRow
              key={d.id}
              icon="globe"
              iconColor={colors.link}
              title={d.name}
              subtitle={`${describeDapp(d.id)} ${d.domains[0]}`}
              right={on ? <Badge text={t("Conectada", "Connected")} tone="accent" /> : undefined}
              onPress={() => onOpen(d.id)}
            />
          );
        })}
      </Group>

      <SectionTitle>{t("Conectar desde otro dispositivo", "Connect from another device")}</SectionTitle>
      <P muted>
        {t(
          "¿Usas la dApp en el ordenador? Pulsa «Connect wallet», elige WalletConnect y escanea el código con H10X Wallet. Si tienes el enlace de WalletConnect copiado, pulsa «Pegar enlace». Sirve también para dApps que no están en la lista.",
          "Using the dApp on a computer? Tap “Connect wallet”, choose WalletConnect and scan the code with H10X Wallet. If you've copied the WalletConnect link, tap “Paste link”. It also works for dApps that aren't on the list.",
        )}
      </P>
      <Button title={t("Escanear código QR", "Scan QR code")} icon="qrcode.viewfinder" disabled={status !== "ready"} onPress={onScan} />
      <Button title={t("Pegar enlace", "Paste link")} icon="doc.on.clipboard" kind="secondary" busy={busy} disabled={status !== "ready"} style={{ marginTop: space.s }} onPress={paste} />

      <SectionTitle>{t("Conectadas", "Connected")}</SectionTitle>
      {sessions.length === 0 ? (
        <P muted>{t("No hay ninguna dApp conectada.", "No dApp is connected.")}</P>
      ) : (
        <Group>
          {sessions.map((s) => (
            <ListRow
              key={s.topic}
              icon={s.verified ? "checkmark.seal.fill" : "exclamationmark.triangle.fill"}
              iconColor={s.verified ? colors.safe : colors.warn}
              title={s.dapp.name}
              subtitle={`${s.dapp.unlisted ? `${t("Fuera de la lista", "Not on the list")} · ` : ""}${viaText(s.verified, s.via)} · ${t("hasta", "until")} ${when(s.expiry)}`}
              onPress={s.dapp.unlisted ? undefined : () => onOpen(s.dapp.id)}
              chevron={false}
              right={
                <Button
                  title={t("Desconectar", "Disconnect")}
                  kind="ghost"
                  style={{ minHeight: 32, paddingHorizontal: 0 }}
                  onPress={async () => {
                    if (await confirm(t(`¿Desconectar ${s.dapp.name}?`, `Disconnect ${s.dapp.name}?`), t("Dejará de poder pedirte firmas.", "It will no longer be able to ask you for signatures."), t("Desconectar", "Disconnect"), true)) {
                      await disconnect(s.topic);
                    }
                  }}
                />
              }
            />
          ))}
        </Group>
      )}
    </Screen>
  );
}

/** Escáner del código QR de WalletConnect. */
export function ScanWc({ onBack }: { onBack: () => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const { pair } = useDapps();
  const handled = useRef(false);
  if (!permission) return <Screen onBack={onBack}>{null}</Screen>;
  if (!permission.granted) {
    return (
      <Screen title={t("Escanear", "Scan")} onBack={onBack}>
        <P>{t("H10X Wallet necesita la cámara para leer el código QR de la dApp. Solo se usa mientras estás en esta pantalla.", "H10X Wallet needs the camera to read the dApp's QR code. It's only used while you're on this screen.")}</P>
        <Button title={t("Permitir la cámara", "Allow the camera")} onPress={() => void requestPermission()} />
      </Screen>
    );
  }
  return (
    <Backdrop>
      <SafeAreaView style={{ flex: 1 }}>
        <View style={styles.scanHeader}>
          <Button title={t("Volver", "Back")} kind="ghost" onPress={onBack} style={{ minHeight: 36, alignSelf: "flex-start" }} />
        </View>
        <View style={styles.cameraWrap}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={({ data }) => {
              if (handled.current) return;
              if (!isWcUri(data)) return;
              handled.current = true;
              haptic.success();
              void run(t("No se pudo conectar", "Could not connect"), () => pair(data)).finally(onBack);
            }}
          />
          <View style={styles.frame} pointerEvents="none" />
        </View>
        <P muted center style={{ margin: space.l }}>
          {t("Apunta al código QR de WalletConnect de la dApp.", "Point at the dApp's WalletConnect QR code.")}
        </P>
      </SafeAreaView>
    </Backdrop>
  );
}

/** Hoja que aparece encima de todo cuando una dApp pide algo. */
export function DappPrompt() {
  const { prompt, approve, reject } = useDapps();
  const { profile } = useWallet();
  const [busy, setBusy] = useState(false);
  if (!prompt) return null;
  const go = (fn: (p: Prompt) => Promise<void>, what: string) =>
    void run(what, async () => {
      setBusy(true);
      try {
        await fn(prompt);
      } finally {
        setBusy(false);
      }
    });

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={() => go(reject, "")}>
      <Backdrop>
        <SafeAreaView style={{ flex: 1 }} edges={["top", "bottom", "left", "right"]}>
          <ScrollView contentContainerStyle={{ padding: space.l, paddingBottom: space.xxl }}>
            {prompt.kind === "info" ? (
              <>
                <Icon name="hand.raised.fill" size={34} color={colors.warn} />
                <H2 style={{ fontSize: 24, marginTop: space.m }}>{prompt.title}</H2>
                <P>{prompt.message}</P>
              </>
            ) : prompt.kind === "proposal" ? (
              <>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
                  {prompt.dapp.unlisted ? <Badge text={t("Fuera de la lista", "Not on the list")} tone="warn" /> : null}
                  <Badge text={viaText(prompt.verified, prompt.via)} tone={prompt.verified ? "accent" : "warn"} />
                </View>
                <H2 style={{ fontSize: 26, marginTop: space.m }}>{t(`¿Conectar con ${prompt.dapp.name}?`, `Connect to ${prompt.dapp.name}?`)}</H2>
                <P muted>{hostOf(prompt.proposal.verifyContext?.verified?.origin) ?? hostOf(prompt.proposal.params.proposer.metadata.url) ?? prompt.dapp.domains[0]}</P>
                {prompt.warning ? (
                  <Card tone={prompt.dapp.unlisted && !prompt.verified ? "danger" : "warn"}>
                    <P style={{ marginBottom: 0 }}>{prompt.warning}</P>
                  </Card>
                ) : null}
                <Card>
                  <P>{t(`Verá tu Cartera (${profile?.pocket.accountId ?? "—"}) y podrá pedirte firmas.`, `It will see your Wallet (${profile?.pocket.accountId ?? "—"}) and can ask you for signatures.`)}</P>
                  <P muted style={{ marginBottom: 0 }}>{t("No verá tu bóveda ni podrá mover nada sin que tú lo apruebes con Face ID, una operación cada vez.", "It won't see your vault or move anything unless you approve it with Face ID, one operation at a time.")}</P>
                </Card>
              </>
            ) : (
              <>
                <P muted style={{ marginBottom: space.xs }}>{prompt.dapp.name}</P>
                <H2 style={{ fontSize: 26 }}>{prompt.message != null ? t("Firmar un mensaje", "Sign a message") : (prompt.description?.title ?? "")}</H2>
                {prompt.message != null ? (
                  <>
                    <Card>
                      <Mono>{prompt.message}</Mono>
                    </Card>
                    <P muted>{t("Firmar un mensaje no mueve dinero. Suele servir para iniciar sesión.", "Signing a message doesn't move money. It's usually for signing in.")}</P>
                  </>
                ) : prompt.description ? (
                  <>
                    <Card tone={prompt.description.danger ? "danger" : undefined}>
                      {prompt.description.lines.map((l, i) => (
                        <Text key={i} style={styles.line}>
                          {l}
                        </Text>
                      ))}
                    </Card>
                    {prompt.description.warnings.map((w, i) => (
                      <Card key={i} tone={prompt.description?.danger ? "danger" : "warn"}>
                        <P style={{ marginBottom: 0 }}>{w}</P>
                      </Card>
                    ))}
                  </>
                ) : null}
              </>
            )}
          </ScrollView>
          <View style={styles.actions}>
            {prompt.kind === "info" ? (
              <Button title="OK" onPress={() => go(reject, "")} />
            ) : (
              <>
                <Button
                  title={prompt.kind === "proposal" ? t("Conectar", "Connect") : t("Firmar con Face ID", "Sign with Face ID")}
                  kind={prompt.kind === "request" && prompt.description?.danger ? "danger" : "primary"}
                  icon={prompt.kind === "proposal" ? "link" : "faceid"}
                  busy={busy}
                  onPress={() => go(approve, prompt.kind === "proposal" ? t("No se pudo conectar", "Could not connect") : t("No se pudo firmar", "Could not sign"))}
                />
                <Button title={t("Rechazar", "Reject")} kind="secondary" disabled={busy} style={{ marginTop: space.s }} onPress={() => go(reject, "")} />
              </>
            )}
          </View>
        </SafeAreaView>
      </Backdrop>
    </Modal>
  );
}

const styles = StyleSheet.create({
  line: { color: colors.text, fontSize: 15, lineHeight: 22, fontVariant: ["tabular-nums"] },
  actions: { padding: space.l, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.hairline },
  scanHeader: { paddingHorizontal: space.l },
  cameraWrap: { flex: 1, margin: space.l, borderRadius: radius.l, overflow: "hidden", backgroundColor: "#000" },
  frame: { position: "absolute", left: "15%", right: "15%", top: "25%", aspectRatio: 1, borderWidth: 2, borderColor: colors.brass, borderRadius: radius.m },
});
