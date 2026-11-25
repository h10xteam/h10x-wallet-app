import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { dayChange, formatCountdown, formatDelay, formatHbar, summarizeAction, type Movement } from "@boveda/core";
import { Badge, Button, Card, Group, H2, Icon, IconButton, P, Row, RoundAction, Screen, SectionTitle, Segmented, TabBar, type Tab } from "../ui";
import { BrandTitle } from "../components/VaultDial";
import { AccountCard, BalanceHero, ProtectionBar } from "../components/Assets";
import { colors, space } from "../theme";
import { useWallet } from "../wallet";
import type { PendingKit } from "../storage";
import { useHoldings, useMarket } from "../market";
import { useGuardianStatus } from "../guardianStatus";
import { H10xCard } from "./H10x";
import { MoveRequestCard, MovedAwayCard } from "./Move";
import { HistoryList, useHistory } from "../history";
import { NETWORK, isExpoGo } from "../env";
import { lang, t, when } from "../i18n";
import { confirm, haptic, run, useNow } from "../helpers";
import { FriendsBanner } from "./Friends";

export type HomeAction = "send" | "receive" | "deposit" | "withdraw" | "settings" | "activity" | "evacuate" | "evacuate-kit" | "evacuate-device" | "migrate" | "staking" | "h10x" | "dao" | "vault" | "pocket";

const isOpen = (m: Movement) => m.status === "requested" && !m.executed && !m.expired;

