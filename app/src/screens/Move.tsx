// «Pasar a otro móvil»: la wallet (Cartera y bóveda) pasa a la llave de un móvil nuevo sin copiar ninguna llave, sin
// cuenta atrás y sin crear otra bóveda. El móvil nuevo lo pide con el kit; el viejo lo confirma con Face ID.
import React, { useEffect, useRef, useState } from "react";
import { Alert, Platform, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Mirror, NETWORKS, formatCountdown, formatHbar } from "@boveda/core";
import { Badge, Button, Card, Field, Group, H2, Icon, ListRow, P, Row, Screen, Steps, WordsField } from "../ui";
import { colors, space, typeface } from "../theme";
import { useWallet, type MoveRequestView } from "../wallet";
import { t } from "../i18n";
import { confirm, haptic, run, useNow, useProtectSecrets } from "../helpers";
import { NETWORK } from "../env";

const wordCount = (w: string) => (w.trim() ? w.trim().split(/\s+/).length : 0);
const MOVE_STEPS = () => [t("Comprobando tu kit y tu bóveda", "Checking your kit and vault"), t("Creando la llave de este móvil", "Creating this phone's key"), t("Pidiendo el cambio", "Requesting the change"), t("Listo", "Done")];

/** Las cuatro palabras de comprobación, grandes, con el código debajo. */
function Fingerprint({ words, code }: { words: string[]; code: string }) {
  return (
    <View style={{ alignItems: "center", paddingVertical: space.m }}>
      <Text style={{ color: colors.text, fontSize: 26, textAlign: "center", fontFamily: typeface.displayBold, fontWeight: typeface.displayBold ? undefined : "800", letterSpacing: 0.2 }} accessibilityLabel={words.join(", ")}>
        {words.join("  ·  ")}
      </Text>
      <Text style={{ color: colors.muted, fontSize: 14, marginTop: space.s, fontVariant: ["tabular-nums"] }}>{code}</Text>
    </View>
  );
}

