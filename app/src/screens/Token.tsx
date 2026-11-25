// Ficha de un activo: logo, precio y cambio de hoy, cuánto tienes en la bóveda y en la Cartera, sus acciones, su ID y
// lo que puede hacer su emisor. En H10X, además, el NAV de 7 días y el acceso a la cesta y la DAO.
import React, { useState } from "react";
import { Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { NETWORKS, formatUnits, hideLinks } from "@boveda/core";
import { Card, Group, Icon, IconButton, ListRow, P, Row, RoundAction, Screen, SectionTitle, TabBar, type Tab } from "../ui";
import { ChangeText, TokenLogo } from "../components/Assets";
import { colors, space, typeface } from "../theme";
import { HBAR_ASSET, useWallet } from "../wallet";
import { useHoldings, useMarket } from "../market";
import { useH10xNav } from "../h10xData";
import { Sparkline } from "./H10x";
import { NETWORK, h10xTokenId } from "../env";
import { t } from "../i18n";
import { haptic, open } from "../helpers";

export type TokenAction = "send" | "receive" | "deposit" | "withdraw";

/** NAV de H10X de los últimos 7 días (solo en la ficha de H10X: pide el histórico). */
function H10xChart({ onH10x }: { onH10x: () => void }) {
  const { history } = useH10xNav({ withHistory: true });
  const { pct } = useMarket();
  const first = history[0]?.[1];
  const last = history[history.length - 1]?.[1];
  const change = first && last ? ((last - first) / first) * 100 : null;
  return (
    <Card style={{ marginTop: space.l }}>
      <Row style={{ justifyContent: "space-between", marginBottom: space.s }}>
        <Text style={{ color: colors.text, fontSize: 15, fontWeight: "600" }}>{t("NAV · 7 días", "NAV · 7 days")}</Text>
        {change != null ? <Text style={{ color: change >= 0 ? colors.safe : colors.danger, fontSize: 13, fontWeight: "600" }}>{pct(change, 1)}</Text> : null}
      </Row>
      {history.length > 1 ? <Sparkline points={history} height={84} /> : <P muted style={{ marginBottom: 0 }}>{t("Cargando…", "Loading…")}</P>}
      <View style={{ height: 1, backgroundColor: colors.hairline, marginVertical: space.m }} />
      <ListRowLink title={t("Ver qué hay en la cesta y la DAO", "See what's in the basket and the DAO")} onPress={onH10x} />
    </Card>
  );
}

function ListRowLink({ title, onPress }: { title: string; onPress: () => void }) {
  return (
    <View style={{ marginHorizontal: -space.l, marginBottom: -space.s }}>
      <ListRow title={title} onPress={onPress} />
    </View>
  );
}

export function TokenScreen({
  id,
  onBack,
  act,
  onTab,
  onAccount,
  onH10x,
}: {
  id: string;
  onBack: () => void;
  act: (a: TokenAction, asset: string) => void;
  onTab: (t: Tab) => void;
  onAccount: (kind: "vault" | "pocket") => void;
  onH10x: () => void;
}) {
  const { meta, isV2, locks } = useWallet();
  const { quote, price, format } = useMarket();
  const vault = useHoldings("vault");
  const pocket = useHoldings("pocket");
  const [copied, setCopied] = useState(false);
  const isHbar = id === HBAR_ASSET;
  const tokenId = isHbar ? null : id;
  const inVault = vault.list.find((x) => x.id === id) ?? null;
  const inPocket = pocket.list.find((x) => x.id === id) ?? null;
  const info = tokenId ? meta(tokenId) : undefined;
  const any = inVault ?? inPocket;
  const symbol = any?.symbol ?? (isHbar ? "HBAR" : hideLinks(info?.symbol ?? "") || "?");
  const name = isHbar ? "Hedera" : (any?.name ?? (hideLinks(info?.name ?? "") || id));
  const decimals = any?.decimals ?? (isHbar ? 8 : (info?.decimals ?? 0));
  const q = quote(tokenId);
  const isH10x = !!h10xTokenId && id === h10xTokenId;
  const vaultAmount = inVault?.amount ?? 0n;
  const pocketAmount = inPocket?.amount ?? 0n;
  const totalAmount = vaultAmount + pocketAmount;
  const totalValue = q.price != null ? (inVault?.value ?? 0) + (inPocket?.value ?? 0) : null;
  const warn = any?.warn ?? { level: null, short: null, lines: [] as string[] };
  const frozen = isV2 && locks.withdraw > Math.floor(Date.now() / 1000);
  const amountText = (v: bigint) => `${formatUnits(v, decimals, Math.min(decimals, 6))} ${symbol}`;
  const copy = () => {
    if (!tokenId) return;
    void Clipboard.setStringAsync(tokenId);
    haptic.success();
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Screen
      heading={symbol}
      onBack={onBack}
      right={tokenId ? <IconButton icon="arrow.up.forward.app.fill" label={t("Ver en HashScan", "View on HashScan")} onPress={() => open(`${NETWORKS[NETWORK].hashscan}/token/${tokenId}`)} /> : undefined}
      footer={<TabBar current="home" onChange={onTab} />}
    >
      <View style={{ alignItems: "center", gap: 2, marginTop: space.s }}>
        <TokenLogo id={id} symbol={symbol} size={60} warn={warn.level} />
        <Text style={{ color: colors.text, fontSize: 21, fontWeight: "600", marginTop: space.s }}>{symbol}</Text>
        <Text style={{ color: colors.muted, fontSize: 14 }} numberOfLines={1}>
          {isH10x ? t("Index DTF de Hedera", "Hedera's Index DTF") : name}
        </Text>
        <Text
          style={{ color: colors.text, fontSize: 36, lineHeight: 42, marginTop: space.s, letterSpacing: -0.8, fontFamily: typeface.display, fontWeight: typeface.display ? undefined : "700", fontVariant: ["tabular-nums"] }}
          accessibilityRole="header"
        >
          {q.price != null ? price(q.price) : t("Sin precio", "No price")}
        </Text>
        {q.change24h != null ? (
          <Text style={{ fontSize: 14 }}>
            <ChangeText value={q.change24h} size={14} />
            <Text style={{ color: colors.muted }}>{` ${t("hoy", "today")}`}</Text>
          </Text>
        ) : null}
      </View>

      <Row gap={4} style={{ marginTop: space.xl, alignItems: "flex-start" }}>
        <RoundAction primary icon="tray.and.arrow.down.fill" label={t("Guardar", "Store")} onPress={() => act("deposit", pocketAmount > 0n ? id : HBAR_ASSET)} />
        <RoundAction icon="tray.and.arrow.up.fill" label={t("Sacar", "Withdraw")} disabled={frozen} onPress={() => act("withdraw", vaultAmount > 0n ? id : HBAR_ASSET)} />
        <RoundAction icon="arrow.up.right" label={t("Enviar", "Send")} onPress={() => act("send", pocketAmount > 0n ? id : HBAR_ASSET)} />
        <RoundAction icon="arrow.down.left" label={t("Recibir", "Receive")} onPress={() => act("receive", id)} />
        <RoundAction icon="arrow.left.arrow.right" label={t("Cambiar", "Swap")} onPress={() => onTab("swap")} />
      </Row>

      {isH10x ? <H10xChart onH10x={onH10x} /> : null}

      <SectionTitle right={<Text style={{ color: colors.text, fontSize: 15, fontVariant: ["tabular-nums"] }}>{totalValue != null ? format(totalValue) : amountText(totalAmount)}</Text>}>{t("Tu saldo", "Your balance")}</SectionTitle>
      <Group>
        <ListRow
          icon="checkmark.shield.fill"
          iconColor={colors.safe}
          title={t("Bóveda", "Vault")}
          value={amountText(vaultAmount)}
          detail={inVault?.value != null ? format(inVault.value) : undefined}
          onPress={() => onAccount("vault")}
        />
        <ListRow
          icon="wallet.pass.fill"
          iconColor={colors.link}
          title={t("Cartera", "Wallet")}
          value={amountText(pocketAmount)}
          detail={inPocket?.value != null ? format(inPocket.value) : undefined}
          onPress={() => onAccount("pocket")}
        />
      </Group>

      <SectionTitle>{t("Información", "Information")}</SectionTitle>
      <Group>
        {tokenId ? (
          <ListRow
            title={t("ID del token", "Token ID")}
            subtitle={tokenId}
            right={<IconButton icon={copied ? "checkmark.circle.fill" : "doc.on.doc"} color={copied ? colors.safe : colors.muted} label={t("Copiar el ID del token", "Copy the token ID")} onPress={copy} />}
          />
        ) : (
          <ListRow title="HBAR" subtitle={t("La moneda de Hedera. Con ella se pagan las comisiones de la red.", "Hedera's currency. Network fees are paid with it.")} />
        )}
        {warn.lines.map((line) => (
          <View key={line} style={{ flexDirection: "row", gap: space.m, paddingVertical: 13, paddingHorizontal: space.l, alignItems: "flex-start" }}>
            <Icon
              name={warn.level ? "exclamationmark.triangle.fill" : "checkmark.shield.fill"}
              size={18}
              color={warn.level === "danger" ? colors.danger : warn.level === "warn" ? colors.warn : colors.safe}
            />
            <Text style={{ flex: 1, color: colors.text, fontSize: 14, lineHeight: 20 }}>{line}</Text>
          </View>
        ))}
      </Group>
      {tokenId && !q.price ? (
        <P muted style={{ marginTop: space.s, fontSize: 13 }}>
          {t(
            "Sin precio: no sabemos lo que vale. Cualquiera puede crear un token con el nombre de otro: fíjate siempre en el ID.",
            "No price: we don't know what it's worth. Anyone can create a token with another one's name: always check the ID.",
          )}
        </P>
      ) : null}
    </Screen>
  );
}