/** Una operación de la bóveda, con su estado y lo que se puede hacer con ella. */
export function MovementRow({ m, mine, now, guardianActive }: { m: Movement; mine: boolean; now: number; guardianActive: boolean }) {
  const { veto, completeNow, freezeRecovery, meta } = useWallet();
  const [busy, setBusy] = useState<"" | "veto" | "approve" | "freeze">("");
  // El mirror node tarda unos segundos en reflejar un bloqueo o una aprobación: mientras tanto,
  // recordamos aquí lo que ya se ha hecho para no ofrecer el botón otra vez.
  const [done, setDone] = useState<"" | "vetoed" | "approved" | "superseded">("");
  const recovery = m.lane === "recovery";
  // Kit + contraseña de desempate: desde el móvil no se puede bloquear ni congelar.
  const priority = recovery && !!m.priority;
  const sum = summarizeAction(m.action, { lane: m.lane, meta, lang: lang() });
  const left = m.executableAt - now;
  const status = m.status === "requested" && done ? done : m.status;
  const open = status === "requested" && !m.executed && !m.expired;
  const badge = m.executed
    ? { text: t("Hecha", "Done"), tone: "accent" as const }
    : status === "vetoed"
      ? { text: t("Bloqueada", "Blocked"), tone: "danger" as const }
      : status === "superseded"
        ? { text: t("Anulada", "Cancelled"), tone: "danger" as const }
        : m.expired
          ? { text: t("Caducada", "Expired"), tone: "muted" as const }
          : status === "approved"
            ? { text: t("Completando", "Completing"), tone: "blue" as const }
            : left > 0
              ? { text: formatCountdown(left), tone: "warn" as const }
              : guardianActive && mine
                ? { text: t("Saliendo", "Going out"), tone: "blue" as const }
                : { text: t("Lista para salir", "Ready to go"), tone: "blue" as const };
  // Aprobada hace rato y sin ejecutar: le falta una firma y alguien podría dispararla cuando quiera.
  const loaded = status === "approved" && !m.executed && !m.expired && now > m.executableAt + 180;
  const suspicious = (open && (recovery || !mine || sum.unusual)) || loaded;
  // Solo tus propias retiradas se completan desde aquí (si no hay guardián o se retrasa).
  const canComplete = open && !recovery && mine && !sum.unusual && left <= 0 && (!guardianActive || left < -60);
  // El plazo para bloquear es la cuenta atrás; después, solo como último intento lo que no reconoces.
  const canVeto = open && (left > 0 || suspicious || !guardianActive);
  const late = left <= 0;
  const what = [sum.title, sum.detail].filter(Boolean).join(" ");

  const doVeto = () =>
    void run(t("No se pudo bloquear", "Could not block"), async () => {
      const text = late
        ? t(`${what}. La cuenta atrás ya ha terminado: puede que salga antes de que llegue el bloqueo.`, `${what}. The countdown is over: it may go out before the block arrives.`)
        : t(`${what}. No saldrá de la bóveda y no se puede deshacer.`, `${what}. It will not leave the vault, and this cannot be undone.`);
      const title = recovery ? t("¿Bloquear esta recuperación?", "Block this recovery?") : t("¿Bloquear esta operación?", "Block this operation?");
      if (!(await confirm(title, text, t("Bloquear", "Block"), true))) return;
      setBusy("veto");
      try {
        await veto(m);
        setDone("vetoed");
        haptic.success();
      } finally {
        setBusy("");
      }
    });

  const doFreeze = () =>
    void run(t("No se pudo congelar", "Could not freeze"), async () => {
      if (
        !(await confirm(
          t("¿Congelar las recuperaciones?", "Freeze recoveries?"),
          t("Se anulan todas las recuperaciones pendientes y nadie podrá pedir otra durante un tiempo.", "All pending recoveries are cancelled and nobody can request another one for a while."),
          t("Congelar", "Freeze"),
          true,
        ))
      )
        return;
      setBusy("freeze");
      try {
        await freezeRecovery();
        setDone("superseded");
        haptic.success();
      } finally {
        setBusy("");
      }
    });

  const tint = suspicious ? colors.danger : recovery ? colors.warn : m.executed ? colors.safe : colors.brass;
  const icon = recovery ? "key.fill" : m.action.kind === "staking" ? "leaf.fill" : m.action.kind === "settings" ? "gearshape.fill" : "arrow.up.right";
  return (
    <View style={{ padding: space.l, backgroundColor: suspicious ? colors.dangerSoft : "transparent" }}>
      <Row gap={space.m} style={{ alignItems: "flex-start" }}>
        <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: `${tint}22`, alignItems: "center", justifyContent: "center" }}>
          <Icon name={icon} size={15} color={tint} weight="bold" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: colors.text, fontSize: 16, fontWeight: "600" }}>{sum.title}</Text>
          {priority ? <Text style={{ color: colors.warn, fontSize: 13, marginTop: 2 }}>{t("Prioritaria: kit + contraseña", "Priority: kit + password")}</Text> : null}
          {sum.detail ? <Text style={{ color: colors.muted, fontSize: 13, marginTop: 2 }}>{sum.detail}</Text> : null}
          {sum.fee ? <Text style={{ color: colors.muted, fontSize: 13, marginTop: 2 }}>{sum.fee}</Text> : null}
        </View>
        <Badge text={badge.text} tone={badge.tone} />
      </Row>
      {suspicious ? (
        <P style={{ color: colors.danger, marginTop: space.m, marginBottom: 0 }}>
          {loaded
            ? t("Está aprobada pero no se ha ejecutado: le falta una firma y alguien podría dispararla más tarde. Ya no se puede bloquear: evacúa la bóveda con el móvil y el kit.", "It's approved but hasn't run: it's missing a signature and someone could fire it later. It can no longer be blocked: evacuate the vault with your phone and kit.")
            : priority
            ? t("Recuperación con tu kit y tu contraseña de desempate: el móvil no puede pararla. Si no has sido tú, evacúa la bóveda con el móvil y el kit antes de que acabe la cuenta atrás.", "Recovery with your kit and tiebreaker password: the phone can't stop it. If it wasn't you, evacuate the vault with your phone and kit before the countdown ends.")
            : recovery
            ? t("Alguien ha usado tu kit de rescate. Si no has sido tú, congela las recuperaciones.", "Someone used your rescue kit. If it wasn't you, freeze recoveries.")
            : t("No se pidió desde este móvil. Si no has sido tú, bloquéala.", "It wasn't requested from this phone. If it wasn't you, block it.")}
        </P>
      ) : null}
      {open && priority ? null : open && recovery ? (
        <Row style={{ marginTop: space.m }}>
          <Button title={t("Congelar", "Freeze")} icon="snowflake" kind="danger" style={{ flex: 1 }} busy={busy === "freeze"} onPress={doFreeze} />
          <Button title={t("Solo esta", "Just this one")} kind="secondary" style={{ flex: 1 }} busy={busy === "veto"} onPress={doVeto} />
        </Row>
      ) : open && (canVeto || canComplete) ? (
        <Row style={{ marginTop: space.m }}>
          {canVeto ? <Button title={t("Bloquear", "Block")} icon="hand.raised.fill" kind={suspicious ? "danger" : "secondary"} style={{ flex: 1 }} busy={busy === "veto"} onPress={doVeto} /> : null}
          {canComplete ? (
            <Button
              title={t("Completar ahora", "Complete now")}
              kind="secondary"
              style={{ flex: 1 }}
              busy={busy === "approve"}
              onPress={() =>
                void run(t("No se pudo completar", "Could not complete"), async () => {
                  setBusy("approve");
                  try {
                    await completeNow(m);
                    setDone("approved");
                    haptic.success();
                  } finally {
                    setBusy("");
                  }
                })
              }
            />
          ) : null}
        </Row>
      ) : null}
    </View>
  );
}

