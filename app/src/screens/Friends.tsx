// «Amigos de confianza» (DeRec): proteger la Cartera repartiéndola entre amigos, el semáforo de cada uno, ayudar a un
// amigo (guardar su parte, darle la suya si la pide para recuperar) y la recuperación en un móvil nuevo.
import React, { useEffect, useRef, useState } from "react";
import { Alert, Modal, Share, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import QRCode from "react-native-qrcode-svg";
import { NETWORKS, decodeFriendCode, derecThreshold } from "@boveda/core";
import { useDerec, type FriendView, type HelpedView } from "../derec/DerecProvider";
import { useWallet } from "../wallet";
import { NETWORK, isMainnet } from "../env";
import { confirm, haptic, open, run } from "../helpers";
import { t, when } from "../i18n";
import { colors, space } from "../theme";
import { Backdrop, Badge, Button, Card, Field, Group, H2, Icon, ListRow, P, Row, Screen, SectionTitle, Segmented } from "../ui";

const CODE_MARK = "H10XDEREC1.";
const lightColor = (l: FriendView["light"]) => (l === "green" ? colors.safe : l === "red" ? colors.danger : colors.warn);
const lightText = (f: FriendView) =>
  f.light === "green"
    ? t(`Guarda bien tu parte · ${f.checkedAt ? when(Math.floor(f.checkedAt / 1000)) : ""}`, `Keeps your share safe · ${f.checkedAt ? when(Math.floor(f.checkedAt / 1000)) : ""}`)
    : f.light === "red"
      ? t("No responde o su parte falla", "Not answering or their share fails")
      : t("Sin comprobar todavía", "Not checked yet");

// ---- Piezas comunes ---------------------------------------------------------------------------------------------------

/** El código en grande (QR) para que lo escanee el otro móvil, con compartir y copiar (para hacerlo a distancia). */
function ShowCode({ code, title, hint, onClose }: { code: string; title: string; hint: string; onClose: () => void }) {
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <Backdrop>
        <SafeAreaView style={{ flex: 1, padding: space.l }}>
          <H2>{title}</H2>
          <P muted>{hint}</P>
          <View style={styles.qr}>
            <QRCode value={code} size={260} ecl="M" />
          </View>
          <Row gap={space.s}>
            <Button title={t("Compartir", "Share")} kind="secondary" icon="arrow.up.forward.app.fill" style={{ flex: 1 }} onPress={() => void Share.share({ message: code })} />
            <Button
              title={t("Copiar", "Copy")}
              kind="secondary"
              icon="doc.on.doc"
              style={{ flex: 1 }}
              onPress={() => {
                void Clipboard.setStringAsync(code);
                haptic.success();
              }}
            />
          </Row>
          <P muted style={{ marginTop: space.m, fontSize: 13 }}>
            {t("Si lo mandas por mensaje, llamaos y comprobad que los dos veis el mismo código de 6 cifras al terminar.", "If you send it by message, call each other and check you both see the same 6-digit code at the end.")}
          </P>
          <View style={{ flex: 1 }} />
          <Button title={t("Listo", "Done")} onPress={onClose} />
        </SafeAreaView>
      </Backdrop>
    </Modal>
  );
}

/** Escanea (o pega) un código de amigo. */
function ScanCode({ title, onCode, onClose }: { title: string; onCode: (text: string) => Promise<void>; onClose: () => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const handled = useRef(false);
  const take = (text: string) => {
    if (handled.current || !text.includes(CODE_MARK)) return;
    handled.current = true;
    haptic.success();
    void run(t("Ese código no ha funcionado", "That code didn't work"), () => onCode(text)).finally(onClose);
  };
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <Backdrop>
        <SafeAreaView style={{ flex: 1, padding: space.l }}>
          <H2>{title}</H2>
          {permission?.granted ? (
            <View style={styles.camera}>
              <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={({ data }) => take(String(data))} />
            </View>
          ) : (
            <Card>
              <P>{t("Para escanear el código de tu amigo hace falta la cámara. Solo se usa en esta pantalla.", "Scanning your friend's code needs the camera. It's only used on this screen.")}</P>
              <Button title={t("Permitir la cámara", "Allow the camera")} onPress={() => void requestPermission()} />
            </Card>
          )}
          <Button
            title={t("Pegar el código", "Paste the code")}
            kind="secondary"
            icon="doc.on.clipboard"
            style={{ marginTop: space.m }}
            onPress={() =>
              void (async () => {
                const text = await Clipboard.getStringAsync();
                if (!text.includes(CODE_MARK)) {
                  Alert.alert(t("Nada que pegar", "Nothing to paste"), t("En el portapapeles no hay un código de amigo de H10X.", "There's no H10X friend code on the clipboard."));
                  return;
                }
                take(text);
              })()
            }
          />
          <View style={{ flex: 1 }} />
          <Button title={t("Cancelar", "Cancel")} kind="ghost" onPress={onClose} />
        </SafeAreaView>
      </Backdrop>
    </Modal>
  );
}

