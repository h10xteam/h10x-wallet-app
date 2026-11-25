import React from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { BlurView } from "expo-blur";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { colors, radius, space, typeface } from "./theme";
import { haptic } from "./helpers";
import { t } from "./i18n";

type SymbolName = SymbolViewProps["name"];
type AndroidSymbol = NonNullable<Extract<SymbolName, { android?: unknown }>["android"]>;

/**
 * Equivalentes en Material Symbols (Android) de los SF Symbols que usa la app. En Android, SymbolView solo dibuja
 * si recibe el nombre de Android; sin él no saldría nada. Un nombre que falte aquí sale como un círculo, y la prueba
 * test/android.test.mjs avisa si se usa un icono sin equivalente.
 */
export const ANDROID_ICONS: Record<string, AndroidSymbol> = {
  archivebox: "inventory_2",
  "arrow.clockwise": "refresh",
  "arrow.down.circle.fill": "arrow_circle_down",
  "arrow.triangle.2.circlepath": "sync",
  "arrow.up.forward.app.fill": "open_in_new",
  "arrow.up.right": "north_east",
  "arrow.down.left": "south_west",
  "bell.badge.fill": "notifications_active",
  "chart.line.uptrend.xyaxis": "trending_up",
  "checkmark.circle.fill": "check_circle",
  "checkmark.seal.fill": "verified",
  "checkmark.shield.fill": "verified_user",
  "checkmark.square.fill": "check_box",
  "chevron.left": "chevron_left",
  "chevron.right": "chevron_right",
  circle: "radio_button_unchecked",
  "circle.hexagongrid.fill": "hexagon",
  "clock.arrow.circlepath": "history",
  "doc.on.clipboard": "content_paste",
  "doc.on.doc": "content_copy",
  "drop.fill": "water_drop",
  "envelope.fill": "mail",
  "eurosign.circle": "euro",
  "arrow.left.arrow.right": "swap_horiz",
  "arrow.up.arrow.down": "swap_vert",
  creditcard: "credit_card",
  "person.3.fill": "groups",
  "exclamationmark.triangle.fill": "warning",
  "info.circle.fill": "info",
  iphone: "smartphone",
  "iphone.and.arrow.forward": "send_to_mobile",
  faceid: "fingerprint",
  gearshape: "settings",
  "gearshape.fill": "settings",
  globe: "language",
  "hand.raised.fill": "front_hand",
  hourglass: "hourglass_empty",
  house: "home",
  "house.fill": "home",
  "key.fill": "key",
  "key.horizontal.fill": "key",
  "leaf.fill": "eco",
  link: "link",
  lifepreserver: "support",
  "lifepreserver.fill": "support",
  "lock.fill": "lock",
  "lock.shield": "shield_lock",
  "lock.shield.fill": "shield_lock",
  network: "hub",
  "paperplane.fill": "send",
  photo: "image",
  "photo.stack": "photo_library",
  "plus.circle.fill": "add_circle",
  qrcode: "qr_code",
  "qrcode.viewfinder": "qr_code_scanner",
  "rectangle.stack.fill": "layers",
  safari: "explore",
  signature: "signature",
  snowflake: "ac_unit",
  square: "check_box_outline_blank",
  "square.grid.2x2": "grid_view",
  timer: "timer",
  "trash.fill": "delete",
  "tray.and.arrow.down": "move_to_inbox",
  "tray.and.arrow.down.fill": "move_to_inbox",
  "tray.and.arrow.up": "outbox",
  "tray.and.arrow.up.fill": "outbox",
  "wallet.pass.fill": "account_balance_wallet",
  xmark: "close",
};

/** Icono: SF Symbols en iPhone y su equivalente de Material Symbols en Android. */
export function Icon({ name, size = 20, color = colors.text, weight = "medium" }: { name: SymbolName; size?: number; color?: string; weight?: SymbolViewProps["weight"] }) {
  const both: SymbolName = typeof name === "string" ? { ios: name, android: ANDROID_ICONS[name] ?? "circle" } : name;
  return <SymbolView name={both} size={size} tintColor={color} weight={weight} type="hierarchical" style={{ width: size, height: size }} />;
}

/** Fondo de H10X (casi negro, con un velo verde arriba), común a todas las pantallas. */
export function Backdrop({ children }: { children: React.ReactNode }) {
  return (
    <View style={{ flex: 1, backgroundColor: colors.steelBottom }}>
      <LinearGradient colors={[colors.steelTop, colors.steelBottom]} locations={[0, 0.65]} style={StyleSheet.absoluteFill} />
      {children}
    </View>
  );
}