/** Avisos que importan más que cualquier otra cosa de la pantalla. */
/**
 * Aviso del equipo publicado en el guardián. Solo texto (sin enlaces, cuentas ni direcciones) y, si pide evacuar, un
 * botón a la pantalla de Evacuar de la propia app, que manda los fondos a la Cartera del dueño. No se puede cerrar
 * mientras siga puesto; el informativo, sí.
 */
function GuardianNoticeCard({ go }: { go: (a: HomeAction) => void }) {
  const { notice, dismiss } = useGuardianStatus();
  const { profile } = useWallet();
  if (!notice) return null;
  const text = lang() === "en" ? notice.en : notice.es;
  const evacuate = notice.level === "evacuar";
  return (
    <Card tone={evacuate ? "danger" : "accent"}>
      <Row gap={space.s} style={{ marginBottom: space.s }}>
        <Icon name={evacuate ? "exclamationmark.triangle.fill" : "info.circle.fill"} size={18} color={evacuate ? colors.danger : colors.accent} />
        <H2 style={{ marginBottom: 0, flex: 1 }}>{evacuate ? t("Aviso urgente del equipo", "Urgent notice from the team") : t("Aviso del equipo", "Notice from the team")}</H2>
        {evacuate ? null : (
          <Pressable onPress={() => dismiss(notice.id)} hitSlop={12} accessibilityRole="button" accessibilityLabel={t("Cerrar aviso", "Dismiss notice")}>
            <Icon name="xmark" size={16} color={colors.muted} />
          </Pressable>
        )}
      </Row>
      <P>{text}</P>
      {evacuate ? (
        <>
          <P muted style={{ fontSize: 13 }}>
            {t(
              "Por defecto, Evacuar manda todo a la Cartera de este móvil. Nunca te pediremos tus palabras ni que envíes fondos a una cuenta nuestra.",
              "By default, Evacuate sends everything to this phone's Wallet. We will never ask for your words or for funds sent to an account of ours.",
            )}
          </P>
          {profile?.vault ? <Button title={t("Evacuar ahora", "Evacuate now")} kind="danger" onPress={() => go("evacuate")} /> : null}
        </>
      ) : null}
    </Card>
  );
}

