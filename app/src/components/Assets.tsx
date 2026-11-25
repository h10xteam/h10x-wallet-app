// Piezas del rediseño: logo de cada token, filas de activos al estilo de HashPack, el saldo grande con su cambio de hoy,
// la barra de lo protegido y las tarjetas de Bóveda y Cartera.
import React from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { SvgXml } from "react-native-svg";
import { formatUnits } from "@boveda/core";
import { Icon } from "../ui";
import { colors, radius, space, typeface } from "../theme";
import { useTokenLogos } from "../logos";
import { useMarket, type Holding } from "../market";
import { HBAR_ASSET } from "../wallet";
import { h10xTokenId } from "../env";
import { t } from "../i18n";
import { haptic } from "../helpers";

const HBAR_LOGO = require("../../assets/token-hbar.png");
const H10X_LOGO = require("../../assets/token-h10x.png");

/** Si el SVG de un logo no se puede dibujar, sale la inicial en su lugar (y no se cae la pantalla). */
class LogoBoundary extends React.Component<{ fallback: React.ReactNode; children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Primera letra o cifra del símbolo, para los tokens sin logo. */
const initialOf = (symbol: string) => (symbol.match(/[A-Za-z0-9À-ɏ]/)?.[0] ?? "?").toUpperCase();

/**
 * Logo de un activo: HBAR y H10X van dentro de la app; el resto, de la lista de la web de H10X. Sin logo, su inicial.
 * `warn` pone una marca de aviso en la esquina.
 */
export function TokenLogo({ id, symbol, size = 40, ring, warn }: { id: string; symbol: string; size?: number; ring?: string; warn?: "danger" | "warn" | null }) {
  const logos = useTokenLogos();
  const round = { width: size, height: size, borderRadius: size / 2 };
  const letter = (
    <View style={[round, styles.letter]}>
      <Text style={{ color: "#C9D3CD", fontSize: size * 0.42, fontFamily: typeface.display, fontWeight: typeface.display ? undefined : "600" }}>{initialOf(symbol)}</Text>
    </View>
  );
  let body: React.ReactNode = letter;
  if (id === HBAR_ASSET) body = <Image source={HBAR_LOGO} style={round} accessibilityIgnoresInvertColors />;
  else if (h10xTokenId && id === h10xTokenId) body = <Image source={H10X_LOGO} style={round} accessibilityIgnoresInvertColors />;
  else {
    const logo = logos.get(id);
    if (logo?.kind === "raster") body = <Image source={{ uri: logo.uri }} style={round} accessibilityIgnoresInvertColors />;
    else if (logo?.kind === "svg")
      body = (
        <LogoBoundary fallback={letter}>
          <View style={[round, { overflow: "hidden" }]}>
            <SvgXml xml={logo.xml} width={size} height={size} />
          </View>
        </LogoBoundary>
      );
  }
  const badge = warn ? (warn === "danger" ? colors.danger : colors.warn) : null;
  return (
    <View style={[round, ring ? { borderWidth: 2, borderColor: ring, width: size + 4, height: size + 4, borderRadius: size / 2 + 2, alignItems: "center", justifyContent: "center" } : null]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {body}
      {badge ? (
        <View style={[styles.logoBadge, { backgroundColor: badge }]}>
          <Text style={{ color: colors.onDanger, fontSize: 10, fontWeight: "800", lineHeight: 12 }}>!</Text>
        </View>
      ) : null}
    </View>
  );
}

/** Logos montados uno sobre otro (las tarjetas de Inicio) y cuántos activos hay. */
export function LogoStack({ items, max = 4 }: { items: { id: string; symbol: string }[]; max?: number }) {
  const shown = items.slice(0, max);
  return (
    <View style={{ flexDirection: "row", alignItems: "center" }}>
      {shown.map((x, i) => (
        <View key={x.id} style={{ marginLeft: i === 0 ? 0 : -8, zIndex: max - i }}>
          <TokenLogo id={x.id} symbol={x.symbol} size={20} ring="#0B110E" />
        </View>
      ))}
      <Text style={{ color: colors.muted, fontSize: 12.5, marginLeft: space.s }}>
        {items.length === 1 ? t("1 activo", "1 asset") : t(`${items.length} activos`, `${items.length} assets`)}
      </Text>
    </View>
  );
}

/** Cambio en 24 h coloreado, con signo (no depende solo del color). */
export function ChangeText({ value, digits = 1, size = 13 }: { value: number | null; digits?: number; size?: number }) {
  const { pct } = useMarket();
  if (value == null) return null;
  return <Text style={{ color: value >= 0 ? colors.safe : colors.danger, fontSize: size, fontVariant: ["tabular-nums"] }}>{pct(value, digits)}</Text>;
}

/** Fila de la lista de activos: logo, nombre, precio y cambio; a la derecha la cantidad (arriba, como en HashPack) y su valor. */
export function AssetRow({ h, onPress }: { h: Holding; onPress?: () => void }) {
  const { price, format } = useMarket();
  const qty = formatUnits(h.amount, h.decimals, h.amount === 0n ? 2 : Math.min(h.decimals, 6));
  const amount = `${qty} ${h.symbol}`;
  const body = (
    <View style={styles.assetRow}>
      <TokenLogo id={h.id} symbol={h.symbol} warn={h.warn.level} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text style={styles.assetSymbol} numberOfLines={1}>
            {h.symbol}
          </Text>
          {h.warn.short ? (
            <View style={[styles.warnChip, { borderColor: h.warn.level === "danger" ? colors.dangerLine : colors.warnLine, backgroundColor: h.warn.level === "danger" ? colors.dangerSoft : colors.warnSoft }]}>
              <Text style={{ color: h.warn.level === "danger" ? colors.danger : colors.warn, fontSize: 11, fontWeight: "700" }}>{h.warn.short}</Text>
            </View>
          ) : null}
        </View>
        {h.price != null ? (
          <Text style={styles.assetSub} numberOfLines={1}>
            {price(h.price)}
            {h.change24h != null ? "  " : ""}
            <ChangeText value={h.change24h} />
          </Text>
        ) : (
          <Text style={styles.assetSub} numberOfLines={1}>
            {h.tokenId ? `${t("Sin precio", "No price")} · ${h.tokenId}` : t("Sin precio", "No price")}
          </Text>
        )}
      </View>
      <View style={{ alignItems: "flex-end", maxWidth: "45%" }}>
        <Text style={[styles.assetValue, { fontFamily: typeface.display, fontWeight: typeface.display ? undefined : "600" }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
          {qty}
        </Text>
        <Text style={styles.assetSub} numberOfLines={1}>
          {h.value != null ? format(h.value) : "—"}
        </Text>
      </View>
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable
      onPress={() => {
        haptic.tap();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={`${h.symbol}, ${amount}${h.value != null ? `, ${format(h.value)}` : ""}${h.warn.short ? `, ${h.warn.short}` : ""}`}
      style={({ pressed }) => ({ backgroundColor: pressed ? colors.surfaceStrong : "transparent" })}
    >
      {body}
    </Pressable>
  );
}

/** El saldo grande (en dinero o, sin precios, en HBAR) y lo que ha cambiado hoy. */
export function BalanceHero({ label, value, change, center }: { label: string; value: string; change: { abs: number; pct: number } | null; center?: boolean }) {
  const { format, pct } = useMarket();
  const up = (change?.abs ?? 0) >= 0;
  return (
    <View style={{ alignItems: center ? "center" : "flex-start", gap: 2 }}>
      <Text style={{ color: colors.muted, fontSize: 14 }}>{label}</Text>
      <Text
        style={{ color: colors.text, fontSize: 44, lineHeight: 50, letterSpacing: -1, fontFamily: typeface.display, fontWeight: typeface.display ? undefined : "700", fontVariant: ["tabular-nums"] }}
        numberOfLines={1}
        adjustsFontSizeToFit
        accessibilityRole="header"
      >
        {value}
      </Text>
      {change ? (
        <Text style={{ color: up ? colors.safe : colors.danger, fontSize: 14, fontWeight: "500", fontVariant: ["tabular-nums"] }}>
          {`${up ? "▲" : "▼"} ${up ? "+" : "−"}${format(Math.abs(change.abs))} · ${pct(change.pct, 2)} ${t("hoy", "today")}`}
        </Text>
      ) : null}
    </View>
  );
}

/** Barra de cuánto está protegido en la bóveda y cuánto en la Cartera. */
export function ProtectionBar({ fraction, hasMoney }: { fraction: number; hasMoney: boolean }) {
  const p = Math.round(fraction * 100);
  if (!hasMoney) return <Text style={{ color: colors.muted, fontSize: 13, marginTop: space.m }}>{t("Guarda HBAR o tokens en la bóveda para protegerlos.", "Store HBAR or tokens in the vault to protect them.")}</Text>;
  return (
    <View style={{ marginTop: space.l, gap: space.s }} accessible accessibilityLabel={t(`${p} % protegido en la bóveda, ${100 - p} % en la Cartera`, `${p}% protected in the vault, ${100 - p}% in the Wallet`)}>
      <View style={{ flexDirection: "row", gap: 2, height: 8 }}>
        {p > 0 ? <View style={{ flex: p, borderRadius: 4, backgroundColor: colors.safe }} /> : null}
        {p < 100 ? <View style={{ flex: 100 - p, borderRadius: 4, backgroundColor: "rgba(255,255,255,0.16)" }} /> : null}
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View style={[styles.dot, { backgroundColor: colors.safe }]} />
          <Text style={{ color: colors.muted, fontSize: 13 }}>{t(`${p} % protegido en la bóveda`, `${p}% protected in the vault`)}</Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View style={[styles.dot, { backgroundColor: "rgba(255,255,255,0.32)" }]} />
          <Text style={{ color: colors.muted, fontSize: 13 }}>{t(`${100 - p} % en la Cartera`, `${100 - p}% in the Wallet`)}</Text>
        </View>
      </View>
    </View>
  );
}

/** Tarjeta de una cuenta en Inicio: icono, nombre, para qué es, sus logos, su valor y su cambio de hoy. */
export function AccountCard({
  icon,
  tint,
  title,
  subtitle,
  value,
  change,
  holdings,
  onPress,
}: {
  icon: React.ComponentProps<typeof Icon>["name"];
  tint: string;
  title: string;
  subtitle: string;
  value: string;
  change: number | null;
  holdings: Holding[];
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={() => {
        haptic.tap();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${value}`}
      style={({ pressed }) => [styles.accountCard, { opacity: pressed ? 0.85 : 1 }]}
    >
      <View style={[styles.accountIcon, { backgroundColor: `${tint}1A` }]}>
        <Icon name={icon} size={22} color={tint} weight="semibold" />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Text style={{ color: colors.text, fontSize: 16, fontWeight: "600" }}>{title}</Text>
        <Text style={{ color: colors.muted, fontSize: 12.5 }} numberOfLines={1}>
          {subtitle}
        </Text>
        <View style={{ marginTop: 5 }}>
          <LogoStack items={holdings.filter((h) => h.amount > 0n || h.id === HBAR_ASSET)} />
        </View>
      </View>
      <View style={{ alignItems: "flex-end", gap: 3 }}>
        <Text style={{ color: colors.text, fontSize: 17, fontFamily: typeface.display, fontWeight: typeface.display ? undefined : "600", fontVariant: ["tabular-nums"] }}>{value}</Text>
        <ChangeText value={change} digits={2} size={12.5} />
      </View>
      <Icon name="chevron.right" size={13} color={colors.muted} weight="semibold" />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  letter: { backgroundColor: "rgba(255,255,255,0.09)", alignItems: "center", justifyContent: "center" },
  logoBadge: { position: "absolute", right: -3, bottom: -3, width: 16, height: 16, borderRadius: 8, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: "#0B110E" },
  assetRow: { flexDirection: "row", alignItems: "center", gap: space.m, paddingVertical: 12, paddingHorizontal: space.l, minHeight: 64 },
  assetSymbol: { color: colors.text, fontSize: 16, fontWeight: "600", flexShrink: 1 },
  assetSub: { color: colors.muted, fontSize: 13, marginTop: 2, fontVariant: ["tabular-nums"] },
  assetValue: { color: colors.text, fontSize: 16, fontVariant: ["tabular-nums"] },
  warnChip: { paddingHorizontal: 7, paddingVertical: 1, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth },
  dot: { width: 8, height: 8, borderRadius: 4 },
  accountCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.m,
    padding: 14,
    borderRadius: radius.l,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
    marginBottom: space.s,
  },
  accountIcon: { width: 44, height: 44, borderRadius: 14, alignItems: "center", justifyContent: "center" },
});