export function Screen({
  title,
  onBack,
  children,
  refreshing,
  onRefresh,
  right,
  footer,
  heading,
}: {
  title?: string;
  /** Título corto centrado en la barra de arriba, con el botón redondo de volver (pantallas de Bóveda, Cartera…). */
  heading?: string;
  onBack?: () => void;
  children: React.ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
  right?: React.ReactNode;
  /** Algo fijo abajo (la barra de pestañas). */
  footer?: React.ReactNode;
}) {
  return (
    <Backdrop>
      <SafeAreaView style={{ flex: 1 }} edges={["top", "left", "right"]}>
        {heading ? (
          <View style={styles.headingBar}>
            {onBack ? <IconButton icon="chevron.left" label={t("Volver", "Back")} onPress={onBack} /> : <View style={{ width: 44 }} />}
            <Text style={styles.headingText} numberOfLines={1} accessibilityRole="header">
              {heading}
            </Text>
            {right ?? <View style={{ width: 44 }} />}
          </View>
        ) : (onBack || right) && (
          <View style={styles.header}>
            {onBack ? (
              <Pressable onPress={onBack} hitSlop={12} accessibilityRole="button" accessibilityLabel={t("Volver", "Back")} style={styles.backButton}>
                <Icon name="chevron.left" size={17} color={colors.link} weight="semibold" />
                <Text style={styles.back}>{t("Volver", "Back")}</Text>
              </Pressable>
            ) : (
              <View />
            )}
            {right ?? <View />}
          </View>
        )}
        <ScrollView
          contentContainerStyle={[styles.content, footer ? { paddingBottom: 140 } : null]}
          keyboardShouldPersistTaps="handled"
          refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={colors.muted} /> : undefined}
        >
          {title ? <Text style={[styles.title, typeface.display ? { fontFamily: typeface.displayBold, fontWeight: undefined } : null]}>{title}</Text> : null}
          {children}
        </ScrollView>
        {footer}
      </SafeAreaView>
    </Backdrop>
  );
}

export function Card({ children, style, tone }: { children: React.ReactNode; style?: ViewStyle; tone?: "warn" | "danger" | "accent" | "brass" }) {
  const toneStyle =
    tone === "warn"
      ? { backgroundColor: colors.warnSoft, borderColor: colors.warnLine }
      : tone === "danger"
        ? { backgroundColor: colors.dangerSoft, borderColor: colors.dangerLine }
        : tone === "accent"
          ? { backgroundColor: colors.safeSoft, borderColor: colors.safeLine }
          : tone === "brass"
            ? { backgroundColor: colors.brassSoft, borderColor: colors.brassLine }
            : null;
  return <View style={[styles.card, toneStyle, style]}>{children}</View>;
}

export function H2({ children, style }: { children: React.ReactNode; style?: TextStyle }) {
  return <Text style={[styles.h2, style]}>{children}</Text>;
}

/** Título de un grupo de filas, como en Ajustes de iOS. */
export function SectionTitle({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <View style={styles.sectionTitle}>
      <Text style={styles.sectionTitleText}>{children}</Text>
      {right}
    </View>
  );
}

export function P({ children, muted, center, style }: { children: React.ReactNode; muted?: boolean; center?: boolean; style?: TextStyle }) {
  return <Text style={[styles.p, muted && { color: colors.muted }, center && { textAlign: "center" }, style]}>{children}</Text>;
}

export function Mono({ children, selectable = true }: { children: React.ReactNode; selectable?: boolean }) {
  return (
    <Text style={styles.mono} selectable={selectable}>
      {children}
    </Text>
  );
}

/** Cifra grande en Inter Tight. */
export function Big({ children, color, size = 40 }: { children: React.ReactNode; color?: string; size?: number }) {
  return <Text style={[styles.big, { fontSize: size, lineHeight: size * 1.08, fontFamily: typeface.display }, color ? { color } : null]}>{children}</Text>;
}

