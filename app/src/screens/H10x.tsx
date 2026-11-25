// H10X dentro de la wallet: tu H10X (saldo y tu parte de la cesta), el índice (NAV, pools, 7 días) y la DAO.
// Los datos son los públicos de H10X en mainnet (core/src/h10x.js); el saldo, el de la red de la app.
import React, { useMemo } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, View } from "react-native";
import Svg, { Polyline } from "react-native-svg";
import { H10X_DAO_WEB, H10X_WEB, h10xShare, type DaoCandidate, type DaoPhase, type H10xNav } from "@boveda/core";
import { Badge, Big, Button, Card, Group, H2, Icon, ListRow, P, Row, Screen, SectionTitle } from "../ui";
import { H10XMark } from "../components/VaultDial";
import { colors, space, typeface } from "../theme";
import { useWallet } from "../wallet";
import { usePrices } from "../prices";
import { useMarket } from "../market";
import { ChangeText, TokenLogo } from "../components/Assets";
import { usePrefs } from "../prefs";
import { useDao, useH10xNav } from "../h10xData";
import { NETWORK, h10xTokenId } from "../env";
import { lang, t, when } from "../i18n";
import { haptic, open, run, useNow } from "../helpers";

const isMainnet = NETWORK === ("mainnet" as string);
const locale = () => (lang() === "en" ? "en-US" : "es-ES");
const fmt = (n: number, d = 2) => n.toLocaleString(locale(), { maximumFractionDigits: d, minimumFractionDigits: Math.min(d, 2) });
const fmtAmount = (n: number) => n.toLocaleString(locale(), { maximumFractionDigits: n >= 100 ? 2 : n >= 1 ? 4 : 6 });
const pct = (n: number | null) => (n == null ? "—" : `${n >= 0 ? "+" : ""}${fmt(n, 2)} %`);
const pctColor = (n: number | null) => (n == null ? colors.muted : n >= 0 ? colors.safe : colors.danger);

/** Valor en la moneda elegida a partir de dólares (el NAV de H10X va en USD). */
function useFiat() {
  const { prices, format } = usePrices();
  const { prefs } = usePrefs();
  const rate = prefs.currency === "EUR" && prices?.hbar.usd && prices.hbar.eur ? prices.hbar.eur / prices.hbar.usd : 1;
  return (usd: number) => format(usd * rate);
}

/** Saldo de H10X de la Cartera y de la bóveda (unidades mínimas, 8 decimales). */
export function useMyH10x() {
  const { tokens } = useWallet();
  const pocket = tokens.pocket.find((x) => x.tokenId === h10xTokenId)?.balance ?? 0n;
  const vault = tokens.vault.find((x) => x.tokenId === h10xTokenId)?.balance ?? 0n;
  return { pocket, vault, total: pocket + vault };
}

/** Línea del NAV de los últimos 7 días. */
export function Sparkline({ points, width = 300, height = 64 }: { points: [number, number][]; width?: number; height?: number }) {
  const d = useMemo(() => {
    if (points.length < 2) return null;
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
    const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
    const sx = (x: number) => ((x - x0) / Math.max(1, x1 - x0)) * (width - 4) + 2;
    const sy = (y: number) => height - 2 - ((y - y0) / Math.max(1e-12, y1 - y0)) * (height - 4);
    // como mucho ~150 puntos: de sobra para la pantalla del móvil
    const step = Math.max(1, Math.floor(points.length / 150));
    const pts = points.filter((_, i) => i % step === 0 || i === points.length - 1).map(([x, y]) => `${sx(x).toFixed(1)},${sy(y).toFixed(1)}`);
    return { pts: pts.join(" "), up: ys[ys.length - 1] >= ys[0], min: y0, max: y1 };
  }, [points, width, height]);
  if (!d) return null;
  return (
    <View accessibilityLabel={t("Gráfico del NAV de los últimos 7 días", "NAV chart for the last 7 days")}>
      <Svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <Polyline points={d.pts} fill="none" stroke={d.up ? colors.safe : colors.danger} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      </Svg>
    </View>
  );
}

