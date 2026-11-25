import React, { useEffect, useMemo, useState } from "react";
import { Pressable, Switch, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import QRCode from "react-native-qrcode-svg";
import { DELAYS2, DELAY_CHOICES, NETWORKS, minPocketForVault, vaultSetupReserve, formatCountdown, formatDelay, formatHbar, nodeAprPercent, nodeIsFull, nodeLabel, normalizePassword, parseHbar, passwordStrength, pickStakingNode, suggestPassphrase, vaultRoom } from "@boveda/core";
import { Badge, Big, Button, Card, Choice, Field, Group, H2, Icon, ListRow, Mono, P, Row, Screen, SectionTitle, Segmented, Steps } from "../ui";
import { usePrefs } from "../prefs";
import { usePrices } from "../prices";
import { H10XMark, VaultDial } from "../components/VaultDial";
import { colors, space, typeface } from "../theme";
import { useWallet } from "../wallet";
import { useWallets } from "../wallets";
import { useGuardianStatus } from "../guardianStatus";
import { NETWORK, allowTestDelays, buildMaxVaultHbar, isMainnet } from "../env";
import { lang, t, when } from "../i18n";
import { haptic, open, run, useNow, useProtectSecrets } from "../helpers";

/** Idioma de la app (también en Ajustes → Preferencias). Antes de tener bóveda no hay Ajustes: por eso va aquí. */
function LanguageSwitch() {
  const { prefs, setPrefs } = usePrefs();
  return (
    <Row style={{ justifyContent: "flex-end" }}>
      <Icon name="globe" size={16} color={colors.muted} />
      <Segmented
        value={prefs.lang}
        onChange={(lang) => void setPrefs({ lang })}
        options={[
          { value: "auto", label: "Auto" },
          { value: "es", label: "Español" },
          { value: "en", label: "English" },
        ]}
      />
    </Row>
  );
}

/** Beta en mainnet: qué es y qué riesgos tiene. Hay que aceptarlo antes de crear o recuperar una cartera. */
function MainnetBetaCard({ accepted, onChange }: { accepted: boolean; onChange: (v: boolean) => void }) {
  return (
    <Card tone="warn" style={{ marginBottom: space.l }}>
      <H2>{t("Beta en mainnet: dinero de verdad", "Mainnet beta: real money")}</H2>
      <P>
        {t(
          `Esta versión mueve HBAR reales. El código lo hemos revisado nosotros, sin auditoría externa, y puede tener fallos. Guarda solo lo que puedas permitirte perder: cada bóveda admite como mucho ${buildMaxVaultHbar} HBAR durante la beta.`,
          `This version moves real HBAR. We reviewed the code ourselves, with no external audit, and it may have bugs. Only store what you can afford to lose: each vault holds at most ${buildMaxVaultHbar} HBAR during the beta.`,
        )}
      </P>
      <P muted style={{ marginBottom: space.s }}>
        {t(
          "Nadie del equipo te pedirá nunca tus 24 palabras ni que mandes dinero a una cuenta suya.",
          "No one from the team will ever ask for your 24 words or for you to send money to their account.",
        )}
      </P>
      <Group>
        <ListRow
          icon="checkmark.shield.fill"
          title={t("Lo entiendo", "I understand")}
          right={<Switch value={accepted} onValueChange={onChange} trackColor={{ true: colors.brass, false: colors.surfaceStrong }} />}
        />
      </Group>
    </Card>
  );
}

export function Welcome({ onRecover, onStolen, onMoveIn, onWallets, onFriends }: { onRecover: () => void; onStolen: () => void; onMoveIn: () => void; onWallets?: () => void; onFriends?: () => void }) {
  const { createWallet } = useWallet();
  const { wallets } = useWallets();
  const [busy, setBusy] = useState(false);
  // En mainnet hay que aceptar el aviso de la beta antes de crear o recuperar.
  const [accepted, setAccepted] = useState(!isMainnet);
  return (
    <Screen>
      <LanguageSwitch />
      <View style={{ marginTop: space.l, marginBottom: space.l }}>
        <VaultDial fraction={0.75} size={230} center={<H10XMark width={110} />} />
      </View>
      <Text style={{ color: colors.text, fontSize: 38, textAlign: "center", letterSpacing: -0.4, fontFamily: typeface.displayBold, fontWeight: typeface.displayBold ? undefined : "800" }}>H10X Wallet</Text>
      <P muted center style={{ marginBottom: space.xl }}>
        {t("Tu dinero en Hedera, a salvo aunque te roben una llave.", "Your money on Hedera, safe even if a key is stolen.")}
      </P>
      <Group style={{ marginBottom: space.xl }}>
        <ListRow icon="key.horizontal.fill" title={t("Ninguna llave sola basta", "No single key is enough")} subtitle={t("Ni la del móvil ni tu kit de rescate pueden vaciarla al momento.", "Neither your phone's key nor your rescue kit can empty it instantly.")} />
        <ListRow icon="timer" title={t("Cuenta atrás para sacar", "A countdown to withdraw")} subtitle={t("Si no has sido tú, lo ves y lo bloqueas con un toque.", "If it wasn't you, you see it and block it with one tap.")} />
        <ListRow icon="lifepreserver.fill" title={t("Recuperable", "Recoverable")} subtitle={t("Si pierdes el móvil, recuperas todo con tus 24 palabras.", "If you lose your phone, you recover everything with your 24 words.")} />
      </Group>
      {isMainnet ? <MainnetBetaCard accepted={accepted} onChange={setAccepted} /> : null}
      <Button
        title={t("Crear mi cartera", "Create my wallet")}
        busy={busy}
        disabled={!accepted}
        onPress={() =>
          void run(t("No se pudo crear la cartera", "Could not create the wallet"), async () => {
            setBusy(true);
            try {
              await createWallet();
            } finally {
              setBusy(false);
            }
          })
        }
      />
      <Button title={t("Ya tengo H10X Wallet en otro móvil", "I already have H10X Wallet on another phone")} kind="secondary" onPress={onMoveIn} disabled={!accepted} style={{ marginTop: space.s }} />
      <Button title={t("Tengo un kit de rescate", "I have a rescue kit")} kind="ghost" onPress={onRecover} disabled={!accepted} style={{ marginTop: space.s }} />
      {onFriends ? <Button title={t("Recuperar con mis amigos", "Recover with my friends")} kind="ghost" icon="person.3.fill" onPress={onFriends} disabled={!accepted} /> : null}
      <Button title={t("Me han robado el móvil", "My phone was stolen")} kind="ghost" onPress={onStolen} />
      {onWallets && wallets.length > 1 ? <Button title={t("Volver a mis otras wallets", "Back to my other wallets")} kind="ghost" icon="rectangle.stack.fill" onPress={onWallets} /> : null}
      <P muted center style={{ marginTop: space.l, fontSize: 13 }}>
        {isMainnet
          ? t("Hedera mainnet · beta", "Hedera mainnet · beta")
          : t(`Red de pruebas (${NETWORK}): los HBAR no tienen valor real.`, `Test network (${NETWORK}): HBAR here has no real value.`)}
      </P>
    </Screen>
  );
}

/** Tarjeta de una recuperación en curso hacia esta cartera (móvil anterior perdido). */
function PendingRecoveryCard({ onRecover }: { onRecover: () => void }) {
  const { profile, completeRecovery } = useWallet();
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const r = profile?.pendingRecovery;
  if (!r) return null;
  const left = r.executableAt - now;
  const late = left < -60;
  if (r.blockedUntil) {
    const reopen = r.blockedUntil > now;
    return (
      <Card tone="danger">
        <H2>{t("Tu móvil antiguo ha frenado la recuperación", "Your old phone stopped the recovery")}</H2>
        <Big color={colors.text}>{formatHbar(BigInt(r.tinybars))} HBAR</Big>
        <P>
          {t(
            "El dinero sigue en la bóveda: no se ha movido. Quien tiene tu móvil ha congelado o bloqueado la recuperación.",
            "The money is still in the vault: it hasn't moved. Whoever has your phone froze or blocked the recovery.",
          )}
        </P>
        <P muted>
          {reopen
            ? t(`Podrás pedirla otra vez con tu kit desde el ${when(r.blockedUntil)}.`, `You can request it again with your kit from ${when(r.blockedUntil)}.`)
            : t("Ya puedes pedirla otra vez con tu kit.", "You can request it again with your kit now.")}
        </P>
        <Button title={t("Pedirla otra vez", "Request it again")} disabled={reopen} onPress={onRecover} />
      </Card>
    );
  }
  return (
    <Card tone="brass">
      <H2>{t("Recuperando tu bóveda", "Recovering your vault")}</H2>
      <Big color={colors.brass}>{formatHbar(BigInt(r.tinybars))} HBAR</Big>
      {r.tokens ? <P muted>{t(`Y ${r.tokens} token(s).`, `And ${r.tokens} token(s).`)}</P> : null}
      {r.nfts ? <P muted>{t(`Y ${r.nfts} NFT.`, `And ${r.nfts} NFT(s).`)}</P> : null}
      {r.later ? (
        <P muted>
          {t(
            `${r.later} token(s) se quedan por ahora en la bóveda: pueden cobrar una comisión al moverlos. Cuando llegue esto, pide otra recuperación con tu kit y saldrán solos, sin nada con qué cobrarla.`,
            `${r.later} token(s) stay in the vault for now: they can charge a fee to move. When this arrives, request another recovery with your kit and they'll go alone, with nothing to charge it from.`,
          )}
        </P>
      ) : null}
      <P>
        {left > 0
          ? t(`Llegarán a esta cartera en ${formatCountdown(left)}.`, `They reach this wallet in ${formatCountdown(left)}.`)
          : t("La cuenta atrás ha terminado: el guardián lo está completando.", "The countdown is over: the guardian is completing it.")}
      </P>
      <P muted>
        {t(
          "Mientras dura, tu móvil antiguo podría congelarla. Si lo tiene otra persona, no esperes: guarda bien tus 24 palabras.",
          "While it runs, your old phone could freeze it. If someone else has it, don't wait: keep your 24 words safe.",
        )}
      </P>
      {late ? (
        <Button
          title={t("Completar ahora", "Complete now")}
          kind="secondary"
          busy={busy}
          onPress={() =>
            void run(t("No se pudo completar", "Could not complete"), async () => {
              setBusy(true);
              try {
                await completeRecovery();
              } finally {
                setBusy(false);
              }
            })
          }
        />
      ) : null}
    </Card>
  );
}

export function Fund({ onContinue, onRecover, onMoveIn, onWallets }: { onContinue: () => void; onRecover: () => void; onMoveIn?: () => void; onWallets?: () => void }) {
  const { profile, balances, pullRefresh, refreshing, factoryReady } = useWallet();
  const { wallets } = useWallets();
  const { prices } = usePrices();
  const [copied, setCopied] = useState(false);
  if (!profile) return null;
  const address = profile.pocket.evmAddress;
  const exists = balances.pocket != null;
  // Crear la bóveda cuesta dólares (pagados en HBAR): el mínimo sale del precio de hoy.
  const hbarUsd = prices?.hbar.usd;
  // Con la fábrica de notarios (comprobada) cuesta bastante menos. Se cuenta con la contraseña de desempate, que va
  // puesta por defecto: sin ella, el notario se crea aparte y cuesta más (lo avisa la pantalla siguiente).
  const factory = factoryReady === true;
  const minPocket = minPocketForVault(hbarUsd, { factory });
  const setupCost = vaultSetupReserve(hbarUsd, { factory });
  const enough = (balances.pocket ?? 0n) >= minPocket;
  const faucet = NETWORKS[NETWORK].faucet;
  return (
    <Screen
      title={profile.pendingRecovery ? t("Tu cartera nueva", "Your new wallet") : isMainnet ? t("Recibe HBAR", "Get HBAR") : t("Recibe HBAR de prueba", "Get test HBAR")}
      refreshing={refreshing}
      onRefresh={() => void pullRefresh()}
    >
      <PendingRecoveryCard onRecover={onRecover} />
      <P>
        {isMainnet
          ? t(
              `Para crear la bóveda, tu cartera necesita al menos ${formatHbar(minPocket, 0)} HBAR (crearla cuesta unos ${formatHbar(setupCost, 0)}, y 3 se quedan en tu kit). Mándalos a esta dirección desde HashPack u otra wallet de Hedera. Muchos exchanges solo envían a cuentas 0.0.x: si el tuyo no acepta una dirección 0x, pásalos antes por HashPack.`,
              `To create the vault, your wallet needs at least ${formatHbar(minPocket, 0)} HBAR (creating it costs about ${formatHbar(setupCost, 0)}, and 3 stay in your kit). Send them to this address from HashPack or another Hedera wallet. Many exchanges only send to 0.0.x accounts: if yours doesn't accept a 0x address, send them through HashPack first.`,
            )
          : t(
              `Para crear la bóveda, tu cartera necesita al menos ${formatHbar(minPocket, 0)} HBAR. En la red de pruebas son gratis: pega esta dirección en el faucet de Hedera.`,
              `To create the vault, your wallet needs at least ${formatHbar(minPocket, 0)} HBAR. On the test network they're free: paste this address into the Hedera faucet.`,
            )}
      </P>
      <Card>
        <View style={{ alignItems: "center", marginBottom: space.l }}>
          <View style={{ backgroundColor: "#fff", padding: space.m, borderRadius: 12 }}>
            <QRCode value={address} size={160} />
          </View>
        </View>
        <Mono>{address}</Mono>
        <Row style={{ marginTop: space.s }}>
          <Button
            title={copied ? t("Copiada", "Copied") : t("Copiar dirección", "Copy address")}
            kind="secondary"
            style={{ flex: 1 }}
            onPress={() => {
              void Clipboard.setStringAsync(address);
              setCopied(true);
            }}
          />
          {faucet ? <Button title={t("Abrir faucet", "Open faucet")} kind="secondary" style={{ flex: 1 }} onPress={() => open(faucet)} /> : null}
        </Row>
      </Card>
      <Card tone={enough ? "accent" : undefined}>
        <Row style={{ justifyContent: "space-between" }}>
          <H2>{t("Saldo de la cartera", "Wallet balance")}</H2>
          {exists ? <Badge text={profile.pocket.accountId ?? ""} tone="blue" /> : <Badge text={t("esperando", "waiting")} tone="warn" />}
        </Row>
        <Big>{exists ? `${formatHbar(balances.pocket ?? 0n)} HBAR` : "—"}</Big>
        <P muted>
          {exists
            ? enough
              ? t("Ya puedes crear tu bóveda.", "You can now create your vault.")
              : t("Aún no llega al mínimo.", "Not at the minimum yet.")
            : t("Se actualiza solo cuando lleguen los HBAR.", "It updates by itself when the HBAR arrive.")}
        </P>
      </Card>
      <Button title={t("Crear mi bóveda", "Create my vault")} disabled={!enough} onPress={onContinue} />
      {!profile.pendingRecovery ? <Button title={t("Recuperar una bóveda con mi kit", "Recover a vault with my kit")} kind="ghost" style={{ marginTop: space.s }} onPress={onRecover} /> : null}
      {!profile.pendingRecovery && onMoveIn && !balances.pocket ? <Button title={t("Ya tengo H10X Wallet en otro móvil", "I already have H10X Wallet on another phone")} kind="ghost" onPress={onMoveIn} /> : null}
      {onWallets && wallets.length > 1 ? <Button title={t("Mis otras wallets", "My other wallets")} kind="ghost" icon="rectangle.stack.fill" onPress={onWallets} /> : null}
    </Screen>
  );
}

/** Plazos de la v2: retirada con el móvil (24 h por defecto, hasta 7 días) y recuperación con el kit (7 o 14 días). */
export type Delays = { mode: "normal" | "test"; withdraw: number; recovery: number };
export const DEFAULT_DELAYS: Delays = { mode: "normal", withdraw: DELAYS2.standard.withdraw, recovery: DELAYS2.standard.recovery };
export const delaysOf = (d: Delays) => (d.mode === "test" && allowTestDelays ? DELAYS2.test : { withdraw: d.withdraw, recovery: d.recovery });

export function DelayPicker({ value, onChange }: { value: Delays; onChange: (v: Delays) => void }) {
  // En mainnet no hay modo «Prueba»: solo los plazos de verdad.
  const mode = allowTestDelays ? value.mode : "normal";
  return (
    <>
      {allowTestDelays ? (
        <>
          <Segmented
            options={[
              { value: "normal", label: t("Normal", "Standard") },
              { value: "test", label: t("Prueba (minutos)", "Test (minutes)") },
            ]}
            value={value.mode}
            onChange={(m) => onChange({ ...value, mode: m })}
          />
          <View style={{ height: space.m }} />
        </>
      ) : null}
      {mode === "test" ? (
        <Card>
          <P muted style={{ marginBottom: 0 }}>
            {t(
              `Retirada ${formatDelay(DELAYS2.test.withdraw)} y recuperación ${formatDelay(DELAYS2.test.recovery)}: solo para probar sin esperar, nunca con dinero de verdad.`,
              `Withdrawal ${formatDelay(DELAYS2.test.withdraw)} and recovery ${formatDelay(DELAYS2.test.recovery)}: only to try it without waiting, never with real money.`,
            )}
          </P>
        </Card>
      ) : (
        <>
          <SectionTitle>{t("Cuenta atrás para sacar (móvil)", "Countdown to withdraw (phone)")}</SectionTitle>
          <Choice
            value={String(value.withdraw)}
            onChange={(v) => onChange({ ...value, withdraw: Number(v) })}
            options={DELAY_CHOICES.withdraw.map((sec, i) => ({
              value: String(sec),
              label: formatDelay(sec),
              detail: i === 0 ? t("Recomendado: bastante para reaccionar sin esperar demasiado.", "Recommended: enough time to react without waiting too long.") : undefined,
            }))}
          />
          <SectionTitle>{t("Cuenta atrás para recuperar (kit)", "Countdown to recover (kit)")}</SectionTitle>
          <Choice
            value={String(value.recovery)}
            onChange={(v) => onChange({ ...value, recovery: Number(v) })}
            options={DELAY_CHOICES.recovery.map((sec, i) => ({
              value: String(sec),
              label: formatDelay(sec),
              detail: i === 0 ? t("Recomendado.", "Recommended.") : t("Más margen si alguien roba tus 24 palabras; más espera si pierdes el móvil.", "More margin if someone steals your 24 words; a longer wait if you lose your phone."),
            }))}
          />
        </>
      )}
    </>
  );
}

/** Contraseña de desempate que se elige al crear la bóveda (o al ponérsela después). */
export type PasswordPlan = { on: boolean; password: string; confirm: string };
export const newPasswordPlan = (on = true): PasswordPlan => ({ on, password: suggestPassphrase(lang()), confirm: "" });
export const passwordReady = (p: PasswordPlan) => !p.on || (passwordStrength(p.password).ok && normalizePassword(p.password) === normalizePassword(p.confirm));

export function PasswordSetup({ value, onChange, optional = true }: { value: PasswordPlan; onChange: (p: PasswordPlan) => void; optional?: boolean }) {
  const strength = passwordStrength(value.password);
  const mismatch = value.confirm.trim().length > 0 && normalizePassword(value.confirm) !== normalizePassword(value.password);
  return (
    <>
      <SectionTitle>{t("Contraseña de desempate", "Tiebreaker password")}</SectionTitle>
      <P muted>
        {t(
          "Si alguna vez el móvil y el kit están en manos distintas (por ejemplo, te roban el móvil), la recuperación con el kit y esta contraseña gana: el móvil no puede pararla ni congelarla. Si la olvidas, solo pierdes el desempate; el kit sigue funcionando.",
          "If the phone and the kit ever end up in different hands (say your phone is stolen), recovering with the kit and this password wins: the phone can't stop or freeze it. If you forget it, you only lose the tiebreaker; the kit still works.",
        )}
      </P>
      {optional ? (
        <Choice
          value={value.on ? "on" : "off"}
          onChange={(v) => onChange({ ...value, on: v === "on" })}
          options={[
            { value: "on", label: t("Con contraseña", "With a password"), detail: t("Recomendado.", "Recommended.") },
            { value: "off", label: t("Sin contraseña", "No password"), detail: t("Quien tenga tu móvil podría congelar tu recuperación una y otra vez.", "Whoever has your phone could freeze your recovery again and again.") },
          ]}
        />
      ) : null}
      {value.on ? (
        <>
          <Field
            label={t("Contraseña", "Password")}
            value={value.password}
            onChangeText={(password) => onChange({ ...value, password })}
            hint={
              strength.ok
                ? t("Son palabras al azar. Puedes cambiarlas por las tuyas.", "These are random words. You can swap them for your own.")
                : t("Usa al menos 5 palabras distintas, de 3 letras o más.", "Use at least 5 different words of 3 letters or more.")
            }
          />
          <Button title={t("Proponer otra", "Suggest another")} kind="ghost" style={{ marginTop: -space.s, marginBottom: space.m }} onPress={() => onChange({ ...value, password: suggestPassphrase(lang()), confirm: "" })} />
          <Field
            label={t("Escríbela otra vez", "Type it again")}
            value={value.confirm}
            onChangeText={(confirm) => onChange({ ...value, confirm })}
            hint={mismatch ? t("No coincide.", "It doesn't match.") : t("Las mayúsculas, las tildes y los espacios de más dan igual.", "Capitals, accents and extra spaces don't matter.")}
          />
          <Card tone="warn">
            <P style={{ marginBottom: 0 }}>
              {t(
                "Apúntala en un papel distinto al del kit y guárdalos en sitios distintos. Quien tenga los dos papeles gana el desempate.",
                "Write it on a different paper from the kit and keep them in different places. Whoever has both papers wins the tiebreaker.",
              )}
            </P>
          </Card>
        </>
      ) : null}
    </>
  );
}

const STEPS = (password: boolean) => [
  t("Conectando con el guardián", "Connecting to the guardian"),
  password ? t("Preparando tu kit y la llave de tu contraseña", "Preparing your kit and your password's key") : t("Preparando tu kit de rescate", "Preparing your rescue kit"),
  t("Creando tu notario", "Creating your notary"),
  t("Creando la bóveda", "Creating the vault"),
  t("Activando el guardián", "Activating the guardian"),
  t("Listo", "Done"),
];

/** Nodo de staking al crear la bóveda: "auto" (el que más paga), uno concreto o null (sin staking). */
export type NodeChoice = number | null | "auto";

function NodePicker({ value, onChange }: { value: NodeChoice; onChange: (v: NodeChoice) => void }) {
  const { stakingNodes, loadStakingNodes } = useWallet();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    void loadStakingNodes().catch(() => undefined);
  }, [loadStakingNodes]);
  const best = useMemo(() => pickStakingNode(stakingNodes), [stakingNodes]);
  const pct = (n: number) => `${n.toLocaleString(lang() === "en" ? "en-US" : "es-ES", { maximumFractionDigits: 2 })} %`;
  const bestNode = stakingNodes.find((n) => n.nodeId === best) ?? null;
  const chosen = typeof value === "number" ? (stakingNodes.find((n) => n.nodeId === value) ?? null) : value === "auto" ? bestNode : null;
  const title =
    value === "auto"
      ? bestNode
        ? t(`Recomendado · ${nodeLabel(bestNode, lang())}`, `Recommended · ${nodeLabel(bestNode, lang())}`)
        : t("Recomendado (el que más paga)", "Recommended (the best-paying one)")
      : value === null
        ? t("Sin staking", "No staking")
        : chosen
          ? nodeLabel(chosen, lang())
          : t(`Nodo ${value}`, `Node ${value}`);
  const apr = chosen ? nodeAprPercent(chosen) : 0;
  const current = value === null ? "none" : value === "auto" ? "auto" : String(value);
  return (
    <>
      <SectionTitle>{t("Rendimiento (staking)", "Yield (staking)")}</SectionTitle>
      <P muted>
        {t(
          "Tu bóveda y tu Cartera hacen staking nativo en Hedera: sus HBAR generan HBAR sin salir de ellas. Si eliges el nodo ahora, no hay cuenta atrás; cambiarlo después en la bóveda sí la tiene.",
          "Your vault and your Wallet use Hedera native staking: their HBAR earn HBAR without leaving them. If you choose the node now there's no countdown; changing it later on the vault does have one.",
        )}
      </P>
      <Group style={{ marginBottom: open ? space.s : space.l }}>
        <ListRow
          icon="leaf.fill"
          title={title}
          subtitle={apr > 0 ? t(`≈ ${pct(apr)} al año hoy`, `≈ ${pct(apr)} a year today`) : undefined}
          value={open ? t("Cerrar", "Close") : t("Cambiar", "Change")}
          onPress={() => setOpen(!open)}
        />
      </Group>
      {open ? (
        <Choice
          options={[
            { value: "auto", label: t("Recomendado (el que más paga sin estar lleno)", "Recommended (best-paying, not full)"), detail: bestNode ? nodeLabel(bestNode, lang()) : undefined },
            ...stakingNodes.map((n) => ({
              value: String(n.nodeId),
              label: nodeLabel(n, lang()),
              detail: [nodeAprPercent(n) > 0 ? t(`≈ ${pct(nodeAprPercent(n))} al año`, `≈ ${pct(nodeAprPercent(n))} a year`) : null, nodeIsFull(n) ? t("Lleno: paga menos", "Full: pays less") : null].filter(Boolean).join(" · ") || undefined,
            })),
            { value: "none", label: t("Sin staking", "No staking") },
          ]}
          value={current}
          onChange={(v) => {
            onChange(v === "auto" ? "auto" : v === "none" ? null : Number(v));
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

/** Las 24 palabras en dos columnas, numeradas. */
function KitWords({ words }: { words: string[] }) {
  return (
    <Card>
      <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
        {words.map((w, i) => (
          <View key={i} style={{ width: "50%", paddingVertical: 6 }}>
            <Text style={{ color: colors.text, fontSize: 16 }}>
              <Text style={{ color: colors.muted }}>{String(i + 1).padStart(2, " ")}. </Text>
              {w}
            </Text>
          </View>
        ))}
      </View>
    </Card>
  );
}

/** Orden al azar (Fisher-Yates) de las posiciones 0…n-1. */
function shuffled(n: number): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Comprobación del kit, como en CKBull: las 24 palabras desordenadas y se tocan en orden. Una palabra que no toca no
 * se pone (y se dice cuál falta); «Deshacer» quita la última. El progreso lo guarda quien la usa, así que se puede
 * volver a ver las palabras y seguir donde se iba.
 */
export function KitOrder({ words, picked, onPicked, order }: { words: string[]; picked: number[]; onPicked: (p: number[]) => void; order: number[] }) {
  const [miss, setMiss] = useState<number | null>(null);
  const next = picked.length;
  const used = new Set(picked);
  return (
    <>
      <Card>
        <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
          {words.map((_, i) => (
            <View key={i} style={{ width: "50%", paddingVertical: 4 }}>
              <Text style={{ color: i < next ? colors.text : i === next ? colors.brass : colors.faint, fontSize: 15 }}>
                <Text style={{ color: colors.muted }}>{String(i + 1).padStart(2, " ")}. </Text>
                {i < next ? words[picked[i]] : i === next ? "…" : ""}
              </Text>
            </View>
          ))}
        </View>
      </Card>
      {miss != null ? <P style={{ color: colors.danger }}>{t(`Esa no es la palabra n.º ${miss + 1}. Mira tu papel o vuelve a ver las palabras.`, `That isn't word #${miss + 1}. Check your paper or see the words again.`)}</P> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.s, marginBottom: space.l }}>
        {order.map((idx) => {
          const done = used.has(idx);
          return (
            <Pressable
              key={idx}
              disabled={done || next >= words.length}
              onPress={() => {
                // Vale cualquier palabra igual a la que toca (un kit puede repetir alguna).
                if (words[idx] === words[next]) {
                  haptic.tap();
                  setMiss(null);
                  onPicked([...picked, idx]);
                } else {
                  haptic.error();
                  setMiss(next);
                }
              }}
              accessibilityRole="button"
              accessibilityLabel={words[idx]}
              accessibilityState={{ disabled: done }}
              style={({ pressed }) => ({
                paddingHorizontal: space.m,
                paddingVertical: 8,
                borderRadius: 999,
                borderWidth: 1,
                borderColor: done ? colors.hairline : colors.brass,
                backgroundColor: pressed ? colors.surfaceStrong : colors.surface,
                opacity: done ? 0.3 : 1,
              })}
            >
              <Text style={{ color: colors.text, fontSize: 15 }}>{words[idx]}</Text>
            </Pressable>
          );
        })}
      </View>
      {next > 0 ? (
        <Button
          title={t("Deshacer la última", "Undo the last one")}
          kind="ghost"
          onPress={() => {
            setMiss(null);
            onPicked(picked.slice(0, -1));
          }}
        />
      ) : null}
    </>
  );
}

const KIT_WARNING = () =>
  t(
    "Apúntalas en papel, en orden, y guárdalo en casa, lejos del móvil. Si haces una captura, pásala a papel o a otro dispositivo y bórrala: el móvil y el kit juntos vacían la bóveda al momento. Nadie de soporte te las pedirá jamás.",
    "Write them on paper, in order, and keep it at home, away from the phone. If you take a screenshot, copy it to paper or another device and delete it: the phone and the kit together empty the vault instantly. Support will never ask you for them.",
  );

type CreateStep = "settings" | "words" | "order" | "creating";

/**
 * Crear la bóveda, como en CKBull: 1) nombre, cuentas atrás, contraseña y nodo; 2) las 24 palabras (todavía no hay
 * nada en la red); 3) se tocan en orden, pudiendo volver a verlas; 4) solo entonces se crea la bóveda con ese kit,
 * que no se guarda en el móvil.
 */
export function CreateVault({ onBack, onDone }: { onBack: () => void; onDone: (vaultId: string, password?: string | null) => void }) {
  const { setupVault, newKitWords, balances, fees, factoryReady, profile } = useWallet();
  const { prices } = usePrices();
  const { limits } = useGuardianStatus();
  const [screen, setScreen] = useState<CreateStep>("settings");
  useProtectSecrets({ allowScreenshots: screen === "words" || screen === "order" });
  const [name, setName] = useState(profile?.name ?? "");
  const [delays, setDelays] = useState<Delays>(DEFAULT_DELAYS);
  const [pw, setPw] = useState<PasswordPlan>(() => newPasswordPlan());
  const [node, setNode] = useState<NodeChoice>("auto");
  // Guardar al crearla es opcional: se puede guardar después desde Inicio.
  const [amount, setAmount] = useState("0");
  const [step, setStep] = useState(-1);
  const [words, setWords] = useState<string[] | null>(null);
  const [order, setOrder] = useState<number[]>([]);
  const [picked, setPicked] = useState<number[]>([]);
  const deposit = parseHbar(amount) ?? 0n;
  const available = balances.pocket ?? 0n;
  const fee = deposit > 0n ? (fees?.deposit ?? 0n) : 0n;
  // Crear la bóveda cuesta dólares, pagados en HBAR: la reserva sale del precio de hoy (con margen). Con contraseña y
  // fábrica de notarios, el notario sale de la fábrica y cuesta mucho menos; sin contraseña se despliega aparte.
  const viaFactory = factoryReady === true && pw.on;
  const reserve = vaultSetupReserve(prices?.hbar.usd, { factory: viaFactory });
  const extraWithoutPassword = factoryReady === true && !pw.on ? vaultSetupReserve(prices?.hbar.usd) - vaultSetupReserve(prices?.hbar.usd, { factory: true }) : 0n;
  // Beta: tope de HBAR por bóveda (lo publica el guardián; 0 = sin tope).
  const room = vaultRoom(0n, limits.maxVaultHbar);
  const overCap = room != null && deposit > room;
  const valid = deposit >= 0n && !overCap && deposit + fee + reserve <= available && passwordReady(pw);
  const allPicked = !!words && picked.length === words.length;

  const toWords = () =>
    void run(t("No se pudo preparar el kit", "Could not prepare the kit"), async () => {
      if (!words) {
        const w = await newKitWords();
        setWords(w);
        setOrder(shuffled(w.length));
        setPicked([]);
      }
      setScreen("words");
    });

  const create = () =>
    void run(t("No se pudo crear la bóveda", "Could not create the vault"), async () => {
      if (!words || !allPicked) return;
      setScreen("creating");
      setStep(0);
      try {
        const d = delaysOf(delays);
        const password = pw.on ? pw.password : null;
        const out = await setupVault({ withdrawDelay: d.withdraw, recoveryDelay: d.recovery, depositTinybars: deposit, password, hbarUsd: prices?.hbar.usd ?? null, onStep: setStep, words, stakedNodeId: node, name });
        setWords(null);
        onDone(out.vaultId, password);
      } catch (e) {
        // Nada creado o a medias: se vuelve al resumen con el mismo kit (ya comprobado) para reintentar.
        setScreen("order");
        throw e;
      } finally {
        setStep(-1);
      }
    });

  if (screen === "creating") {
    return (
      <Screen title={t("Crea tu bóveda", "Create your vault")}>
        <Card>
          <H2>{t("Creando tu bóveda", "Creating your vault")}</H2>
          <Steps steps={STEPS(pw.on)} current={step} />
          <P muted>{t("Tarda unos segundos. No cierres la app.", "It takes a few seconds. Don't close the app.")}</P>
        </Card>
      </Screen>
    );
  }

  if (screen === "words" && words) {
    return (
      <Screen title={t("Tu kit de rescate", "Your rescue kit")} onBack={() => setScreen("settings")}>
        <P muted>{t("Paso 2 de 3 · apunta las palabras", "Step 2 of 3 · write the words down")}</P>
        <Card tone="brass">
          <P>{t("Con estas 24 palabras recuperas tu dinero aunque pierdas el móvil.", "With these 24 words you recover your money even if you lose your phone.")}</P>
          <P style={{ marginBottom: 0 }}>{KIT_WARNING()}</P>
        </Card>
        <KitWords words={words} />
        <Button title={picked.length ? t("Seguir comprobando", "Keep checking") : t("Ya las he apuntado", "I've written them down")} onPress={() => setScreen("order")} />
      </Screen>
    );
  }

  if (screen === "order" && words) {
    return (
      <Screen title={t("Comprueba tu kit", "Check your kit")} onBack={() => setScreen("words")}>
        <P muted>{t("Paso 3 de 3 · comprueba el kit", "Step 3 of 3 · check the kit")}</P>
        <P>{t("Toca las palabras en orden, de la 1 a la 24, mirando tu papel.", "Tap the words in order, from 1 to 24, looking at your paper.")}</P>
        <KitOrder words={words} picked={picked} onPicked={setPicked} order={order} />
        <Button title={t("Ver las palabras", "See the words")} kind="secondary" icon="doc.on.doc" onPress={() => setScreen("words")} style={{ marginBottom: space.s }} />
        {allPicked ? (
          <Card tone="accent">
            <P style={{ marginBottom: 0 }}>{t("Las 24 están bien. Ahora se crea la bóveda con este kit; después se borra del móvil.", "All 24 are right. Now the vault is created with this kit; then it's deleted from the phone.")}</P>
          </Card>
        ) : null}
        <Button title={t("Crear bóveda", "Create vault")} disabled={!allPicked} onPress={create} />
      </Screen>
    );
  }

  return (
    <Screen title={t("Crea tu bóveda", "Create your vault")} onBack={onBack}>
      <P muted>{t("Paso 1 de 3 · ajustes", "Step 1 of 3 · settings")}</P>
      <Field label={t("Nombre de la wallet", "Wallet name")} placeholder={t("Mi wallet", "My wallet")} value={name} onChangeText={setName} maxLength={32} autoCapitalize="sentences" hint={t("Solo se ve en este móvil. Puedes cambiarlo en Ajustes.", "Only shown on this phone. You can change it in Settings.")} />
      <P>
        {t(
          "Elige las cuentas atrás. Con el móvil sacas dinero tras la primera; con tu kit de rescate, si pierdes el móvil, tras la segunda. Mientras corren, la otra llave puede bloquearlas.",
          "Choose the countdowns. With the phone you withdraw after the first; with your rescue kit, if you lose the phone, after the second. While they run, the other key can block them.",
        )}
      </P>
      <DelayPicker value={delays} onChange={setDelays} />
      <Field
        label={t("HBAR que guardas al crearla", "HBAR you store when creating it")}
        value={amount}
        onChangeText={setAmount}
        keyboardType="decimal-pad"
        hint={[
          t(
            `Opcional: puedes dejarlo en 0 y guardar después. Disponible: ${formatHbar(available)} HBAR. Crear la bóveda cuesta unos ${formatHbar(reserve)} HBAR (3 se quedan en tu kit para sus comisiones).`,
            `Optional: you can leave it at 0 and store later. Available: ${formatHbar(available)} HBAR. Creating the vault costs about ${formatHbar(reserve)} HBAR (3 stay in your kit for its fees).`,
          ),
          fee > 0n ? t(`Comisión del servicio por el depósito: ${formatHbar(fee)} HBAR.`, `Service fee for the deposit: ${formatHbar(fee)} HBAR.`) : "",
          extraWithoutPassword > 0n ? t(`Sin contraseña de desempate el notario se crea aparte y cuesta unos ${formatHbar(extraWithoutPassword, 0)} HBAR más.`, `Without a tiebreaker password the notary is created separately and costs about ${formatHbar(extraWithoutPassword, 0)} HBAR more.`) : "",
          room != null ? t(`Durante la beta, cada bóveda guarda como mucho ${limits.maxVaultHbar} HBAR.`, `During the beta, each vault holds at most ${limits.maxVaultHbar} HBAR.`) : "",
        ]
          .filter(Boolean)
          .join(" ")}
      />
      <PasswordSetup value={pw} onChange={setPw} />
      <NodePicker value={node} onChange={setNode} />
      <Card>
        <P muted style={{ marginBottom: 0 }}>
          {t(
            "Se crea un contrato notario solo para ti y una bóveda que nadie puede vaciar con una sola llave. Guarda HBAR y cualquier token de Hedera. Con el móvil y el kit juntos sí puedes sacarlo todo al momento. Ahora verás tu kit de rescate: la bóveda se crea cuando lo hayas comprobado.",
            "A notary contract is created just for you, plus a vault nobody can empty with a single key. It holds HBAR and any Hedera token. With the phone and the kit together you can take everything out instantly. Next you'll see your rescue kit: the vault is created once you've checked it.",
          )}
        </P>
      </Card>
      <Button title={t("Ver mi kit de rescate", "See my rescue kit")} disabled={!valid} onPress={toWords} />
    </Screen>
  );
}

/** Después de crear la bóveda: su número y la contraseña de desempate, para apuntarlos. */
export function VaultReady({ vaultId, password, onDone }: { vaultId: string; password?: string | null; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const [pwWritten, setPwWritten] = useState(!password);
  return (
    <Screen title={t("Bóveda creada", "Vault created")}>
      <Card tone="accent">
        <P style={{ marginBottom: 0 }}>{t("Tu bóveda ya existe y tu kit está comprobado. Se ha borrado del móvil: solo lo tienes tú.", "Your vault exists and your kit is checked. It's been deleted from the phone: only you have it.")}</P>
      </Card>
      <Card>
        <P muted>{t("Apunta también el número de tu bóveda junto a las 24 palabras", "Also write down your vault number next to the 24 words")}</P>
        <Big>{vaultId}</Big>
        <Button
          title={copied ? t("Copiado", "Copied") : t("Copiar", "Copy")}
          kind="ghost"
          icon="doc.on.doc"
          onPress={() => {
            void Clipboard.setStringAsync(vaultId);
            setCopied(true);
          }}
        />
      </Card>
      {password ? (
        <>
          <Card>
            <P muted>{t("Tu contraseña de desempate", "Your tiebreaker password")}</P>
            <Big>{password}</Big>
            <P muted style={{ marginTop: space.s, marginBottom: 0 }}>
              {t(
                "Apúntala en OTRO papel y guárdalo en otro sitio. Con el kit, hace que tu recuperación gane aunque alguien tenga tu móvil. Sin el kit no sirve de nada.",
                "Write it on ANOTHER paper and keep it somewhere else. With the kit, it makes your recovery win even if someone has your phone. Without the kit it's useless.",
              )}
            </P>
          </Card>
          <Pressable onPress={() => setPwWritten(!pwWritten)} accessibilityRole="checkbox" accessibilityState={{ checked: pwWritten }}>
            <Row style={{ marginBottom: space.l }}>
              <Icon name={pwWritten ? "checkmark.square.fill" : "square"} size={24} color={pwWritten ? colors.brass : colors.muted} />
              <P style={{ flex: 1, marginBottom: 0 }}>{t("He apuntado la contraseña en otro papel, lejos del kit.", "I've written the password on another paper, away from the kit.")}</P>
            </Row>
          </Pressable>
        </>
      ) : null}
      <Button title={t("Ir a mi wallet", "Go to my wallet")} disabled={!pwWritten} onPress={onDone} />
    </Screen>
  );
}

/**
 * Kit guardado detrás de Face ID hasta comprobarlo (al pasar de la v1 a la v2, o kits de antes de la 0.9.4).
 * Misma comprobación que al crear: las 24 palabras en orden.
 */
export function RecoveryKit({ words, vaultId, password, onDone }: { words: string[]; vaultId: string; password?: string | null; onDone: () => void }) {
  useProtectSecrets({ allowScreenshots: true });
  const { confirmRecovery, profile } = useWallet();
  // Guardado hasta comprobarlo: se puede salir y volver a verlo desde Inicio.
  const saved = !!profile?.kitPending;
  const [written, setWritten] = useState(false);
  const [pwWritten, setPwWritten] = useState(!password);
  const [checking, setChecking] = useState(false);
  const order = useMemo(() => shuffled(words.length), [words]);
  const [picked, setPicked] = useState<number[]>([]);
  const allPicked = picked.length === words.length;

  if (checking) {
    return (
      <Screen title={t("Comprueba tu kit", "Check your kit")} onBack={() => setChecking(false)}>
        <P>{t("Toca las palabras en orden, de la 1 a la 24, mirando tu papel. Así sabemos que el kit está bien apuntado.", "Tap the words in order, from 1 to 24, looking at your paper. That way we know the kit is written down correctly.")}</P>
        <KitOrder words={words} picked={picked} onPicked={setPicked} order={order} />
        <Button title={t("Ver las palabras", "See the words")} kind="secondary" icon="doc.on.doc" onPress={() => setChecking(false)} style={{ marginBottom: space.s }} />
        <Button
          title={t("Comprobado", "Checked")}
          disabled={!allPicked}
          onPress={() =>
            void run("Error", async () => {
              await confirmRecovery();
              onDone();
            })
          }
        />
      </Screen>
    );
  }

  return (
    <Screen title={t("Tu kit de rescate", "Your rescue kit")} onBack={saved ? onDone : undefined}>
      <Card tone="brass">
        <P>{t("Con estas 24 palabras y el número de tu bóveda recuperas el dinero aunque pierdas el móvil.", "With these 24 words and your vault number you recover the money even if you lose your phone.")}</P>
        <P>{KIT_WARNING()}</P>
        {saved ? (
          <P muted style={{ marginBottom: 0 }}>
            {t(
              "Tómate tu tiempo: si sales o se bloquea el móvil, puedes volver a verlas desde Inicio (con Face ID) hasta que las compruebes. Después se borran del móvil.",
              "Take your time: if you leave or the phone locks, you can see them again from Home (with Face ID) until you check them. Then they're deleted from the phone.",
            )}
          </P>
        ) : null}
      </Card>
      <KitWords words={words} />
      <Card>
        <P muted>{t("Número de tu bóveda", "Your vault number")}</P>
        <Big>{vaultId}</Big>
      </Card>
      <Pressable onPress={() => setWritten(!written)} accessibilityRole="checkbox" accessibilityState={{ checked: written }}>
        <Row style={{ marginBottom: space.l }}>
          <Icon name={written ? "checkmark.square.fill" : "square"} size={24} color={written ? colors.brass : colors.muted} />
          <P style={{ flex: 1, marginBottom: 0 }}>{t("He apuntado las 24 palabras y el número de bóveda en papel.", "I've written the 24 words and the vault number on paper.")}</P>
        </Row>
      </Pressable>
      {password ? (
        <>
          <Card>
            <P muted>{t("Tu contraseña de desempate", "Your tiebreaker password")}</P>
            <Big>{password}</Big>
            <P muted style={{ marginTop: space.s, marginBottom: 0 }}>
              {t(
                "Apúntala en OTRO papel y guárdalo en otro sitio. Con el kit, hace que tu recuperación gane aunque alguien tenga tu móvil. Sin el kit no sirve de nada.",
                "Write it on ANOTHER paper and keep it somewhere else. With the kit, it makes your recovery win even if someone has your phone. Without the kit it's useless.",
              )}
            </P>
          </Card>
          <Pressable onPress={() => setPwWritten(!pwWritten)} accessibilityRole="checkbox" accessibilityState={{ checked: pwWritten }}>
            <Row style={{ marginBottom: space.l }}>
              <Icon name={pwWritten ? "checkmark.square.fill" : "square"} size={24} color={pwWritten ? colors.brass : colors.muted} />
              <P style={{ flex: 1, marginBottom: 0 }}>{t("He apuntado la contraseña en otro papel, lejos del kit.", "I've written the password on another paper, away from the kit.")}</P>
            </Row>
          </Pressable>
        </>
      ) : null}
      <Button title={picked.length ? t("Seguir comprobando", "Keep checking") : t("Continuar", "Continue")} disabled={!written || !pwWritten} onPress={() => setChecking(true)} />
    </Screen>
  );
}