export function Button({
  title,
  onPress,
  kind = "primary",
  disabled,
  busy,
  style,
  icon,
}: {
  title: string;
  onPress: () => void;
  kind?: "primary" | "secondary" | "danger" | "ghost";
  disabled?: boolean;
  busy?: boolean;
  style?: ViewStyle;
  icon?: SymbolName;
}) {
  const bg = kind === "primary" ? colors.brass : kind === "danger" ? colors.danger : kind === "secondary" ? colors.surfaceStrong : "transparent";
  const fg = kind === "primary" ? colors.onBrass : kind === "danger" ? colors.onDanger : kind === "ghost" ? colors.link : colors.text;
  const off = disabled || busy;
  return (
    <Pressable
      onPress={
        off
          ? undefined
          : () => {
              haptic.tap();
              onPress();
            }
      }
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, opacity: off ? 0.45 : pressed ? 0.82 : 1, transform: [{ scale: pressed && !off ? 0.985 : 1 }] },
        kind === "secondary" && { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={fg} />
      ) : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {icon ? <Icon name={icon} size={17} color={fg} weight="semibold" /> : null}
          <Text style={[styles.buttonText, { color: fg }]}>{title}</Text>
        </View>
      )}
    </Pressable>
  );
}

/** Botón redondo con icono y etiqueta debajo (fila de acciones de la pantalla principal). */
export function RoundAction({ icon, label, onPress, disabled, primary }: { icon: SymbolName; label: string; onPress: () => void; disabled?: boolean; primary?: boolean }) {
  return (
    <Pressable
      onPress={
        disabled
          ? undefined
          : () => {
              haptic.tap();
              onPress();
            }
      }
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [{ alignItems: "center", gap: 8, flex: 1, opacity: disabled ? 0.4 : pressed ? 0.7 : 1 }]}
    >
      <View style={[styles.roundAction, primary && styles.roundActionPrimary]}>
        <Icon name={icon} size={22} color={primary ? colors.onBrass : colors.brass} weight="semibold" />
      </View>
      <Text style={{ color: colors.text, fontSize: 12.5, fontWeight: "500" }} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Botón redondo de 44 con solo un icono (volver, ajustes, guardián…). `label` lo lee el lector de pantalla. */
export function IconButton({ icon, label, onPress, color = colors.text }: { icon: SymbolName; label: string; onPress: () => void; color?: string }) {
  return (
    <Pressable
      onPress={() => {
        haptic.tap();
        onPress();
      }}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.iconButton, { opacity: pressed ? 0.7 : 1 }]}
    >
      <Icon name={icon} size={18} color={color} weight="semibold" />
    </Pressable>
  );
}

/** Pastilla pequeña: un ID para copiar o un estado («Guardián activo»). */
export function Chip({ text, tone = "muted", icon, onPress, label }: { text: string; tone?: "muted" | "accent" | "warn" | "danger"; icon?: SymbolName; onPress?: () => void; label?: string }) {
  const c = { muted: colors.muted, accent: colors.safe, warn: colors.warn, danger: colors.danger }[tone];
  const body = (
    <View style={[styles.chip, tone === "muted" ? null : { backgroundColor: `${c}1A`, borderColor: `${c}55` }]}>
      {tone !== "muted" && !icon ? <View style={[styles.badgeDot, { backgroundColor: c }]} /> : null}
      <Text style={[styles.chipText, { color: tone === "muted" ? colors.text : c }]} numberOfLines={1}>
        {text}
      </Text>
      {icon ? <Icon name={icon} size={13} color={colors.muted} /> : null}
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
      accessibilityLabel={label ?? text}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      {body}
    </Pressable>
  );
}

export function Row({ children, gap = space.s, style }: { children: React.ReactNode; gap?: number; style?: ViewStyle }) {
  return <View style={[{ flexDirection: "row", gap, alignItems: "center" }, style]}>{children}</View>;
}