/** Tarjeta de H10X en Inicio: qué es (o cuánto tienes), su precio y su cambio de hoy. */
export function H10xCard({ onOpen }: { onOpen: () => void }) {
  const { nav, quote, price } = useMarket();
  const my = useMyH10x();
  const fiat = useFiat();
  const h = Number(my.total) / 1e8;
  const q = h10xTokenId ? quote(h10xTokenId) : { price: null, change24h: nav?.change24h ?? null };
  return (
    <Pressable
      onPress={() => {
        haptic.tap();
        onOpen();
      }}
      accessibilityRole="button"
      accessibilityLabel={t("Abrir H10X", "Open H10X")}
      style={({ pressed }) => ({
        opacity: pressed ? 0.85 : 1,
        marginTop: space.s,
        padding: 14,
        borderRadius: 22,
        backgroundColor: "rgba(102,223,156,0.07)",
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: "rgba(102,223,156,0.30)",
      })}
    >
      <Row gap={space.m}>
        <TokenLogo id={h10xTokenId ?? "h10x"} symbol="H10X" size={40} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ color: colors.text, fontSize: 15, fontWeight: "600" }}>H10X · Index DTF</Text>
          <Text style={{ color: colors.muted, fontSize: 12.5, marginTop: 2 }} numberOfLines={1}>
            {h > 0 ? t(`Tienes ${fmtAmount(h)} H10X`, `You have ${fmtAmount(h)} H10X`) : t("La cesta de Hedera en un token", "Hedera's basket in one token")}
          </Text>
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <Text style={{ color: colors.text, fontSize: 16, fontFamily: typeface.display, fontWeight: typeface.display ? undefined : "600", fontVariant: ["tabular-nums"] }}>
            {q.price != null ? price(q.price) : nav ? fiat(nav.nav) : "—"}
          </Text>
          <ChangeText value={q.change24h} size={12.5} />
        </View>
        <Icon name="chevron.right" size={13} color={colors.muted} weight="semibold" />
      </Row>
    </Pressable>
  );
}

/** Componentes de la cesta: lo que te toca de cada uno (o lo que lleva 1 H10X). */
function BasketList({ nav, amount }: { nav: H10xNav; amount: bigint }) {
  const fiat = useFiat();
  const share = h10xShare(nav, amount > 0n ? amount : 100_000_000n);
  return (
    <Group>
      {share.items.map((c) => (
        <ListRow
          key={c.symbol}
          title={c.symbol}
          subtitle={`${fmtAmount(c.amount)} ${c.symbol} · ${fmt(c.weight * 100, 1)} %`}
          value={fiat(c.usd)}
        />
      ))}
    </Group>
  );
}