/** Kit sin comprobar: volver a verlo (si está guardado) o, si se perdió y la bóveda está vacía, crearla de nuevo. */
function KitCard({ onKit }: { onKit: (kit: PendingKit) => void }) {
  const { profile, openPendingKit, restartVault } = useWallet();
  const [busy, setBusy] = useState(false);
  if (!profile?.vault || profile.recoveryConfirmed) return null;
  return (
    <Card tone="warn">
      <P>
        {t(
          "No has comprobado tu kit de rescate. Sin él, si pierdes el móvil no podrás recuperar el dinero de la bóveda.",
          "You haven't checked your rescue kit. Without it, if you lose your phone you can't recover the money in the vault.",
        )}
      </P>
      {profile.kitPending ? (
        <Button
          title={t("Ver y apuntar mi kit", "Show and write down my kit")}
          busy={busy}
          onPress={() =>
            void run("Error", async () => {
              setBusy(true);
              try {
                const kit = await openPendingKit();
                if (kit) onKit(kit);
              } finally {
                setBusy(false);
              }
            })
          }
        />
      ) : (
        <>
          <P muted>
            {t(
              "¿No llegaste a apuntar las palabras? Ya no se pueden volver a ver. Si la bóveda está vacía, créala de nuevo con un kit nuevo: la Cartera y su saldo no cambian (cuesta las comisiones de crear la bóveda).",
              "Didn't get to write the words down? They can't be shown again. If the vault is empty, create it again with a new kit: the Wallet and its balance stay the same (it costs the vault creation fees).",
            )}
          </P>
          <Button
            title={t("Crear la bóveda de nuevo", "Create the vault again")}
            kind="secondary"
            busy={busy}
            onPress={() =>
              void run("Error", async () => {
                const ok = await confirm(
                  t("¿Crear la bóveda de nuevo?", "Create the vault again?"),
                  t(
                    "Dejas esta bóveda (vacía) y creas otra con un kit nuevo. Esta vez, apunta las 24 palabras en papel antes de seguir.",
                    "You leave this (empty) vault and create another with a new kit. This time, write the 24 words on paper before going on.",
                  ),
                  t("Crear de nuevo", "Create again"),
                );
                if (!ok) return;
                setBusy(true);
                try {
                  await restartVault();
                } finally {
                  setBusy(false);
                }
              })
            }
          />
        </>
      )}
    </Card>
  );
}

/** 0.10: el guardián ha dejado de vigilar la bóveda (p. ej. estaba lleno). Antes pasaba sin que nadie se enterase. */
function GuardianLostCard() {
  const { guardianLost, registerGuardian } = useWallet();
  const [busy, setBusy] = useState(false);
  if (!guardianLost) return null;
  return (
    <Card tone="warn">
      <Row gap={space.s} style={{ marginBottom: space.s }}>
        <Icon name="exclamationmark.triangle.fill" size={18} color={colors.warn} />
        <H2 style={{ marginBottom: 0, flex: 1 }}>{t("El guardián ya no vigila tu bóveda", "The guardian no longer watches your vault")}</H2>
      </Row>
      <P>
        {t(
          "Mientras no vuelvas a conectarla, nadie bloquea por ti lo que no reconozcas ni completa tus retiradas a su hora.",
          "Until you connect it again, nobody blocks what you don't recognise for you or completes your withdrawals on time.",
        )}
      </P>
      <Button
        title={t("Volver a conectar", "Connect again")}
        busy={busy}
        onPress={() =>
          void run(t("No se pudo conectar con el guardián", "Could not connect to the guardian"), async () => {
            setBusy(true);
            try {
              await registerGuardian();
              haptic.success();
            } finally {
              setBusy(false);
            }
          })
        }
      />
    </Card>
  );
}