/** Móvil nuevo: pedir el cambio con el número de la bóveda y las 24 palabras. */
export function MoveIn({ onBack }: { onBack: () => void }) {
  useProtectSecrets();
  const { moveIn } = useWallet();
  const [vaultId, setVaultId] = useState("");
  const [words, setWords] = useState("");
  const [name, setName] = useState(Platform.OS === "ios" ? "iPhone" : "Android");
  const [step, setStep] = useState(-1);
  const ok = /^0\.0\.\d+$/.test(vaultId.trim()) && wordCount(words) === 24 && name.trim().length > 0;

  if (step >= 0) {
    return (
      <Screen title={t("Pasando tu wallet a este móvil", "Moving your wallet to this phone")}>
        <Card>
          <Steps steps={MOVE_STEPS()} current={step} />
          <P muted>{t("Tarda unos segundos. No cierres la app.", "It takes a few seconds. Don't close the app.")}</P>
        </Card>
      </Screen>
    );
  }

  return (
    <Screen title={t("Traer mi wallet a este móvil", "Bring my wallet to this phone")} onBack={onBack}>
      <Card tone="accent">
        <P>
          {t(
            "Tu wallet pasa a este móvil tal cual: la misma Cartera, la misma bóveda y el mismo kit. No hay que esperar ninguna cuenta atrás ni crear nada nuevo.",
            "Your wallet moves to this phone as it is: the same Wallet, the same vault and the same kit. No countdown to wait for and nothing new to create.",
          )}
        </P>
        <P style={{ marginBottom: 0 }}>{t("Necesitas:", "You need:")}</P>
      </Card>
      <Group style={{ marginBottom: space.l }}>
        <ListRow icon="iphone" title={t("Tu otro móvil, a mano", "Your other phone, at hand")} subtitle={t("Con H10X Wallet abierta: ahí confirmarás el cambio con Face ID.", "With H10X Wallet open: you'll confirm the change there with Face ID.")} />
        <ListRow icon="key.horizontal.fill" title={t("Tus 24 palabras", "Your 24 words")} subtitle={t("Las de tu kit de rescate. Solo se usan aquí, para pedir el cambio.", "Your rescue kit's. They're only used here, to request the change.")} />
        <ListRow icon="lock.shield.fill" title={t("El número de tu bóveda", "Your vault number")} subtitle={t("En tu otro móvil: Ajustes → Pasar a otro móvil (o en el papel del kit).", "On your other phone: Settings → Move to another phone (or on your kit's paper).")} />
      </Group>
      <Field label={t("Número de la bóveda", "Vault number")} value={vaultId} onChangeText={setVaultId} placeholder="0.0.1234" autoCapitalize="none" autoCorrect={false} />
      <WordsField label={t(`Las 24 palabras (${wordCount(words)}/24)`, `The 24 words (${wordCount(words)}/24)`)} value={words} onChangeText={setWords} placeholder={t("palabra1 palabra2 …", "word1 word2 …")} />
      <Field
        label={t("Nombre de este móvil", "This phone's name")}
        value={name}
        onChangeText={(v) => setName(v.slice(0, 24))}
        hint={t("Lo verás en tu otro móvil al confirmar.", "You'll see it on your other phone when confirming.")}
      />
      <Card>
        <P muted style={{ marginBottom: 0 }}>
          {t(
            "El cambio lo paga la cuenta de tu kit (menos de 1 HBAR). Hasta que tu otro móvil lo confirme no cambia nada; si no lo confirma en una hora, caduca solo.",
            "Your kit's account pays for the change (under 1 HBAR). Nothing changes until your other phone confirms it; if it isn't confirmed within an hour, it expires by itself.",
          )}
        </P>
      </Card>
      <Button
        title={t("Pedir el cambio", "Request the change")}
        icon="iphone.and.arrow.forward"
        disabled={!ok}
        onPress={() =>
          void run(t("No se pudo pedir el cambio", "Couldn't request the change"), async () => {
            setStep(0);
            try {
              await moveIn({ vaultId, words, name, onStep: setStep });
              haptic.success();
            } finally {
              setStep(-1);
            }
          })
        }
      />
    </Screen>
  );
}