/** Peticiones de amigos que esperan tu respuesta (dar tu parte para que recuperen). */
function Approvals() {
  const d = useDerec();
  const [busy, setBusy] = useState<string | null>(null);
  if (!d.approvals.length) return null;
  return (
    <>
      {d.approvals.map((a) => (
        <Card key={a.id} tone="warn">
          <Row gap={space.s} style={{ marginBottom: space.s }}>
            <Icon name="exclamationmark.triangle.fill" color={colors.warn} />
            <Text style={styles.strong}>{t(`«${a.name || "Un amigo"}» pide su parte para recuperar su wallet`, `"${a.name || "A friend"}" asks for their share to recover their wallet`)}</Text>
          </Row>
          <P>
            {t(
              `Llámale ahora. Si los dos veis el código ${a.fingerprint || "—"}, es él. Si no te ha pedido nada, di que no: nadie se lleva nada sin ti.`,
              `Call them now. If you both see the code ${a.fingerprint || "—"}, it's them. If they didn't ask you, say no: nobody gets anything without you.`,
            )}
          </P>
          <Row gap={space.s}>
            <Button
              title={t("Es él: dar mi parte", "It's them: give my share")}
              busy={busy === a.id}
              style={{ flex: 1 }}
              onPress={() =>
                void run(t("No se pudo responder", "Couldn't answer"), async () => {
                  setBusy(a.id);
                  try {
                    await d.answer(a.id, true);
                  } finally {
                    setBusy(null);
                  }
                })
              }
            />
            <Button title={t("No", "No")} kind="secondary" style={{ flex: 0.5 }} onPress={() => void run(t("No se pudo responder", "Couldn't answer"), () => d.answer(a.id, false))} />
          </Row>
        </Card>
      ))}
    </>
  );
}

/** Aviso en Inicio cuando un amigo pide ayuda. */
export function FriendsBanner({ onOpen }: { onOpen?: () => void }) {
  const d = useDerec();
  if (!d.available || !d.approvals.length || !onOpen) return null;
  return (
    <Card tone="warn">
      <Row gap={space.s}>
        <Icon name="person.3.fill" color={colors.warn} />
        <Text style={[styles.strong, { flex: 1 }]}>{t("Un amigo te pide ayuda para recuperar su wallet", "A friend is asking for help to recover their wallet")}</Text>
      </Row>
      <Button title={t("Ver", "View")} kind="secondary" style={{ marginTop: space.s }} onPress={onOpen} />
    </Card>
  );
}

/** Sin la app instalada (Expo Go) o en una red sin DeRec. */
function NotAvailable({ onBack }: { onBack: () => void }) {
  return (
    <Screen title={t("Amigos de confianza", "Trusted friends")} onBack={onBack}>
      <Card>
        <P>
          {t(
            "Esta función usa el protocolo DeRec y necesita la app instalada (TestFlight o la app de Android). En Expo Go no está su módulo.",
            "This feature uses the DeRec protocol and needs the installed app (TestFlight or the Android app). Its module isn't in Expo Go.",
          )}
        </P>
      </Card>
    </Screen>
  );
}