function Alerts({ go, onKit }: { go: (a: HomeAction) => void; onKit: (kit: PendingKit) => void }) {
  const { profile, movements, locks, isV2, vaultTokensOn, enableVaultTokens } = useWallet();
  const now = useNow(5000);
  const [busy, setBusy] = useState(false);
  if (!profile?.vault) return null;
  const mine = new Set(profile.mySchedules);
  const kitUsed = movements.filter((m) => isOpen(m) && m.lane === "recovery");
  const kitPriority = kitUsed.some((m) => m.priority);
  const unknown = movements.filter((m) => isOpen(m) && m.lane === "withdraw" && !mine.has(m.scheduleId));
  const enabling = movements.some((m) => isOpen(m) && m.action.kind === "settings" && m.action.autoAssociations === -1);
  return (
    <>
      <MovedAwayCard />
      <MoveRequestCard onEvacuate={() => go("evacuate-kit")} />
      <GuardianLostCard />
      {kitUsed.length > 0 ? (
        <Card tone="danger">
          <Row gap={space.s} style={{ marginBottom: space.s }}>
            <Icon name="exclamationmark.triangle.fill" size={18} color={colors.danger} />
            <H2 style={{ marginBottom: 0, flex: 1 }}>{t("Alguien ha usado tu kit de rescate", "Someone used your rescue kit")}</H2>
          </Row>
          <P>
            {kitPriority
              ? t(
                  "Con el kit y tu contraseña de desempate: el móvil no puede pararla. Si no has sido tú, evacúa la bóveda con el móvil y el kit antes de que acabe la cuenta atrás.",
                  "With the kit and your tiebreaker password: the phone can't stop it. If it wasn't you, evacuate the vault with your phone and kit before the countdown ends.",
                )
              : t(
                  "Si no has sido tú, congela las recuperaciones en Actividad antes de que acabe la cuenta atrás. Después evacúa la bóveda: ese kit ya no es seguro.",
                  "If it wasn't you, freeze recoveries in Activity before the countdown ends. Then evacuate the vault: that kit is no longer safe.",
                )}
          </P>
          <Row>
            <Button title={t("Ver en Actividad", "Open Activity")} kind={kitPriority ? "secondary" : "danger"} style={{ flex: 1 }} onPress={() => go("activity")} />
            <Button title={t("Evacuar", "Evacuate")} kind={kitPriority ? "danger" : "secondary"} style={{ flex: 1 }} onPress={() => go("evacuate-kit")} />
          </Row>
        </Card>
      ) : null}
      {unknown.length > 0 ? (
        <Card tone="danger">
          <Row gap={space.s} style={{ marginBottom: space.s }}>
            <Icon name="exclamationmark.triangle.fill" size={18} color={colors.danger} />
            <H2 style={{ marginBottom: 0, flex: 1 }}>{t("Operación que no reconoces", "Operation you don't recognise")}</H2>
          </Row>
          <P>
            {isV2
              ? t(
                  "Se pidió desde otro sitio. Si no has sido tú, bloquéala en Actividad y evacúa la bóveda a otra cuenta: la llave de este móvil puede estar copiada.",
                  "It was requested from somewhere else. If it wasn't you, block it in Activity and evacuate the vault to another account: this phone's key may have been copied.",
                )
              : t("Se pidió desde otro sitio. Si no has sido tú, bloquéala en Actividad.", "It was requested from somewhere else. If it wasn't you, block it in Activity.")}
          </P>
          <Row>
            <Button title={t("Ver en Actividad", "Open Activity")} kind="danger" style={{ flex: 1 }} onPress={() => go("activity")} />
            {isV2 ? <Button title={t("Evacuar", "Evacuate")} kind="secondary" style={{ flex: 1 }} onPress={() => go("evacuate-device")} /> : null}
          </Row>
        </Card>
      ) : null}
      {isV2 && locks.withdraw > now ? (
        <Card tone="warn">
          <P style={{ marginBottom: 0 }}>
            {t(
              `Las retiradas están congeladas hasta ${when(locks.withdraw)}. Las congeló tu kit de rescate o el guardián. Si no has sido tú, evacúa la bóveda.`,
              `Withdrawals are frozen until ${when(locks.withdraw)}. Your rescue kit or the guardian froze them. If it wasn't you, evacuate the vault.`,
            )}
          </P>
        </Card>
      ) : null}
      {isV2 && vaultTokensOn === false && !enabling ? (
        <Card tone="brass">
          <H2>{t("Activa los tokens en tu bóveda", "Enable tokens in your vault")}</H2>
          <P>
            {t(
              `Tu bóveda se creó solo para HBAR. Para guardar otros tokens de Hedera hay que activarlos: va por la cuenta atrás de retirada (${formatDelay(profile.vault.delaySeconds)}) y puedes bloquearlo como cualquier otra operación.`,
              `Your vault was created for HBAR only. To hold other Hedera tokens they need enabling: it goes through the withdrawal countdown (${formatDelay(profile.vault.delaySeconds)}) and you can block it like any other operation.`,
            )}
          </P>
          <Button
            title={t("Activar tokens", "Enable tokens")}
            busy={busy}
            onPress={() =>
              void run(t("No se pudo activar", "Could not enable"), async () => {
                setBusy(true);
                try {
                  await enableVaultTokens();
                  haptic.success();
                } finally {
                  setBusy(false);
                }
              })
            }
          />
        </Card>
      ) : null}
      {!isV2 ? (
        <Card tone="brass">
          <H2>{t("Nueva bóveda v2, más segura", "New v2 vault, safer")}</H2>
          <P>
            {t(
              "En la v2 ni siquiera tu kit de rescate puede vaciar la bóveda al momento: si te lo roban, lo ves y lo congelas.",
              "In v2 not even your rescue kit can empty the vault instantly: if it's stolen, you see it and freeze it.",
            )}
          </P>
          <Button title={t("Pasar a la v2", "Upgrade to v2")} onPress={() => go("migrate")} />
        </Card>
      ) : null}
      {!profile.recoveryConfirmed ? <KitCard onKit={onKit} /> : null}
    </>
  );
}