/** Móvil nuevo: esperando a que el viejo confirme. Mira la red cada pocos segundos. */
export function MoveWaiting() {
  useProtectSecrets();
  const { profile, checkMoveIn, cancelMoveIn, moveIn, moveInFingerprint } = useWallet();
  const now = useNow();
  const [state, setState] = useState<"waiting" | "half" | "expired" | "done" | "none">("waiting");
  const [words, setWords] = useState("");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(-1);
  const checking = useRef(false);
  const pm = profile?.pendingMove;

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (checking.current) return;
      checking.current = true;
      try {
        const s = await checkMoveIn();
        if (s === "done") {
          // La pantalla desaparece sola (la wallet ya está lista): el aviso se enseña igualmente.
          haptic.success();
          Alert.alert(t("¡Listo!", "Done!"), t("Tu wallet ya está en este móvil. El otro ya no tiene acceso.", "Your wallet is now on this phone. The other one no longer has access."));
        }
        if (alive) setState(s);
      } catch {
        // sin conexión: se vuelve a mirar en el siguiente ciclo
      } finally {
        checking.current = false;
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 4000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [checkMoveIn]);

  if (!pm) return null;
  const left = pm.expiresAt - now;
  const expired = state === "expired" || (pm.requested && left <= 0);
  const canCancel = !pm.requested || expired;

  if (step >= 0) {
    return (
      <Screen title={t("Pidiendo el cambio otra vez", "Requesting the change again")}>
        <Card>
          <Steps steps={MOVE_STEPS()} current={step} />
        </Card>
      </Screen>
    );
  }

  return (
    <Screen title={t("Confirma en tu otro móvil", "Confirm on your other phone")}>
      {!pm.requested ? (
        <Card tone="warn">
          <H2>{t("El cambio no llegó a pedirse", "The change wasn't requested")}</H2>
          <P style={{ marginBottom: 0 }}>{t("Se cortó antes de terminar. Escribe otra vez tus 24 palabras para pedirlo.", "It was cut off before finishing. Type your 24 words again to request it.")}</P>
        </Card>
      ) : expired ? (
        <Card tone="warn">
          <H2>{t("La petición ha caducado", "The request has expired")}</H2>
          <P style={{ marginBottom: 0 }}>
            {state === "half"
              ? t("Una parte ya es de este móvil y la otra no. Pídelo otra vez para terminar.", "One part already belongs to this phone and the other doesn't. Request it again to finish.")
              : t("Tu otro móvil no lo confirmó a tiempo y no ha cambiado nada. Puedes pedirlo otra vez.", "Your other phone didn't confirm it in time and nothing has changed. You can request it again.")}
          </P>
        </Card>
      ) : (
        <>
          <P>
            {t(
              "Abre H10X Wallet en tu otro móvil. En Inicio verás «Cambio de móvil pedido». Comprueba que salen estas mismas cuatro palabras y confírmalo:",
              "Open H10X Wallet on your other phone. On Home you'll see «Phone change requested». Check these same four words appear and confirm it:",
            )}
          </P>
          <Card tone="brass">{moveInFingerprint ? <Fingerprint words={moveInFingerprint.words} code={moveInFingerprint.code} /> : null}</Card>
          <Card>
            <Row style={{ justifyContent: "space-between" }}>
              <Row gap={space.s}>
                <Icon name="hourglass" size={16} color={colors.muted} />
                <Text style={{ color: colors.text, fontSize: 15 }}>{state === "half" ? t("Terminando…", "Finishing…") : t("Esperando a tu otro móvil…", "Waiting for your other phone…")}</Text>
              </Row>
              <Badge text={formatCountdown(Math.max(0, left))} tone="warn" />
            </Row>
            <P muted style={{ marginTop: space.m, marginBottom: 0 }}>
              {t(
                "Si en tu otro móvil salen palabras distintas, no confirmes: alguien más tiene tu kit.",
                "If different words appear on your other phone, don't confirm: someone else has your kit.",
              )}
            </P>
          </Card>
        </>
      )}
      {!pm.requested || expired ? (
        <>
          <WordsField label={t(`Las 24 palabras (${wordCount(words)}/24)`, `The 24 words (${wordCount(words)}/24)`)} value={words} onChangeText={setWords} placeholder={t("palabra1 palabra2 …", "word1 word2 …")} />
          <Button
            title={t("Pedir el cambio otra vez", "Request the change again")}
            disabled={wordCount(words) !== 24}
            onPress={() =>
              void run(t("No se pudo pedir el cambio", "Couldn't request the change"), async () => {
                setStep(0);
                try {
                  await moveIn({ vaultId: pm.vaultId, words, name: pm.name, onStep: setStep });
                  setWords("");
                  setState("waiting");
                } finally {
                  setStep(-1);
                }
              })
            }
          />
        </>
      ) : null}
      {canCancel ? (
        <Button
          title={t("Cancelar y empezar de cero", "Cancel and start over")}
          kind="ghost"
          busy={busy}
          style={{ marginTop: space.s }}
          onPress={() =>
            void run(t("No se pudo cancelar", "Couldn't cancel"), async () => {
              if (!(await confirm(t("¿Cancelar el cambio?", "Cancel the change?"), t("Este móvil vuelve a la pantalla de inicio. Tu wallet sigue en el otro móvil.", "This phone goes back to the start screen. Your wallet stays on the other phone."), t("Cancelar el cambio", "Cancel the change"), true))) return;
              setBusy(true);
              try {
                await cancelMoveIn();
              } finally {
                setBusy(false);
              }
            })
          }
        />
      ) : null}
    </Screen>
  );
}