/** Activar el buzón: el nombre que verán los amigos y unos HBAR de la Cartera para los mensajes. */
function Activate() {
  const d = useDerec();
  const { profile } = useWallet();
  const [name, setName] = useState(d.name || profile?.name || "");
  const [busy, setBusy] = useState(false);
  return (
    <Card>
      <P>
        {t(
          "Para hablar con tus amigos, tu wallet necesita un buzón en Hedera. Se paga con 2 HBAR de tu Cartera (dan para cientos de mensajes). Lo que viaja va cifrado: nadie más puede leerlo.",
          "To talk to your friends, your wallet needs a mailbox on Hedera. It costs 2 HBAR from your Wallet (enough for hundreds of messages). Everything is encrypted: nobody else can read it.",
        )}
      </P>
      <Field label={t("Cómo te verán tus amigos", "How your friends will see you")} value={name} onChangeText={setName} maxLength={40} placeholder={t("Tu nombre", "Your name")} />
      <Button
        title={t("Activar buzón (2 HBAR)", "Activate mailbox (2 HBAR)")}
        busy={busy}
        disabled={!name.trim() || !profile?.pocket.accountId}
        onPress={() =>
          void run(t("No se pudo activar", "Couldn't activate"), async () => {
            setBusy(true);
            try {
              await d.setName(name);
              await d.activate();
            } finally {
              setBusy(false);
            }
          })
        }
      />
      {!profile?.pocket.accountId ? <P muted style={{ marginTop: space.s }}>{t("Primero recibe algo de HBAR en tu Cartera.", "First receive some HBAR in your Wallet.")}</P> : null}
    </Card>
  );
}

// ---- Pantalla principal ------------------------------------------------------------------------------------------------

type View2 = { kind: "code"; code: string; title: string; hint: string } | { kind: "scan"; as: "owner" | "helper"; title: string } | null;