export function Home({ go, onTab, onKit, onWallets, onFriends }: { go: (a: HomeAction) => void; onTab: (t: Tab) => void; onKit: (kit: PendingKit) => void; onWallets?: () => void; onFriends?: () => void }) {
  const { profile, movements, locks, pullRefresh, refreshing, isV2, meta } = useWallet();
  const { format } = useMarket();
  const vault = useHoldings("vault");
  const pocket = useHoldings("pocket");
  const now = useNow();
  if (!profile?.vault) return null;
  const v = profile.vault;
  const mine = new Set(profile.mySchedules);
  const guardianActive = !!profile.guardian?.registered;

  // Total y parte protegida en dinero si hay precios (HBAR + tokens con precio); si no, solo en HBAR.
  const total = vault.total != null && pocket.total != null ? vault.total + pocket.total : null;
  const fraction = total != null && total > 0 ? (vault.total ?? 0) / total : vault.hbar + pocket.hbar > 0n ? Number((vault.hbar * 10_000n) / (vault.hbar + pocket.hbar)) / 10_000 : 0;
  const hasMoney = [...vault.list, ...pocket.list].some((h) => h.amount > 0n);
  const change = dayChange([...vault.list, ...pocket.list]);

  const pending = movements.find((m) => isOpen(m) && m.lane === "withdraw" && mine.has(m.scheduleId) && m.executableAt > now);
  const alert = movements.some((m) => isOpen(m) && (m.lane === "recovery" || !mine.has(m.scheduleId)));
  const frozen = isV2 && locks.withdraw > now;
  const pendingText = pending
    ? pending.action.kind === "transfer"
      ? summarizeAction(pending.action, { lane: pending.lane, meta, lang: lang() }).title
      : t("Cambio en camino", "Change on its way")
    : "";

  return (
    <Screen refreshing={refreshing} onRefresh={() => void pullRefresh()} footer={<TabBar current="home" onChange={onTab} alert={alert} />}>
      <Row style={{ justifyContent: "space-between", marginBottom: space.l }}>
        <Row gap={8} style={{ flexShrink: 1 }}>
          <BrandTitle height={20} />
          <Badge text={NETWORK === "mainnet" ? "Beta" : NETWORK} tone="warn" />
        </Row>
        <Row gap={6}>
          {onWallets ? <IconButton icon="rectangle.stack.fill" label={t("Tus wallets", "Your wallets")} onPress={onWallets} /> : null}
          <IconButton
            icon={guardianActive ? "checkmark.shield.fill" : "lock.shield"}
            color={guardianActive ? colors.safe : colors.muted}
            label={guardianActive ? t("Guardián conectado", "Guardian connected") : t("Sin guardián", "No guardian")}
            onPress={() => go("settings")}
          />
          <IconButton icon="gearshape" label={t("Ajustes", "Settings")} onPress={() => go("settings")} />
        </Row>
      </Row>

      <GuardianNoticeCard go={go} />
      <Alerts go={go} onKit={onKit} />
      <FriendsBanner onOpen={onFriends} />

      <BalanceHero
        label={profile.name ? `${profile.name} · ${t("saldo total", "total balance")}` : t("Saldo total", "Total balance")}
        value={total != null ? format(total) : `${formatHbar(vault.hbar + pocket.hbar, 2)} HBAR`}
        change={total != null ? change : null}
      />
      <ProtectionBar fraction={fraction} hasMoney={hasMoney} />

      <Row gap={4} style={{ marginTop: space.xl, marginBottom: space.s, alignItems: "flex-start" }}>
        <RoundAction primary icon="tray.and.arrow.down.fill" label={t("Guardar", "Store")} onPress={() => go("deposit")} />
        <RoundAction icon="tray.and.arrow.up.fill" label={t("Sacar", "Withdraw")} onPress={() => go("withdraw")} disabled={frozen} />
        <RoundAction icon="arrow.down.left" label={t("Recibir", "Receive")} onPress={() => go("receive")} />
        <RoundAction icon="arrow.up.right" label={t("Enviar", "Send")} onPress={() => go("send")} />
        <RoundAction icon="leaf.fill" label={t("Ganar", "Earn")} onPress={() => go("staking")} />
      </Row>

      <SectionTitle>{t("Tus cuentas", "Your accounts")}</SectionTitle>
      <AccountCard
        icon="checkmark.shield.fill"
        tint={colors.safe}
        title={t("Bóveda", "Vault")}
        subtitle={frozen ? t("Retiradas congeladas", "Withdrawals frozen") : t(`Protegida · retirada en ${formatDelay(v.delaySeconds)}`, `Protected · ${formatDelay(v.delaySeconds)} withdrawal`)}
        value={vault.total != null ? format(vault.total) : `${formatHbar(vault.hbar, 2)} HBAR`}
        change={vault.total != null ? (vault.change?.pct ?? null) : null}
        holdings={vault.list}
        onPress={() => go("vault")}
      />
      <AccountCard
        icon="wallet.pass.fill"
        tint={colors.link}
        title={t("Cartera", "Wallet")}
        subtitle={t("Para el día a día", "For everyday use")}
        value={pocket.total != null ? format(pocket.total) : `${formatHbar(pocket.hbar, 2)} HBAR`}
        change={pocket.total != null ? (pocket.change?.pct ?? null) : null}
        holdings={pocket.list}
        onPress={() => go("pocket")}
      />

      <H10xCard onOpen={() => go("h10x")} />

      {pending ? (
        <Pressable onPress={() => onTab("activity")} accessibilityRole="button" style={({ pressed }) => [{ opacity: pressed ? 0.8 : 1, marginTop: space.s }]}>
          <Card tone="warn" style={{ marginBottom: 0, paddingVertical: space.m }}>
            <Row gap={space.m}>
              <Icon name="hourglass" size={20} color={colors.warn} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.text, fontSize: 14, fontWeight: "600" }} numberOfLines={1}>
                  {pending.action.kind === "transfer" ? t(`En camino: ${pendingText}`, `On its way: ${pendingText}`) : pendingText}
                </Text>
                <Text style={{ color: colors.muted, fontSize: 12.5, marginTop: 1 }}>
                  {t(`Sale en ${formatCountdown(pending.executableAt - now)} · si no es tuya, bloquéala`, `Goes out in ${formatCountdown(pending.executableAt - now)} · if it isn't yours, block it`)}
                </Text>
              </View>
              <Icon name="chevron.right" size={13} color={colors.muted} weight="semibold" />
            </Row>
          </Card>
        </Pressable>
      ) : null}
    </Screen>
  );
}