/** Móvil viejo: tarjeta en Inicio con las peticiones de cambio de móvil y las programadas raras del kit. */
export function MoveRequestCard({ onEvacuate }: { onEvacuate: () => void }) {
  const { moveRequests, confirmMoveOut } = useWallet();
  const now = useNow(5000);
  const [busy, setBusy] = useState("");
  if (!moveRequests) return null;
  const live = moveRequests.requests.filter((r) => r.expiresAt > now);
  if (live.length === 0 && moveRequests.suspicious === 0) return null;
  const several = live.length > 1;

  const doConfirm = (r: MoveRequestView) =>
    void run(t("No se pudo confirmar", "Couldn't confirm"), async () => {
      const ok = await confirm(
        t(`¿Pasar tu wallet a «${r.name}»?`, `Move your wallet to «${r.name}»?`),
        t(
          `Solo si en tu móvil nuevo salen estas palabras: ${r.words.join(" · ")}. Después, este móvil ya no tendrá acceso y la wallet se borrará de aquí.`,
          `Only if your new phone shows these words: ${r.words.join(" · ")}. Afterwards this phone will no longer have access and the wallet will be deleted from here.`,
        ),
        t("Sí, pasarla", "Yes, move it"),
        true,
      );
      if (!ok) return;
      setBusy(r.id);
      try {
        const out = await confirmMoveOut(r);
        haptic.success();
        Alert.alert(t("Wallet pasada", "Wallet moved"), t(`Tu wallet ya está en «${out.name}». Se ha borrado de este móvil.`, `Your wallet is now on «${out.name}». It has been deleted from this phone.`));
      } finally {
        setBusy("");
      }
    });

  return (
    <>
      {live.length > 0 ? (
        <Card tone={several ? "danger" : "accent"}>
          <Row gap={space.s} style={{ marginBottom: space.s }}>
            <Icon name="iphone.and.arrow.forward" size={18} color={several ? colors.danger : colors.accent} />
            <H2 style={{ marginBottom: 0, flex: 1 }}>{several ? t("Varias peticiones de cambio de móvil", "Several phone change requests") : t("Cambio de móvil pedido", "Phone change requested")}</H2>
          </Row>
          <P>
            {several
              ? t(
                  "Hay más de una petición con tu kit. Solo una puede ser tuya: confirma únicamente la que tenga las mismas palabras que tu móvil nuevo. Alguien más tiene tu kit: después, evacúa la bóveda y crea una con un kit nuevo.",
                  "There's more than one request with your kit. Only one can be yours: confirm only the one with the same words as your new phone. Someone else has your kit: afterwards, evacuate the vault and create one with a new kit.",
                )
              : t(
                  "Alguien ha pedido con tu kit pasar esta wallet a otro móvil. Si has sido tú, comprueba que en el móvil nuevo salen estas mismas palabras.",
                  "Someone used your kit to request moving this wallet to another phone. If it was you, check the new phone shows these same words.",
                )}
          </P>
          {live.map((r) => (
            <View key={r.id} style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingTop: space.m, marginTop: space.s }}>
              <Row style={{ justifyContent: "space-between" }}>
                <Text style={{ color: colors.text, fontSize: 16, fontWeight: "600", flex: 1 }}>{r.name}</Text>
                <Badge text={formatCountdown(Math.max(0, r.expiresAt - now))} tone="warn" />
              </Row>
              <Fingerprint words={r.words} code={r.code} />
              <Button title={t(`Sí, soy yo: pasarla a «${r.name}»`, `Yes, it's me: move it to «${r.name}»`)} busy={busy === r.id} disabled={!!busy && busy !== r.id} onPress={() => doConfirm(r)} />
            </View>
          ))}
          <Button title={t("No he sido yo", "It wasn't me")} kind="danger" style={{ marginTop: space.s }} onPress={onEvacuate} />
          <P muted style={{ marginTop: space.s, marginBottom: 0, fontSize: 13 }}>
            {t(
              "Si no lo confirmas, caduca solo y no cambia nada. Pero quien lo pidió tiene tu kit: evacúa la bóveda a la Cartera de este móvil y crea una nueva.",
              "If you don't confirm it, it expires by itself and nothing changes. But whoever requested it has your kit: evacuate the vault to this phone's Wallet and create a new one.",
            )}
          </P>
        </Card>
      ) : null}
      {moveRequests.suspicious > 0 ? (
        <Card tone="danger">
          <Row gap={space.s} style={{ marginBottom: space.s }}>
            <Icon name="exclamationmark.triangle.fill" size={18} color={colors.danger} />
            <H2 style={{ marginBottom: 0, flex: 1 }}>{t("Alguien con tu kit ha intentado algo raro", "Someone with your kit tried something odd")}</H2>
          </Row>
          <P>
            {t(
              "Se ha pedido con tu kit un cambio en tu Cartera o en tu bóveda que no es un cambio de móvil normal. No lo puede terminar sin este móvil, pero tu kit ya no es seguro.",
              "A change to your Wallet or vault that isn't a normal phone change was requested with your kit. It can't finish without this phone, but your kit is no longer safe.",
            )}
          </P>
          <Button title={t("Evacuar la bóveda", "Evacuate the vault")} kind="danger" onPress={onEvacuate} />
        </Card>
      ) : null}
    </>
  );
}