/** Grupo de filas con esquinas redondeadas. */
export function Group({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  const items = React.Children.toArray(children).filter(Boolean);
  return (
    <View style={[styles.group, style]}>
      {items.map((child, i) => (
        <View key={i}>
          {i > 0 ? <View style={styles.separator} /> : null}
          {child}
        </View>
      ))}
    </View>
  );
}

/** Fila de lista estilo iOS: icono en un cuadrado, texto, valor y flecha. */
export function ListRow({
  icon,
  iconColor = colors.brass,
  title,
  subtitle,
  value,
  valueColor,
  onPress,
  chevron = !!onPress,
  right,
  detail,
}: {
  icon?: SymbolName;
  iconColor?: string;
  title: string;
  subtitle?: string;
  value?: string;
  valueColor?: string;
  onPress?: () => void;
  chevron?: boolean;
  /** Control a la derecha (p. ej. un interruptor). */
  right?: React.ReactNode;
  /** Línea pequeña bajo el valor (p. ej. su valor en euros). */
  detail?: string;
}) {
  const body = (
    <View style={styles.listRow}>
      {icon ? (
        <View style={[styles.listIcon, { backgroundColor: `${iconColor}22` }]}>
          <Icon name={icon} size={17} color={iconColor} weight="semibold" />
        </View>
      ) : null}
      <View style={{ flex: 1 }}>
        <Text style={styles.listTitle}>{title}</Text>
        {subtitle ? <Text style={styles.listSubtitle}>{subtitle}</Text> : null}
      </View>
      {value ? (
        <View style={{ alignItems: "flex-end" }}>
          <Text style={[styles.listValue, valueColor ? { color: valueColor } : null]}>{value}</Text>
          {detail ? <Text style={styles.listSubtitle}>{detail}</Text> : null}
        </View>
      ) : null}
      {right}
      {chevron ? <Icon name="chevron.right" size={13} color={colors.faint} weight="semibold" /> : null}
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
      style={({ pressed }) => ({ backgroundColor: pressed ? colors.surfaceStrong : "transparent" })}
    >
      {body}
    </Pressable>
  );
}

export function Field({ label, hint, ...props }: TextInputProps & { label: string; hint?: string }) {
  return (
    <View style={{ marginBottom: space.l }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        placeholderTextColor={colors.faint}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardAppearance="dark"
        {...props}
        style={[styles.input, props.multiline && { minHeight: 104, textAlignVertical: "top" }, props.style]}
      />
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

/**
 * Campo para las 24 palabras: sin autocorrector, sin sugerencias ni autorrelleno (que el teclado no las
 * aprenda ni las guarde), teclado ASCII y el recordatorio de dónde NO escribirlas nunca.
 */
export function WordsField({ hint, ...props }: TextInputProps & { label: string; hint?: string }) {
  const warning = t(
    "Escríbelas solo aquí, en H10X Wallet abierta por ti. Nadie de H10X te las pedirá nunca: ni soporte, ni un correo, ni una web, ni una dApp.",
    "Type them only here, in H10X Wallet opened by you. Nobody from H10X will ever ask for them: not support, not an email, not a website, not a dApp.",
  );
  return (
    <Field
      multiline
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      autoComplete="off"
      textContentType="none"
      importantForAutofill="no"
      keyboardType="ascii-capable"
      {...props}
      hint={hint ? `${hint}\n${warning}` : warning}
    />
  );
}

export function Choice<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; detail?: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <Group style={{ marginBottom: space.l }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => {
              haptic.tap();
              onChange(o.value);
            }}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            style={styles.choice}
          >
            <View style={{ flex: 1 }}>
              <Text style={[styles.choiceLabel, on && { color: colors.brass }]}>{o.label}</Text>
              {o.detail ? <Text style={styles.hint}>{o.detail}</Text> : null}
            </View>
            <Icon name={on ? "checkmark.circle.fill" : "circle"} size={22} color={on ? colors.brass : colors.faint} />
          </Pressable>
        );
      })}
    </Group>
  );
}

export function Badge({ text, tone = "muted" }: { text: string; tone?: "muted" | "accent" | "warn" | "danger" | "blue" | "brass" }) {
  const c = { muted: colors.muted, accent: colors.safe, warn: colors.warn, danger: colors.danger, blue: colors.link, brass: colors.brass }[tone];
  return (
    <View style={[styles.badge, { backgroundColor: `${c}1F` }]}>
      <View style={[styles.badgeDot, { backgroundColor: c }]} />
      <Text style={[styles.badgeText, { color: c }]}>{text}</Text>
    </View>
  );
}

export function Steps({ steps, current }: { steps: string[]; current: number }) {
  return (
    <View style={{ gap: space.m, marginVertical: space.l }}>
      {steps.map((s, i) => (
        <Row key={s} gap={space.m}>
          <View style={{ width: 22, alignItems: "center" }}>
            {i < current ? <Icon name="checkmark.circle.fill" size={20} color={colors.safe} /> : i === current ? <ActivityIndicator color={colors.brass} /> : <Icon name="circle" size={18} color={colors.faint} />}
          </View>
          <Text style={{ color: i <= current ? colors.text : colors.muted, fontSize: 15 }}>{s}</Text>
        </Row>
      ))}
    </View>
  );
}