/**
 * Actividad (0.10): «Todo» es el historial completo de la Cartera y la bóveda (envíos, recibos, cambios, NFT, staking,
 * firmas para dApps…); «Bóveda», las operaciones con cuenta atrás, como antes. Lo que está en curso sale siempre arriba:
 * es lo que se puede bloquear.
 */
export function Activity({ onTab }: { onTab: (t: Tab) => void }) {
  const { profile, movements, pullRefresh, refreshing } = useWallet();
  const history = useHistory();
  const [tab, setTab] = useState<"all" | "vault">("all");
  const now = useNow();
  if (!profile?.vault) return null;
  const mine = new Set(profile.mySchedules);
  const guardianActive = !!profile.guardian?.registered;
  const alert = movements.some((m) => isOpen(m) && (m.lane === "recovery" || !mine.has(m.scheduleId)));
  const running = movements.filter(isOpen);
  return (
    <Screen
      title={t("Actividad", "Activity")}
      refreshing={refreshing}
      onRefresh={() => {
        void pullRefresh();
        void history.reload();
      }}
      footer={<TabBar current="activity" onChange={onTab} alert={alert} />}
    >
      {tab === "all" && running.length > 0 ? (
        <>
          <SectionTitle>{t("En curso en la bóveda", "Under way in the vault")}</SectionTitle>
          <Group style={{ marginBottom: space.l }}>
            {running.map((m) => (
              <MovementRow key={m.scheduleId} m={m} mine={mine.has(m.scheduleId)} now={now} guardianActive={guardianActive} />
            ))}
          </Group>
        </>
      ) : null}
      <View style={{ marginBottom: space.l }}>
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: "all", label: t("Todo", "All") },
            { value: "vault", label: t("Bóveda", "Vault") },
          ]}
        />
      </View>
      {tab === "all" ? (
        <HistoryList history={history} />
      ) : movements.length === 0 ? (
        <View style={{ alignItems: "center", paddingVertical: space.xxl, gap: space.m }}>
          <Icon name="clock.arrow.circlepath" size={40} color={colors.faint} />
          <P muted center>
            {t(
              "Aún no hay movimientos. Cuando saques dinero de la bóveda, aparecerá aquí con su cuenta atrás y podrás bloquearlo mientras corre.",
              "No movements yet. When you take money out of the vault, it will show up here with its countdown, and you can block it while it runs.",
            )}
          </P>
        </View>
      ) : (
        <Group>
          {movements.map((m) => (
            <MovementRow key={m.scheduleId} m={m} mine={mine.has(m.scheduleId)} now={now} guardianActive={guardianActive} />
          ))}
        </Group>
      )}
      <P muted style={{ marginTop: space.l }}>
        {!guardianActive
          ? t("Sin guardián, tus retiradas se completan cuando abras la app al acabar la cuenta atrás.", "Without a guardian, your withdrawals complete when you open the app after the countdown.")
          : isExpoGo
            ? t("En Expo Go no llegan avisos al móvil: abre la app para ver si hay algo que no reconoces.", "Expo Go gets no phone alerts: open the app to check for anything you don't recognise.")
            : t("Te avisaremos en el móvil de cada operación de tu bóveda.", "We'll alert you on your phone about every operation in your vault.")}
      </P>
    </Screen>
  );
}