export function H10xScreen({ onBack, onDao, onSwap, onDeposit }: { onBack: () => void; onDao: () => void; onSwap: () => void; onDeposit: () => void }) {
  const { nav, history, at, error, reload } = useH10xNav();
  const { pullRefresh, refreshing } = useWallet();
  const my = useMyH10x();
  const fiat = useFiat();
  const now = useNow(30_000);
  const h = Number(my.total) / 1e8;
  return (
    <Screen
      title="H10X"
      onBack={onBack}
      refreshing={refreshing}
      onRefresh={() => {
        void pullRefresh();
        void reload();
      }}
    >
      <Card>
        <H10XMark width={96} />
        <Text style={{ color: colors.muted, fontSize: 13, marginTop: space.m }}>{t("Tienes", "You have")}</Text>
        <Big size={32}>{fmtAmount(h)} H10X</Big>
        {nav && h > 0 ? <P muted style={{ marginBottom: 0 }}>{t(`≈ ${fiat(nav.nav * h)} · ${fmt((nav.nav * h) / nav.hbarUsd, 2)} HBAR`, `≈ ${fiat(nav.nav * h)} · ${fmt((nav.nav * h) / nav.hbarUsd, 2)} HBAR`)}</P> : null}
        {my.total > 0n ? (
          <P muted style={{ marginTop: space.s, marginBottom: 0, fontSize: 13 }}>
            {t(`En la Cartera ${fmtAmount(Number(my.pocket) / 1e8)} · en la bóveda ${fmtAmount(Number(my.vault) / 1e8)}`, `In the Wallet ${fmtAmount(Number(my.pocket) / 1e8)} · in the vault ${fmtAmount(Number(my.vault) / 1e8)}`)}
          </P>
        ) : null}
        {!isMainnet ? (
          <P muted style={{ marginTop: space.s, marginBottom: 0, fontSize: 13 }}>
            {t(
              "Red de pruebas: el saldo es de H10X de prueba. El precio, la cesta y la DAO son los de H10X real (mainnet).",
              "Test network: the balance is test H10X. Price, basket and DAO are those of the real H10X (mainnet).",
            )}
          </P>
        ) : null}
      </Card>

      {!nav ? (
        error ? (
          <Card tone="warn">
            <P>{t("No se pudo leer h10xindex.xyz. Revisa la conexión.", "Could not read h10xindex.xyz. Check your connection.")}</P>
            <Button title={t("Reintentar", "Retry")} kind="secondary" onPress={() => void reload()} />
          </Card>
        ) : (
          <View style={{ paddingVertical: space.xl }}>
            <ActivityIndicator color={colors.brass} />
          </View>
        )
      ) : (
        <>
          <SectionTitle>{t("El índice", "The index")}</SectionTitle>
          <Card>
            <Row style={{ justifyContent: "space-between", alignItems: "flex-end" }}>
              <View>
                <Text style={{ color: colors.muted, fontSize: 13 }}>{t("Valor de 1 H10X (NAV)", "Value of 1 H10X (NAV)")}</Text>
                <Text style={{ color: colors.text, fontSize: 24, fontFamily: typeface.displayBold }}>{fiat(nav.nav)}</Text>
                <Text style={{ color: colors.muted, fontSize: 13 }}>{fmt(nav.nav / nav.hbarUsd, 3)} HBAR</Text>
              </View>
              <View style={{ alignItems: "flex-end" }}>
                <Text style={{ color: pctColor(nav.change24h), fontWeight: "600" }}>{t("24 h", "24 h")} {pct(nav.change24h)}</Text>
                <Text style={{ color: pctColor(nav.change7d), fontWeight: "600" }}>{t("7 días", "7 days")} {pct(nav.change7d)}</Text>
              </View>
            </Row>
            <View style={{ marginTop: space.m }}>
              <Sparkline points={history} />
            </View>
            {nav.pools.length ? (
              <View style={{ marginTop: space.m }}>
                {nav.pools.map((p) => (
                  <Text key={p.venue} style={{ color: colors.muted, fontSize: 13 }}>
                    {t(`Pool ${p.venue} de SaucerSwap: ${fiat(p.priceUsd)}`, `SaucerSwap ${p.venue} pool: ${fiat(p.priceUsd)}`)}
                    {p.premiumBps != null ? ` (${p.premiumBps >= 0 ? "+" : ""}${fmt(p.premiumBps / 100, 2)} % ${t("frente al NAV", "vs NAV")})` : ""}
                  </Text>
                ))}
              </View>
            ) : null}
          </Card>

          <SectionTitle>{my.total > 0n ? t("Tu parte de la cesta", "Your share of the basket") : t("Lo que lleva cada H10X", "What each H10X holds")}</SectionTitle>
          <P muted style={{ fontSize: 13 }}>
            {t(
              "Cada H10X está respaldado por estos tokens, guardados en la bóveda de H10X. Es lo que te correspondería al reembolsar (antes de la comisión del 0,5 %).",
              "Each H10X is backed by these tokens, held in the H10X vault. It's what you'd get when redeeming (before the 0.5% fee).",
            )}
          </P>
          <BasketList nav={nav} amount={my.total} />
          <P muted style={{ fontSize: 12, marginTop: space.s }}>
            {t(`Datos de h10xindex.xyz, ${at ? `leídos hace ${Math.max(0, Math.round((now - at) / 60))} min` : ""}.`, `Data from h10xindex.xyz${at ? `, read ${Math.max(0, Math.round((now - at) / 60))} min ago` : ""}.`)}
          </P>
        </>
      )}

      <Group style={{ marginTop: space.m }}>
        <ListRow icon="person.3.fill" title={t("DAO de H10X", "H10X DAO")} subtitle={t("Rondas, propuestas y votaciones de la cesta", "Basket rounds, proposals and votes")} onPress={onDao} />
        {isMainnet ? (
          <ListRow icon="arrow.left.arrow.right" title={t("Comprar o vender H10X", "Buy or sell H10X")} subtitle={t("En la pestaña Cambiar", "In the Swap tab")} onPress={onSwap} />
        ) : null}
        <ListRow icon="lock.shield.fill" title={t("Guardar H10X en la bóveda", "Store H10X in the vault")} subtitle={t("Protegido con la cuenta atrás", "Protected by the countdown")} onPress={onDeposit} />
        <ListRow icon="globe" title={t("Web de H10X", "H10X website")} subtitle="h10xindex.xyz" onPress={() => open(H10X_WEB)} />
      </Group>
    </Screen>
  );
}

// ---- DAO ------------------------------------------------------------------------------------------