export function FriendsScreen({ onBack }: { onBack: () => void }) {
  const d = useDerec();
  const [tab, setTab] = useState<"mine" | "help">("mine");
  const [view, setView] = useState<View2>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { focus } = d;
  useEffect(() => {
    focus(true);
    return () => focus(false);
  }, [focus]);

  if (!d.available) return <NotAvailable onBack={onBack} />;
  const ready = !!d.mailbox?.topicId;
  const n = d.friends.length;
  const need = derecThreshold(Math.max(n, 2));
  const act = (id: string, what: string, fn: () => Promise<void>) =>
    void run(what, async () => {
      setBusy(id);
      try {
        await fn();
      } finally {
        setBusy(null);
      }
    });

  const showOwnerCode = () =>
    act("code", t("No se pudo crear el código", "Couldn't create the code"), async () => {
      const code = await d.ownerCode();
      setView({
        kind: "code",
        code,
        title: t("Que tu amigo escanee este código", "Have your friend scan this code"),
        hint: t("En su H10X Wallet: Ajustes → Amigos de confianza → Ayudo a → Ayudar a un amigo. Vale 15 minutos.", "In their H10X Wallet: Settings → Trusted friends → I help → Help a friend. Valid for 15 minutes."),
      });
    });
  const showHelperCode = (f?: HelpedView) =>
    act("hcode", t("No se pudo crear el código", "Couldn't create the code"), async () => {
      if (f && !(await confirm(t("Ayudar a recuperar", "Help recover"), t(`Enséñale este código solo a ${f.name || "tu amigo"} y solo si te lo ha pedido él (llámale si no estáis juntos).`, `Only show this code to ${f.name || "your friend"} and only if they asked you (call them if you're not together).`), t("Enseñar", "Show")))) return;
      const code = await d.helperCode(f?.channelId, f?.version ?? null);
      setView({
        kind: "code",
        code,
        title: f ? t(`Código para que ${f.name || "tu amigo"} recupere su wallet`, `Code for ${f.name || "your friend"} to recover their wallet`) : t("Que tu amigo escanee este código", "Have your friend scan this code"),
        hint: f
          ? t("Que lo escanee en su móvil nuevo: «Recuperar con mis amigos». Después te pedirá confirmar con un código de 6 cifras.", "They scan it on their new phone: 'Recover with my friends'. Then you'll be asked to confirm with a 6-digit code.")
          : t("En su H10X Wallet: Ajustes → Amigos de confianza → Mis amigos → Tengo un código. Vale 15 minutos.", "In their H10X Wallet: Settings → Trusted friends → My friends → I have a code. Valid for 15 minutes."),
      });
    });

  return (
    <Screen title={t("Amigos de confianza", "Trusted friends")} onBack={onBack} refreshing={false} onRefresh={() => void d.pumpNow()}>
      <Row gap={space.s} style={{ marginBottom: space.s }}>
        <Badge text="Beta" tone="warn" />
        <Badge text="DeRec" tone="blue" />
      </Row>
      <P muted>
        {t(
          "Si pierdes el móvil, tus amigos te devuelven la Cartera. Cada uno guarda una parte cifrada que sola no sirve; hace falta la mayoría. Tu kit sigue siendo la llave maestra.",
          "If you lose your phone, your friends give your Wallet back. Each keeps an encrypted share that's useless alone; it takes most of them. Your kit is still the master key.",
        )}
      </P>
      <Approvals />
      {!ready ? <Activate /> : null}
      {ready ? (
        <>
          <Segmented
            options={[
              { value: "mine", label: t("Mis amigos", "My friends") },
              { value: "help", label: t(`Ayudo a${d.helping.length ? ` (${d.helping.length})` : ""}`, `I help${d.helping.length ? ` (${d.helping.length})` : ""}`) },
            ]}
            value={tab}
            onChange={setTab}
          />
          {tab === "mine" ? (
            <>
              <Card tone={d.shared?.met ? "accent" : "warn"}>
                <Row gap={space.s}>
                  <Icon name={d.shared?.met ? "checkmark.shield.fill" : "exclamationmark.triangle.fill"} color={d.shared?.met ? colors.safe : colors.warn} />
                  <Text style={styles.strong}>
                    {d.shared?.met ? t(`Protegida · versión ${d.shared.version}`, `Protected · version ${d.shared.version}`) : n ? t("Aún sin repartir", "Not shared yet") : t("Sin amigos todavía", "No friends yet")}
                  </Text>
                </Row>
                <P muted style={{ marginTop: space.xs }}>
                  {n >= 2
                    ? t(`Para recuperarla harán falta ${need} de tus ${n} amigos.`, `Recovering it will take ${need} of your ${n} friends.`)
                    : t("Añade al menos 2 amigos (mejor 3 o más) que también usen H10X Wallet.", "Add at least 2 friends (3 or more is better) who also use H10X Wallet.")}
                </P>
              </Card>
              {n ? (
                <Group>
                  {d.friends.map((f) => (
                    <ListRow key={f.channelId} icon="checkmark.shield.fill" iconColor={lightColor(f.light)} title={f.name || t("Amigo", "Friend")} subtitle={lightText(f)} />
                  ))}
                </Group>
              ) : null}
              <Button title={t("Añadir un amigo", "Add a friend")} icon="qrcode" busy={busy === "code"} onPress={showOwnerCode} />
              <Button title={t("Tengo un código de mi amigo", "I have a code from my friend")} kind="ghost" onPress={() => setView({ kind: "scan", as: "owner", title: t("Escanea el código de tu amigo", "Scan your friend's code") })} />
              {n >= 2 ? (
                <Button
                  title={d.shared?.met ? t("Actualizar mi copia", "Update my copy") : t("Proteger ahora", "Protect now")}
                  kind={d.shared?.met ? "secondary" : "primary"}
                  busy={busy === "protect"}
                  style={{ marginTop: space.m }}
                  onPress={() => act("protect", t("No se pudo repartir", "Couldn't share"), () => d.protect())}
                />
              ) : null}
              {d.shared?.met ? <Button title={t("Comprobar ahora", "Check now")} kind="ghost" busy={busy === "verify"} onPress={() => act("verify", t("No se pudo comprobar", "Couldn't check"), () => d.verify())} /> : null}
            </>
          ) : (
            <>
              <Button title={t("Ayudar a un amigo", "Help a friend")} icon="qrcode.viewfinder" onPress={() => setView({ kind: "scan", as: "helper", title: t("Escanea el código de tu amigo", "Scan your friend's code") })} />
              <Button title={t("Enseñarle mi código", "Show them my code")} kind="ghost" busy={busy === "hcode"} onPress={() => showHelperCode()} />
              {d.helping.length ? (
                <>
                  <SectionTitle>{t("Guardas una parte de", "You keep a share for")}</SectionTitle>
                  <Group>
                    {d.helping.map((f) => (
                      <ListRow
                        key={f.channelId}
                        icon="person.3.fill"
                        iconColor={colors.link}
                        title={f.name || t("Amigo", "Friend")}
                        subtitle={t(`Desde ${when(Math.floor(f.pairedAt / 1000))}${f.version ? ` · versión ${f.version}` : ""} · toca para ayudarle a recuperar`, `Since ${when(Math.floor(f.pairedAt / 1000))}${f.version ? ` · version ${f.version}` : ""} · tap to help them recover`)}
                        onPress={() => showHelperCode(f)}
                      />
                    ))}
                  </Group>
                </>
              ) : (
                <P muted>{t("Aún no guardas ninguna parte. Cuando un amigo te enseñe su código, escanéalo aquí.", "You don't keep any share yet. When a friend shows you their code, scan it here.")}</P>
              )}
            </>
          )}
          <Group style={{ marginTop: space.l }}>
            <ListRow
              icon="tray.and.arrow.down"
              iconColor={colors.muted}
              title={t("Buzón en Hedera", "Mailbox on Hedera")}
              subtitle={`${d.mailbox?.topicId ?? ""}${d.mailbox?.balance != null ? ` · ${(Number(d.mailbox.balance) / 1e8).toFixed(2)} HBAR` : ""}`}
              onPress={() => (d.mailbox?.topicId ? open(`${NETWORKS[NETWORK].hashscan}/topic/${d.mailbox.topicId}`) : undefined)}
            />
            {d.mailbox?.balance != null && d.mailbox.balance < 50_000_000n ? (
              <ListRow icon="plus.circle.fill" iconColor={colors.warn} title={t("Recargar el buzón (2 HBAR)", "Top up the mailbox (2 HBAR)")} onPress={() => void run(t("No se pudo recargar", "Couldn't top up"), () => d.topUp())} />
            ) : null}
          </Group>
          {d.error ? <P muted style={{ fontSize: 12 }}>{d.error}</P> : null}
        </>
      ) : null}

      {view?.kind === "code" ? <ShowCode code={view.code} title={view.title} hint={view.hint} onClose={() => setView(null)} /> : null}
      {view?.kind === "scan" ? (
        <ScanCode
          title={view.title}
          onClose={() => setView(null)}
          onCode={async (text) => {
            const r = await d.scan(text, view.as);
            haptic.success();
            Alert.alert(t("Emparejando", "Pairing"), t(`Con «${r.name || "tu amigo"}». En unos segundos aparecerá en la lista.`, `With "${r.name || "your friend"}". It will show up in the list in a few seconds.`));
          }}
        />
      ) : null}
    </Screen>
  );
}