/** La wallet ya no es de este móvil (se pasó a otro): solo queda borrarla de aquí. */
export function MovedAwayCard() {
  const { movedAway, wipe } = useWallet();
  const [busy, setBusy] = useState(false);
  if (!movedAway) return null;
  return (
    <Card tone="warn">
      <H2>{t("Esta wallet ya está en otro móvil", "This wallet is now on another phone")}</H2>
      <P>
        {t(
          "La llave de este móvil ya no controla la Cartera. Si has pasado la wallet a tu móvil nuevo, bórrala de aquí. Si no has sido tú, usa tu kit desde otro móvil: «Tengo un kit de rescate».",
          "This phone's key no longer controls the Wallet. If you moved the wallet to your new phone, delete it from here. If it wasn't you, use your kit from another phone: «I have a rescue kit».",
        )}
      </P>
      <Button
        title={t("Borrar de este móvil", "Delete from this phone")}
        kind="secondary"
        busy={busy}
        onPress={() =>
          void run(t("No se pudo borrar", "Couldn't delete"), async () => {
            if (!(await confirm(t("¿Borrar la wallet de este móvil?", "Delete the wallet from this phone?"), t("Ya no la controla. Tus fondos siguen en la red, con la llave de tu otro móvil.", "It no longer controls it. Your funds stay on the network, with your other phone's key."), t("Borrar", "Delete"), true))) return;
            setBusy(true);
            try {
              await wipe();
            } finally {
              setBusy(false);
            }
          })
        }
      />
    </Card>
  );
}