const PHASE: Record<DaoPhase, { es: string; en: string; tone: "accent" | "warn" | "brass" | "muted" | "blue" }> = {
  propose: { es: "Propuestas abiertas", en: "Proposals open", tone: "accent" },
  review: { es: "Filtro", en: "Review", tone: "blue" },
  vote: { es: "Votación abierta", en: "Voting open", tone: "brass" },
  counting: { es: "Escrutinio", en: "Counting", tone: "warn" },
  closed: { es: "Cerrada", en: "Closed", tone: "muted" },
};

function CandidateRow({ c, revealed }: { c: DaoCandidate; revealed: boolean }) {
  const filter = c.filter === "ok" ? t("pasa el filtro", "passes review") : c.filter === "rejected" ? t("no pasa el filtro", "fails review") : t("filtro pendiente", "review pending");
  const votes = revealed && c.votes != null ? ` · ${fmtAmount(c.votes)} H10X${c.voters != null ? t(` (${c.voters} votos)`, ` (${c.voters} votes)`) : ""}` : "";
  return (
    <ListRow
      title={c.symbol || c.token}
      subtitle={`${c.symbol ? `${c.token} · ` : ""}${t("propuesto por", "proposed by")} ${c.team ? t("el equipo", "the team") : c.proposer} · ${filter}${votes}`}
      right={c.winner ? <Badge text={t("Entra", "Joins")} tone="accent" /> : undefined}
    />
  );
}