// ---- Móvil nuevo: recuperar con amigos -----------------------------------------------------------------------------------

export function FriendsRecover({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const d = useDerec();
  const { installFromFriends, profile } = useWallet();
  const [name, setName] = useState(d.name);
  const [started, setStarted] = useState(!!d.mailbox);
  const [scanning, setScanning] = useState(false);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [asked, setAsked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ vault: boolean } | null>(null);
  const installing = useRef(false);
  const { focus } = d;
  useEffect(() => {
    focus(true);
    return () => focus(false);
  }, [focus]);
  useEffect(() => setStarted(!!d.mailbox), [d.mailbox]);

  // Códigos de 6 cifras de cada amigo (para leerlos por teléfono).
  useEffect(() => {
    let alive = true;
    void (async () => {
      const out: Record<string, string> = {};
      for (const f of d.friends) out[f.channelId] = await d.fingerprint(f.channelId).catch(() => "");
      if (alive) setCodes(out);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.friends.length]);

  // Ha vuelto: se instala la wallet y este móvil se queda como dueño (vuelve a repartir).
  useEffect(() => {
    const r = d.recovered;
    if (!r || installing.current) return;
    installing.current = true;
    void run(t("No se pudo instalar lo recuperado", "Couldn't install what was recovered"), async () => {
      const res = await installFromFriends({ key: r.cartera, perfil: r.perfil });
      await d.adopt(r);
      setDone(res);
    }).finally(() => {
      installing.current = false;
    });
  }, [d.recovered, d, installFromFriends]);

  if (!d.available) return <NotAvailable onBack={onBack} />;
  if (done) {
    return (
      <Screen title={t("Tu wallet ha vuelto", "Your wallet is back")}>
        <Card tone="accent">
          <P>{t("Tus amigos te han devuelto la Cartera. Ya se ha vuelto a repartir con una versión nueva: las partes viejas no sirven.", "Your friends gave your Wallet back. It's been shared again with a new version: the old shares are useless.")}</P>
        </Card>
        {done.vault ? (
          <Card tone="warn">
            <P>
              {t(
                "Si crees que alguien tiene tu móvil viejo, cambia de llave con tu kit (Ajustes → Cambiar de móvil) o saca lo de la bóveda: la llave recuperada es la misma que tenía ese móvil.",
                "If you think someone has your old phone, change keys with your kit (Settings → Move phones) or move the vault's funds: the recovered key is the same one that phone had.",
              )}
            </P>
          </Card>
        ) : null}
        <Button title={t("Ir a mi wallet", "Go to my wallet")} onPress={onDone} />
      </Screen>
    );
  }

  const faucet = NETWORKS[NETWORK].faucet;
  return (
    <Screen title={t("Recuperar con mis amigos", "Recover with my friends")} onBack={onBack} onRefresh={() => void d.pumpNow()} refreshing={false}>
      <Row gap={space.s} style={{ marginBottom: space.s }}>
        <Badge text="Beta" tone="warn" />
        <Badge text="DeRec" tone="blue" />
      </Row>
      {profile?.vault ? (
        <Card tone="warn">
          <P>{t("Este móvil ya tiene una wallet con bóveda. Para recuperar otra, añade una wallet nueva desde «Tus wallets».", "This phone already has a wallet with a vault. To recover another one, add a new wallet from 'Your wallets'.")}</P>
        </Card>
      ) : null}
      {!started ? (
        <Card>
          <P>
            {t(
              "Tus amigos guardan partes de tu Cartera. Con la mayoría de ellos, vuelve a este móvil. Primero, un buzón para hablar con ellos.",
              "Your friends keep shares of your Wallet. With most of them, it comes back to this phone. First, a mailbox to talk to them.",
            )}
          </P>
          <Field label={t("Tu nombre (para que te reconozcan)", "Your name (so they recognise you)")} value={name} onChangeText={setName} maxLength={40} />
          <Button
            title={t("Empezar", "Start")}
            disabled={!name.trim()}
            onPress={() =>
              void run(t("No se pudo empezar", "Couldn't start"), async () => {
                await d.reset();
                await d.setName(name);
                await d.activateFunded();
              })
            }
          />
        </Card>
      ) : !d.mailbox?.topicId ? (
        <Card>
          <H2>{t("1 · Unos HBAR para los mensajes", "1 · Some HBAR for the messages")}</H2>
          <P>
            {isMainnet
              ? t("Pide a un amigo que mande 2 HBAR a esta dirección (pagan los mensajes con tus amigos).", "Ask a friend to send 2 HBAR to this address (they pay for the messages with your friends).")
              : t("En la red de pruebas son gratis: pega esta dirección en el faucet de Hedera.", "On the test network they're free: paste this address into the Hedera faucet.")}
          </P>
          <View style={styles.qr}>
            <QRCode value={d.mailbox?.evm ?? ""} size={170} />
          </View>
          <Text selectable style={styles.mono}>
            {d.mailbox?.evm}
          </Text>
          <Row gap={space.s} style={{ marginTop: space.s }}>
            <Button title={t("Copiar", "Copy")} kind="secondary" icon="doc.on.doc" style={{ flex: 1 }} onPress={() => void Clipboard.setStringAsync(d.mailbox?.evm ?? "")} />
            {!isMainnet && faucet ? <Button title={t("Abrir faucet", "Open faucet")} kind="secondary" style={{ flex: 1 }} onPress={() => open(faucet)} /> : null}
          </Row>
          <Button
            title={t("Ya han llegado", "They've arrived")}
            busy={busy}
            style={{ marginTop: space.m }}
            onPress={() =>
              void run(t("No se pudo comprobar", "Couldn't check"), async () => {
                setBusy(true);
                try {
                  if (!(await d.activateFunded())) throw new Error(t("Aún no han llegado. Espera unos segundos y vuelve a probar.", "They haven't arrived yet. Wait a few seconds and try again."));
                } finally {
                  setBusy(false);
                }
              })
            }
          />
        </Card>
      ) : (
        <>
          <H2>{t("2 · Escanea el código de cada amigo", "2 · Scan each friend's code")}</H2>
          <P muted>
            {t(
              "Cada amigo abre H10X Wallet → Ajustes → Amigos de confianza → Ayudo a → tu nombre, y te enseña su código. Luego léele el código de 6 cifras que sale aquí junto a su nombre.",
              "Each friend opens H10X Wallet → Settings → Trusted friends → I help → your name, and shows you their code. Then read them the 6-digit code shown here next to their name.",
            )}
          </P>
          {d.friends.length ? (
            <Group>
              {d.friends.map((f) => (
                <ListRow key={f.channelId} icon="person.3.fill" iconColor={colors.link} title={f.name || t("Amigo", "Friend")} value={codes[f.channelId] || "…"} subtitle={t("Léele este código", "Read them this code")} />
              ))}
            </Group>
          ) : null}
          <Button title={t("Escanear el código de un amigo", "Scan a friend's code")} icon="qrcode.viewfinder" kind={d.friends.length >= 2 ? "secondary" : "primary"} onPress={() => setScanning(true)} />
          {d.friends.length >= 2 && d.recoveryTarget ? (
            <Button
              title={asked ? t("Esperando a que confirmen…", "Waiting for them to confirm…") : t("Recuperar ahora", "Recover now")}
              busy={busy}
              disabled={asked}
              style={{ marginTop: space.m }}
              onPress={() =>
                void run(t("No se pudo pedir", "Couldn't ask"), async () => {
                  setBusy(true);
                  try {
                    const tg = d.recoveryTarget;
                    if (!tg) return;
                    await d.recover(tg.secretId, tg.version);
                    setAsked(true);
                  } finally {
                    setBusy(false);
                  }
                })
              }
            />
          ) : null}
          {asked ? (
            <Card>
              <Row gap={space.s}>
                <Badge text={t("En marcha", "In progress")} tone="accent" />
                <P muted style={{ flex: 1 }}>{t("Tus amigos tienen que tocar «Es él: dar mi parte» en su móvil.", "Your friends have to tap 'It's them: give my share' on their phone.")}</P>
              </Row>
              {d.recoveryOutcome ? <P style={{ marginTop: space.s }}>{d.recoveryOutcome}</P> : null}
              {d.recoveryOutcome ? <Button title={t("Volver a pedir", "Ask again")} kind="secondary" onPress={() => setAsked(false)} /> : null}
            </Card>
          ) : null}
        </>
      )}
      {d.error ? <P muted style={{ fontSize: 12 }}>{d.error}</P> : null}
      {scanning ? (
        <ScanCode
          title={t("Escanea el código de tu amigo", "Scan your friend's code")}
          onClose={() => setScanning(false)}
          onCode={async (text) => {
            // Antes de nada: solo códigos de RECUPERACIÓN (los de emparejar empezarían otra cosa).
            if (decodeFriendCode(text).purpose !== "recover") throw new Error(t("Ese código no es de recuperación: tu amigo debe elegir tu nombre en «Ayudo a».", "That isn't a recovery code: your friend must pick your name under 'I help'."));
            await d.scan(text, "owner");
          }}
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  qr: { alignSelf: "center", padding: space.m, backgroundColor: "#fff", borderRadius: 16, marginVertical: space.l },
  camera: { height: 320, borderRadius: 18, overflow: "hidden", marginVertical: space.m },
  strong: { color: colors.text, fontSize: 15, fontWeight: "600", flexShrink: 1 },
  mono: { color: colors.text, fontFamily: "Menlo", fontSize: 13, textAlign: "center" },
});
