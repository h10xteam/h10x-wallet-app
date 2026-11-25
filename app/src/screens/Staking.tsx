// Ganar: el staking nativo de Hedera para la bóveda (arriba) y, debajo, otras formas de hacer crecer lo que tienes (H10X
// y la liquidez de SaucerSwap, marcada como avanzada). Los HBAR no se mueven; las recompensas llegan a la bóveda. Cambiar de nodo (o quitarlo) va por la cuenta atrás de retirada, como cualquier operación.
import React, { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { formatCountdown, formatDelay, formatHbar, nodeAprPercent, nodeIsFull, nodeLabel, pickStakingNode, type Movement } from "@boveda/core";
import { Badge, Button, Card, Choice, Group, H2, Icon, ListRow, P, Row, Screen, SectionTitle } from "../ui";
import { TokenLogo } from "../components/Assets";
import { useMarket } from "../market";
import { h10xTokenId } from "../env";
import { colors, space, typeface } from "../theme";
import { useWallet } from "../wallet";
import { lang, t } from "../i18n";
import { confirm, haptic, run, useNow } from "../helpers";

const pct = (x: number) => `${x.toLocaleString(lang() === "en" ? "en-US" : "es-ES", { maximumFractionDigits: 2 })} %`;

/** Cambio de staking pedido y aún en su cuenta atrás. */
export const pendingStaking = (movements: Movement[]) =>
  movements.find((m) => m.lane === "withdraw" && m.status === "requested" && !m.executed && !m.expired && m.action.kind === "staking") ?? null;

export function Staking({ onBack, footer, onH10x, onOpenDapp }: { onBack: () => void; footer?: React.ReactNode; onH10x?: () => void; onOpenDapp?: (dappId: string) => void }) {
  const { valueOf, format } = useMarket();
  const { profile, staking, stakingNodes, loadStakingNodes, requestStaking, collectRewards, movements, balances, isV2 } = useWallet();
  const now = useNow(5000);
  const [loading, setLoading] = useState(stakingNodes.length === 0);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<string>("");
  const [busy, setBusy] = useState<"" | "request" | "off" | "collect">("");

  useEffect(() => {
    let alive = true;
    loadStakingNodes()
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [loadStakingNodes]);

  const current = staking?.nodeId ?? null;
  const pending = pendingStaking(movements);
  const best = useMemo(() => pickStakingNode(stakingNodes), [stakingNodes]);
  const selected = choice ? Number(choice) : (current ?? best);
  const currentNode = stakingNodes.find((n) => n.nodeId === current) ?? null;
  const apr = currentNode ? nodeAprPercent(currentNode) : best != null ? nodeAprPercent(stakingNodes.find((n) => n.nodeId === best)!) : 0;
  const v = profile?.vault;
  if (!v) return null;
  const delay = formatDelay(v.delaySeconds);
  const vaultHbar = balances.vault ?? 0n;
  // Estimación anual con el rendimiento del último día (cambia cada día).
  const yearly = apr > 0 ? (vaultHbar * BigInt(Math.round(apr * 100))) / 10_000n : 0n;

  const ask = (nodeId: number | null) =>
    void run(t("No se pudo pedir", "Could not request"), async () => {
      const off = nodeId == null;
      const ok = await confirm(
        off ? t("¿Desactivar el rendimiento?", "Turn off yield?") : current == null ? t("¿Activar el rendimiento?", "Turn on yield?") : t(`¿Cambiar al nodo ${nodeId}?`, `Switch to node ${nodeId}?`),
        t(
          `Va por la cuenta atrás de retirada (${delay}), como cualquier operación de la bóveda: la verás en Actividad y podrás bloquearla. Los HBAR no salen de la bóveda.`,
          `It goes through the withdrawal countdown (${delay}), like any vault operation: you'll see it in Activity and can block it. The HBAR never leave the vault.`,
        ),
        off ? t("Desactivar", "Turn off") : t("Pedir", "Request"),
        off,
      );
      if (!ok) return;
      setBusy(off ? "off" : "request");
      try {
        await requestStaking(nodeId);
        haptic.success();
      } finally {
        setBusy("");
      }
    });

  const collect = () =>
    void run(t("No se pudo cobrar", "Could not collect"), async () => {
      setBusy("collect");
      try {
        await collectRewards();
        haptic.success();
      } finally {
        setBusy("");
      }
    });

  return (
    <Screen heading={t("Ganar", "Earn")} onBack={onBack} footer={footer}>
      <P muted style={{ marginTop: space.s }}>{t("Formas de hacer crecer lo que tienes, de la más sencilla a la más avanzada.", "Ways to grow what you have, from the simplest to the most advanced.")}</P>

      <Card tone={current != null ? "accent" : undefined} style={{ marginTop: space.s }}>
        <Row gap={space.m}>
          <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: colors.safeSoft, alignItems: "center", justifyContent: "center" }}>
            <Icon name="leaf.fill" size={22} color={colors.safe} />
          </View>
          <View style={{ flex: 1 }}>
            <Row gap={space.s}>
              <Text style={{ color: colors.text, fontSize: 16, fontWeight: "600" }}>{t("Staking de HBAR", "HBAR staking")}</Text>
              <Badge text={current != null ? t("Activo", "On") : t("Desactivado", "Off")} tone={current != null ? "accent" : "muted"} />
            </Row>
            <Text style={{ color: colors.muted, fontSize: 13, marginTop: 2 }}>
              {current != null
                ? [t("Bóveda", "Vault"), currentNode ? nodeLabel(currentNode, lang()) : t(`nodo ${current}`, `node ${current}`), apr > 0 ? t(`≈ ${pct(apr)} al año hoy`, `≈ ${pct(apr)} a year today`) : null].filter(Boolean).join(" · ")
                : t("Tus HBAR de la bóveda no generan nada", "Your vault HBAR earn nothing")}
            </Text>
          </View>
        </Row>
        {current != null ? (
          <Row gap={space.s} style={{ marginTop: space.l, alignItems: "stretch" }}>
            <View style={{ flex: 1, padding: space.m, borderRadius: 16, backgroundColor: "rgba(0,0,0,0.22)" }}>
              <Text style={{ color: colors.muted, fontSize: 12 }}>{t("Pendiente de cobrar", "Waiting to be collected")}</Text>
              <Text style={{ color: colors.text, fontSize: 19, fontFamily: typeface.display, fontWeight: typeface.display ? undefined : "600", fontVariant: ["tabular-nums"] }}>{`${formatHbar(staking?.pending ?? 0n, 4)} HBAR`}</Text>
              {valueOf(staking?.pending ?? 0n, 8, null) != null ? <Text style={{ color: colors.muted, fontSize: 12 }}>{format(valueOf(staking?.pending ?? 0n, 8, null) ?? 0)}</Text> : null}
            </View>
            <View style={{ flex: 1, padding: space.m, borderRadius: 16, backgroundColor: "rgba(0,0,0,0.22)" }}>
              <Text style={{ color: colors.muted, fontSize: 12 }}>{t("Estimación en un año", "Estimate over a year")}</Text>
              <Text style={{ color: colors.text, fontSize: 19, fontFamily: typeface.display, fontWeight: typeface.display ? undefined : "600", fontVariant: ["tabular-nums"] }}>{yearly > 0n ? `≈ ${formatHbar(yearly, 2)} HBAR` : "—"}</Text>
              <Text style={{ color: colors.muted, fontSize: 12 }}>{t("con el saldo de hoy", "with today's balance")}</Text>
            </View>
          </Row>
        ) : null}
        <P style={{ marginTop: space.l, marginBottom: 0, fontSize: 14, lineHeight: 20 }}>
          {t(
            "Tu bóveda apoya a un nodo de la red y cobra recompensas en HBAR. Los HBAR no se mueven ni se bloquean, no hay penalizaciones y las recompensas llegan a la propia bóveda.",
            "Your vault backs a network node and earns rewards in HBAR. The HBAR don't move and aren't locked, there are no penalties, and rewards land in the vault itself.",
          )}
        </P>
        {current != null && (staking?.pending ?? 0n) > 0n ? (
          <Button title={t("Cobrar ahora", "Collect now")} icon="arrow.down.circle.fill" busy={busy === "collect"} onPress={collect} style={{ marginTop: space.l }} />
        ) : null}
      </Card>

      {!isV2 ? (
        <Card tone="warn">
          <P style={{ marginBottom: 0 }}>{t("El rendimiento necesita la bóveda v2.", "Yield needs the v2 vault.")}</P>
        </Card>
      ) : null}

      {current != null ? (
        <>
          {staking?.earned != null && staking.earned > 0n ? (
            <Group>
              <ListRow icon="checkmark.circle.fill" iconColor={colors.safe} title={t("Ya cobrado", "Already collected")} value={`${formatHbar(staking.earned, 4)} HBAR`} valueColor={colors.text} />
            </Group>
          ) : null}
          <P muted style={{ marginTop: space.s }}>
            {t(
              "Hedera paga lo pendiente cuando la bóveda tiene algún movimiento (también al guardar algo en ella). Solo cuenta el último año: si pasa más tiempo sin movimientos, se pierde lo más antiguo.",
              "Hedera pays out what's pending whenever the vault has any movement (including when you store something in it). Only the last year counts: if longer passes with no movement, the oldest part is lost.",
            )}
          </P>
        </>
      ) : null}

      {pending && pending.action.kind === "staking" ? (
        <Card tone="warn" style={{ marginTop: space.l }}>
          <H2>{pending.action.nodeId == null ? t("Desactivación en camino", "Turn-off on its way") : t(`Cambio al nodo ${pending.action.nodeId} en camino`, `Switch to node ${pending.action.nodeId} on its way`)}</H2>
          <P style={{ marginBottom: 0 }}>
            {pending.executableAt > now
              ? t(`Se hará en ${formatCountdown(pending.executableAt - now)}. Puedes bloquearlo en Actividad.`, `It happens in ${formatCountdown(pending.executableAt - now)}. You can block it in Activity.`)
              : t("La cuenta atrás ha terminado: se completará en un momento.", "The countdown is over: it will complete shortly.")}
          </P>
        </Card>
      ) : null}

      <SectionTitle>{t("Nodo", "Node")}</SectionTitle>
      {loading ? (
        <View style={{ paddingVertical: space.xl }}>
          <ActivityIndicator color={colors.brass} />
        </View>
      ) : error && stakingNodes.length === 0 ? (
        <Card tone="warn">
          <P style={{ marginBottom: 0 }}>{t(`No se pudo cargar la lista de nodos: ${error}`, `Couldn't load the node list: ${error}`)}</P>
        </Card>
      ) : (
        <>
          <P muted>
            {t(
              "Todos pagan lo mismo salvo los que están llenos (tienen más stake del máximo y pagan menos). H10X Wallet elige por ti el que más paga sin estar lleno.",
              "They all pay the same except full ones (more stake than their maximum, so they pay less). H10X Wallet picks the best-paying one that isn't full for you.",
            )}
          </P>
          <Choice
            options={stakingNodes.map((n) => ({
              value: String(n.nodeId),
              label: `${nodeLabel(n, lang())}${n.nodeId === current ? t(" · actual", " · current") : n.nodeId === best && current == null ? t(" · recomendado", " · recommended") : ""}`,
              detail: [nodeAprPercent(n) > 0 ? t(`≈ ${pct(nodeAprPercent(n))} al año`, `≈ ${pct(nodeAprPercent(n))} a year`) : null, nodeIsFull(n) ? t("Lleno: paga menos", "Full: pays less") : null].filter(Boolean).join(" · ") || undefined,
            }))}
            value={selected != null ? String(selected) : ""}
            onChange={setChoice}
          />
          <Button
            title={current == null ? t("Activar rendimiento", "Turn on yield") : t(`Cambiar al nodo ${selected ?? ""}`, `Switch to node ${selected ?? ""}`)}
            icon="leaf.fill"
            busy={busy === "request"}
            disabled={!isV2 || !!pending || selected == null || selected === current}
            onPress={() => selected != null && ask(selected)}
          />
          {current != null ? (
            <Button title={t("Desactivar", "Turn off")} kind="ghost" busy={busy === "off"} disabled={!!pending} style={{ marginTop: space.s }} onPress={() => ask(null)} />
          ) : null}
          {pending ? <P muted center style={{ marginTop: space.s }}>{t("Espera a que termine el cambio en camino.", "Wait for the change on its way to finish.")}</P> : null}
        </>
      )}

      {onH10x || onOpenDapp ? (
        <>
          <SectionTitle>{t("Más opciones", "More options")}</SectionTitle>
          <Group>
            {onH10x ? (
              <ListRow
                title={t("H10X · Index DTF", "H10X · Index DTF")}
                subtitle={t("Una cesta de tokens de Hedera en un solo token. Sube y baja con la cesta.", "A basket of Hedera tokens in a single token. It goes up and down with the basket.")}
                right={<TokenLogo id={h10xTokenId ?? "h10x"} symbol="H10X" size={32} />}
                onPress={onH10x}
              />
            ) : null}
            {onOpenDapp ? (
              <ListRow
                icon="drop.fill"
                iconColor={colors.warn}
                title={t("Liquidez en SaucerSwap · avanzado", "SaucerSwap liquidity · advanced")}
                subtitle={t("Se abre en dApps. Cobras comisiones, pero puedes perder valor si los precios se mueven.", "Opens in dApps. You earn fees, but you can lose value if prices move.")}
                onPress={() => onOpenDapp("saucerswap")}
              />
            ) : null}
          </Group>
          <P muted style={{ marginTop: space.m, fontSize: 13 }}>{t("El rendimiento lo pone la red y cambia cada día; no está garantizado.", "The network sets the yield and it changes every day; it isn't guaranteed.")}</P>
        </>
      ) : null}
    </Screen>
  );
}