export function DaoScreen({ onBack, onOpenDapp }: { onBack: () => void; onOpenDapp?: () => void }) {
  const { dao, error, reload } = useDao();
  const { profile, setH10xAlerts } = useWallet();
  const now = useNow(30_000);
  const r = dao?.round ?? null;
  const prefs = profile?.h10xAlerts ?? { dao: true, basket: true };
  const toggle = (on: boolean) =>
    void run(t("No se pudo cambiar el aviso", "Could not change the alert"), async () => {
      await setH10xAlerts({ ...prefs, dao: on });
      haptic.success();
    });
  const next = r
    ? r.phase === "propose"
      ? { label: t("Propuestas hasta", "Proposals until"), at: r.proposeEnd }
      : r.phase === "review"
        ? { label: t("La votación empieza", "Voting starts"), at: r.voteStart }
        : r.phase === "vote"
          ? { label: t("Se vota hasta", "Voting until"), at: r.voteEnd }
          : null
    : null;
  const left = next ? next.at - now : 0;
  const leftText = left > 86400 ? t(`${Math.floor(left / 86400)} d ${Math.floor((left % 86400) / 3600)} h`, `${Math.floor(left / 86400)} d ${Math.floor((left % 86400) / 3600)} h`) : left > 0 ? `${Math.floor(left / 3600)} h ${Math.floor((left % 3600) / 60)} min` : "";
  const revealed = !!r && (r.phase === "closed" || r.resultPublished);
  return (
    <Screen title={t("DAO de H10X", "H10X DAO")} onBack={onBack} refreshing={false} onRefresh={() => void reload()}>
      <P muted>
        {t(
          "Los holders de H10X proponen y votan qué tokens entran en la cesta. El voto es secreto hasta que acaba la votación.",
          "H10X holders propose and vote on which tokens join the basket. Votes stay secret until voting ends.",
        )}
      </P>
      {!dao ? (
        error ? (
          <Card tone="warn">
            <P>{t("No se pudo leer la DAO en h10xindex.xyz.", "Could not read the DAO from h10xindex.xyz.")}</P>
            <Button title={t("Reintentar", "Retry")} kind="secondary" onPress={() => void reload()} />
          </Card>
        ) : (
          <View style={{ paddingVertical: space.xl }}>
            <ActivityIndicator color={colors.brass} />
          </View>
        )
      ) : !r ? (
        <Card>
          <P style={{ marginBottom: 0 }}>{t("Ahora mismo no hay ninguna ronda abierta.", "There's no open round right now.")}</P>
        </Card>
      ) : (
        <>
          <Card>
            <Row style={{ justifyContent: "space-between", marginBottom: space.s }}>
              <H2 style={{ marginBottom: 0 }}>{t(`Ronda ${r.id}`, `Round ${r.id}`)}</H2>
              <Badge text={lang() === "en" ? PHASE[r.phase].en : PHASE[r.phase].es} tone={PHASE[r.phase].tone} />
            </Row>
            {next ? (
              <P style={{ marginBottom: space.s }}>
                {next.label} <Text style={{ fontWeight: "700" }}>{when(next.at)}</Text>
                {leftText ? <Text style={{ color: colors.muted }}>{t(` (faltan ${leftText})`, ` (${leftText} left)`)}</Text> : null}
              </P>
            ) : null}
            <P muted style={{ fontSize: 13, marginBottom: 0 }}>
              {t(
                `Propuestas hasta ${when(r.proposeEnd)} · votación del ${when(r.voteStart)} al ${when(r.voteEnd)} · ${r.slots} hueco(s) en la cesta.`,
                `Proposals until ${when(r.proposeEnd)} · voting ${when(r.voteStart)} to ${when(r.voteEnd)} · ${r.slots} basket slot(s).`,
              )}
            </P>
          </Card>

          <SectionTitle>{t("Candidatos", "Candidates")}</SectionTitle>
          {r.candidates.length ? (
            <Group>
              {r.candidates.map((c) => (
                <CandidateRow key={c.token} c={c} revealed={revealed} />
              ))}
            </Group>
          ) : (
            <P muted>{t("Todavía no hay propuestas válidas.", "No valid proposals yet.")}</P>
          )}
          {revealed && r.quorumReached === false ? <P style={{ color: colors.warn }}>{t("No hubo quórum: la cesta no cambia.", "No quorum: the basket stays the same.")}</P> : null}

          <SectionTitle>{t("Reglas", "Rules")}</SectionTitle>
          <Card>
            <P style={{ marginBottom: space.s }}>
              {t(
                `Proponer: tener ${r.minPropose} H10X al pagar y ${r.holdDays} días antes, y pagar ${r.fee} H10X a ${r.feeAccount} con la nota «H10X-DAO ${r.id} <token>».`,
                `To propose: hold ${r.minPropose} H10X when paying and ${r.holdDays} days before, and pay ${r.fee} H10X to ${r.feeAccount} with the memo "H10X-DAO ${r.id} <token>".`,
              )}
            </P>
            <P style={{ marginBottom: 0 }}>{t(`Votar: cualquier holder, con el peso de sus H10X. Quórum: ${fmt(r.quorumPct, 0)} %.`, `Voting: any holder, weighted by their H10X. Quorum: ${fmt(r.quorumPct, 0)}%.`)}</P>
          </Card>
        </>
      )}

      <Card tone={isMainnet ? undefined : "warn"}>
        <P style={{ marginBottom: space.s }}>
          {isMainnet
            ? t(
                "Se vota y se propone en la web de H10X, abierta dentro de la app y conectada a tu Cartera: tus H10X de la Cartera cuentan. Cada firma te la pide H10X Wallet con su propia hoja.",
                "You vote and propose on the H10X website, opened inside the app and connected to your Wallet: the H10X in your Wallet count. H10X Wallet asks you for each signature on its own sheet.",
              )
            : t(
                "Esta app está en la red de pruebas y tus H10X están en mainnet: de momento se vota y se propone en la web de H10X con HashPack u otra wallet de mainnet.",
                "This app is on the test network and your H10X is on mainnet: for now, vote and propose on the H10X website with HashPack or another mainnet wallet.",
              )}
        </P>
        <Button
          title={t("Votar o proponer en la web", "Vote or propose on the web")}
          kind="secondary"
          icon="globe"
          onPress={() => (isMainnet && onOpenDapp ? onOpenDapp() : open(H10X_DAO_WEB))}
        />
      </Card>

      <Group style={{ marginTop: space.m }}>
        <ListRow
          icon="bell.badge.fill"
          title={t("Avisos de la DAO", "DAO alerts")}
          subtitle={profile?.guardian?.registered ? t("Ronda nueva, empieza la votación, últimas 24 h y resultado", "New round, voting starts, last 24 h and result") : t("Necesitan el guardián conectado", "They need the guardian connected")}
          right={<Switch value={prefs.dao} onValueChange={toggle} disabled={!profile?.guardian?.registered} trackColor={{ true: colors.brass, false: colors.surfaceStrong }} />}
        />
      </Group>

      {dao?.past.length ? (
        <>
          <SectionTitle>{t("Rondas anteriores", "Past rounds")}</SectionTitle>
          <Group>
            {dao.past.map((p) => (
              <ListRow key={p.id} title={p.id} subtitle={!p.quorum ? t("sin quórum", "no quorum") : p.winners.length ? t(`entró ${p.winners.join(", ")}`, `${p.winners.join(", ")} joined`) : t("sin cambios", "no change")} />
            ))}
          </Group>
        </>
      ) : null}
    </Screen>
  );
}