/** Ajustes → Pasar a otro móvil: qué hace falta y el número de la bóveda para copiarlo. */
export function MoveHelp({ onBack }: { onBack: () => void }) {
  const { profile } = useWallet();
  const [copied, setCopied] = useState(false);
  const [kitBalance, setKitBalance] = useState<bigint | null>(null);
  const kit = profile?.vault?.rescueAccountId;
  useEffect(() => {
    if (!kit) return;
    let alive = true;
    new Mirror(NETWORKS[NETWORK].mirror)
      .account(kit)
      .then((acc) => {
        if (alive) setKitBalance(acc?.balance ?? null);
      })
      .catch(() => undefined); // sin conexión: no se enseña el saldo del kit
    return () => {
      alive = false;
    };
  }, [kit]);
  if (!profile?.vault) return null;
  const v2 = profile.vault.version === 2;
  return (
    <Screen title={t("Pasar a otro móvil", "Move to another phone")} onBack={onBack}>
      {!v2 ? (
        <Card tone="warn">
          <P style={{ marginBottom: 0 }}>{t("Solo las bóvedas v2 se pueden pasar a otro móvil. Pasa antes a la v2 desde Inicio.", "Only v2 vaults can be moved to another phone. Upgrade to v2 from Home first.")}</P>
        </Card>
      ) : null}
      <P>
        {t(
          "Tu wallet pasa al móvil nuevo tal cual (misma Cartera, misma bóveda, mismo kit), sin esperar ninguna cuenta atrás y sin crear nada nuevo. Ninguna llave sale de ningún móvil.",
          "Your wallet moves to the new phone as it is (same Wallet, same vault, same kit), with no countdown and nothing new to create. No key ever leaves either phone.",
        )}
      </P>
      <Group style={{ marginBottom: space.l }}>
        <ListRow icon="iphone" title={t("1. En el móvil nuevo", "1. On the new phone")} subtitle={t("Instala H10X Wallet y pulsa «Ya tengo H10X Wallet en otro móvil».", "Install H10X Wallet and tap «I already have H10X Wallet on another phone».")} />
        <ListRow icon="key.horizontal.fill" title={t("2. Escribe tus 24 palabras", "2. Type your 24 words")} subtitle={t("Y el número de tu bóveda (abajo). El móvil nuevo enseña cuatro palabras de comprobación.", "And your vault number (below). The new phone shows four check words.")} />
        <ListRow icon="faceid" title={t("3. Confirma en este móvil", "3. Confirm on this phone")} subtitle={t("Aquí aparecerá «Cambio de móvil pedido» con las mismas cuatro palabras. Confírmalo con Face ID.", "«Phone change requested» will appear here with the same four words. Confirm it with Face ID.")} />
        <ListRow icon="checkmark.circle.fill" title={t("4. Listo", "4. Done")} subtitle={t("La wallet funciona en el móvil nuevo y se borra de este.", "The wallet works on the new phone and is deleted from this one.")} />
      </Group>
      <Card>
        <Row style={{ justifyContent: "space-between" }}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.muted, fontSize: 13 }}>{t("Número de tu bóveda", "Your vault number")}</Text>
            <Text style={{ color: colors.text, fontSize: 20, fontWeight: "600", marginTop: 2 }} selectable>
              {profile.vault.accountId}
            </Text>
          </View>
          <Button
            title={copied ? t("Copiado", "Copied") : t("Copiar", "Copy")}
            kind="secondary"
            icon="doc.on.doc"
            onPress={() => {
              void Clipboard.setStringAsync(profile.vault?.accountId ?? "");
              setCopied(true);
            }}
          />
        </Row>
      </Card>
      {kit ? (
        <Card tone={kitBalance != null && kitBalance < 100_000_000n ? "warn" : undefined}>
          <P style={{ marginBottom: 0 }}>
            {kitBalance != null && kitBalance < 100_000_000n
              ? t(
                  `El cambio lo paga la cuenta de tu kit (${kit}) y necesita al menos 1 HBAR: ahora tiene ${formatHbar(kitBalance)}. Mándale 1 HBAR antes.`,
                  `Your kit's account (${kit}) pays for the change and needs at least 1 HBAR: it has ${formatHbar(kitBalance)}. Send it 1 HBAR first.`,
                )
              : t(`El cambio lo paga la cuenta de tu kit (${kit}): menos de 1 HBAR.`, `Your kit's account (${kit}) pays for the change: under 1 HBAR.`)}
          </P>
        </Card>
      ) : null}
      <Card>
        <P muted style={{ marginBottom: 0 }}>
          {t(
            "Si alguna vez aparece aquí un cambio de móvil que no has pedido tú, no lo confirmes: alguien tiene tu kit. Sin este móvil no puede terminarlo, pero evacúa la bóveda y crea una con un kit nuevo.",
            "If a phone change you didn't request ever appears here, don't confirm it: someone has your kit. Without this phone they can't finish it, but evacuate the vault and create one with a new kit.",
          )}
        </P>
      </Card>
    </Screen>
  );
}