/** Selector compacto de pocas opciones (idioma, moneda). */
export function Segmented<T extends string>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <View style={styles.segmented} accessibilityRole="radiogroup">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => {
              if (!on) haptic.tap();
              onChange(o.value);
            }}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            style={[styles.segment, on && styles.segmentOn]}
          >
            <Text style={[styles.segmentText, on && { color: colors.onBrass }]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Activo a elegir en enviar, guardar y sacar: HBAR o un token. */
export type AssetOption = { id: string; symbol: string; balance: string };

/** Fila deslizable de activos (HBAR primero). */
export function AssetPicker({ options, value, onChange }: { options: AssetOption[]; value: string; onChange: (id: string) => void }) {
  if (options.length <= 1) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: space.l }} contentContainerStyle={{ gap: space.s }}>
      {options.map((o) => {
        const on = o.id === value;
        return (
          <Pressable
            key={o.id}
            onPress={() => {
              if (!on) haptic.tap();
              onChange(o.id);
            }}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            accessibilityLabel={`${o.symbol}, ${o.balance}`}
            style={[styles.asset, on && { borderColor: colors.brass, backgroundColor: colors.brassSoft }]}
          >
            <Text style={[styles.assetSymbol, on && { color: colors.brass }]}>{o.symbol}</Text>
            <Text style={styles.assetBalance}>{o.balance}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/** «settings» ya no está en la barra (va en la rueda de Inicio), pero sigue siendo una pantalla. */
export type Tab = "home" | "swap" | "nfts" | "dapps" | "activity" | "settings";

/**
 * Barra de pestañas inferior con fondo translúcido. En Android el desenfoque de expo-blur es experimental (y en
 * móviles modestos va lento o sale transparente), así que allí la barra es opaca.
 */
export function TabBar({ current, onChange, alert }: { current: Tab; onChange: (t: Tab) => void; alert?: boolean }) {
  const insets = useSafeAreaInsets();
  const tabs: { key: Tab; label: string; icon: SymbolName }[] = [
    { key: "home", label: t("Inicio", "Home"), icon: "house" },
    { key: "swap", label: t("Cambiar", "Swap"), icon: "arrow.left.arrow.right" },
    { key: "dapps", label: "dApps", icon: "square.grid.2x2" },
    { key: "nfts", label: "NFT", icon: "photo.stack" },
    { key: "activity", label: t("Actividad", "Activity"), icon: "clock.arrow.circlepath" },
  ];
  return (
    <View style={[styles.tabWrap, { paddingBottom: Math.max(insets.bottom, 10) }]} pointerEvents="box-none">
      <TabBarSurface>
        {tabs.map((t) => {
          const on = t.key === current;
          return (
            <Pressable
              key={t.key}
              onPress={() => {
                if (!on) haptic.tap();
                onChange(t.key);
              }}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              style={styles.tab}
            >
              <View>
                <Icon name={t.icon} size={22} color={on ? colors.brass : colors.muted} weight={on ? "semibold" : "regular"} />
                {alert && t.key === "activity" ? <View style={styles.tabAlert} /> : null}
              </View>
              <Text style={[styles.tabLabel, { color: on ? colors.brass : colors.muted }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
                {t.label}
              </Text>
            </Pressable>
          );
        })}
      </TabBarSurface>
    </View>
  );
}

function TabBarSurface({ children }: { children: React.ReactNode }) {
  if (Platform.OS === "android") return <View style={[styles.tabBar, styles.tabBarSolid]}>{children}</View>;
  return (
    <BlurView intensity={40} tint="dark" style={styles.tabBar}>
      {children}
    </BlurView>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: space.l, paddingVertical: space.s },
  backButton: { flexDirection: "row", alignItems: "center", gap: 4 },
  back: { color: colors.link, fontSize: 17 },
  content: { padding: space.l, paddingBottom: space.xxl * 2 },
  title: { color: colors.text, fontSize: 32, fontWeight: "700", letterSpacing: 0.2, marginBottom: space.l },
  h2: { color: colors.text, fontSize: 18, fontWeight: "600", marginBottom: space.s },
  sectionTitle: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: space.xl, marginBottom: space.s, paddingHorizontal: space.xs },
  sectionTitleText: { color: colors.muted, fontSize: 15, fontWeight: "600" },
  p: { color: colors.text, fontSize: 15, lineHeight: 22, marginBottom: space.s },
  mono: { color: colors.text, fontFamily: "Menlo", fontSize: 13, marginBottom: space.s },
  big: { color: colors.text, fontWeight: "600", marginVertical: space.xs, fontVariant: ["tabular-nums"] },
  card: { backgroundColor: colors.surface, borderRadius: radius.l, padding: space.l, marginBottom: space.l, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline },
  button: { borderRadius: radius.m, paddingVertical: 15, paddingHorizontal: space.l, alignItems: "center", justifyContent: "center", minHeight: 52 },
  buttonText: { fontSize: 16, fontWeight: "600" },
  roundAction: { width: 56, height: 56, borderRadius: 28, backgroundColor: colors.surfaceStrong, alignItems: "center", justifyContent: "center", borderWidth: StyleSheet.hairlineWidth, borderColor: colors.brassLine },
  roundActionPrimary: { backgroundColor: colors.brass, borderColor: colors.brass },
  iconButton: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline },
  headingBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: space.l, paddingTop: space.s, paddingBottom: space.xs, gap: space.s },
  headingText: { flex: 1, textAlign: "center", color: colors.text, fontSize: 17, fontWeight: "600" },
  chip: { flexDirection: "row", alignItems: "center", gap: 6, height: 32, paddingHorizontal: 12, borderRadius: 16, backgroundColor: colors.surfaceStrong, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline },
  chipText: { fontSize: 13, fontVariant: ["tabular-nums"] },
  group: { backgroundColor: colors.surface, borderRadius: radius.l, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline, overflow: "hidden" },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.hairline, marginLeft: 60 },
  listRow: { flexDirection: "row", alignItems: "center", gap: space.m, paddingVertical: 13, paddingHorizontal: space.l, minHeight: 56 },
  listIcon: { width: 32, height: 32, borderRadius: 9, alignItems: "center", justifyContent: "center" },
  listTitle: { color: colors.text, fontSize: 16 },
  listSubtitle: { color: colors.muted, fontSize: 13, marginTop: 2 },
  listValue: { color: colors.muted, fontSize: 15, fontVariant: ["tabular-nums"] },
  label: { color: colors.muted, fontSize: 14, fontWeight: "500", marginBottom: space.s, paddingHorizontal: space.xs },
  input: { backgroundColor: colors.surface, color: colors.text, borderRadius: radius.m, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline, paddingHorizontal: space.l, paddingVertical: 14, fontSize: 16 },
  hint: { color: colors.muted, fontSize: 13, marginTop: space.xs, lineHeight: 18 },
  choice: { flexDirection: "row", alignItems: "center", gap: space.m, padding: space.l },
  choiceLabel: { color: colors.text, fontSize: 16, fontWeight: "600" },
  badge: { flexDirection: "row", alignItems: "center", gap: 6, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  badgeDot: { width: 6, height: 6, borderRadius: 3 },
  badgeText: { fontSize: 12, fontWeight: "600" },
  tabWrap: { position: "absolute", left: 0, right: 0, bottom: 0, alignItems: "center" },
  tabBar: { flexDirection: "row", marginHorizontal: space.l, borderRadius: 28, overflow: "hidden", borderWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline, backgroundColor: "rgba(8,16,12,0.6)", paddingVertical: 8, paddingHorizontal: 8, alignSelf: "stretch" },
  tabBarSolid: { backgroundColor: "rgba(10,20,15,0.97)", elevation: 8 },
  tab: { flex: 1, alignItems: "center", gap: 3, paddingVertical: 4 },
  tabLabel: { fontSize: 10.5, fontWeight: "600" },
  segmented: { flexDirection: "row", backgroundColor: colors.surfaceStrong, borderRadius: 10, padding: 2, gap: 2 },
  segment: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, minWidth: 44, alignItems: "center" },
  segmentOn: { backgroundColor: colors.brass },
  segmentText: { color: colors.text, fontSize: 14, fontWeight: "600" },
  asset: { borderRadius: radius.m, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline, backgroundColor: colors.surface, paddingVertical: 10, paddingHorizontal: 14, minWidth: 92 },
  assetSymbol: { color: colors.text, fontSize: 15, fontWeight: "700" },
  assetBalance: { color: colors.muted, fontSize: 12, marginTop: 2, fontVariant: ["tabular-nums"] },
  tabAlert: { position: "absolute", top: -2, right: -4, width: 9, height: 9, borderRadius: 5, backgroundColor: colors.danger },
});
