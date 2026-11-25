// El dial de la caja fuerte: marcas como las de una rueda de combinación y un arco en menta H10X que
// muestra qué parte del dinero está protegida en la bóveda. Es el único elemento llamativo de la app.
import React, { useEffect, useMemo, useRef } from "react";
import { AccessibilityInfo, Animated, Easing, Text, View } from "react-native";
import Svg, { Circle, Defs, G, Line, LinearGradient, Path, Stop } from "react-native-svg";
import { colors, typeface } from "../theme";

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
/** Menta clara del principio del arco y blanco verdoso de la H y la X del logo (los de la web). */
const ARC_LIGHT = "#B4F2CF";
const LOGO_LIGHT = "#F4FBF6";

export function VaultDial({
  fraction,
  amount,
  caption,
  unit = "HBAR",
  size = 270,
  center,
  detail,
}: {
  /** 0–1: parte del total que está en la bóveda. */
  fraction: number;
  amount?: string;
  caption?: string;
  unit?: string;
  size?: number;
  /** Contenido propio en el centro (p. ej. un icono en la bienvenida). */
  center?: React.ReactNode;
  /** Línea bajo la unidad (p. ej. el valor en euros). */
  detail?: string | null;
}) {
  const c = size / 2;
  const outer = c - 4;
  const ringR = c - 30;
  const stroke = 10;
  const circumference = 2 * Math.PI * ringR;
  const target = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const progress = useRef(new Animated.Value(0)).current;

  // Un solo gesto de entrada: el arco se dibuja al abrir (salvo con "Reducir movimiento").
  useEffect(() => {
    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      if (cancelled) return;
      if (reduce) progress.setValue(target);
      else Animated.timing(progress, { toValue: target, duration: 900, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
    });
    return () => {
      cancelled = true;
    };
  }, [target, progress]);

  const ticks = useMemo(() => {
    const list: { x1: number; y1: number; x2: number; y2: number; major: boolean }[] = [];
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * 2 * Math.PI - Math.PI / 2;
      const major = i % 6 === 0;
      const len = major ? 11 : 5;
      list.push({
        x1: c + Math.cos(a) * outer,
        y1: c + Math.sin(a) * outer,
        x2: c + Math.cos(a) * (outer - len),
        y2: c + Math.sin(a) * (outer - len),
        major,
      });
    }
    return list;
  }, [c, outer]);

  const dashOffset = progress.interpolate({ inputRange: [0, 1], outputRange: [circumference, 0] });

  return (
    <View style={{ width: size, height: size, alignSelf: "center" }} accessible accessibilityLabel={amount ? `${amount} ${unit} ${caption ?? ""} ${detail ?? ""}` : caption}>
      <Svg width={size} height={size}>
        <Defs>
          <LinearGradient id="brass" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={ARC_LIGHT} />
            <Stop offset="0.55" stopColor={colors.brass} />
            <Stop offset="1" stopColor={colors.brassDeep} />
          </LinearGradient>
        </Defs>
        {ticks.map((t, i) => (
          <Line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} stroke={t.major ? "rgba(238,243,239,0.38)" : "rgba(238,243,239,0.14)"} strokeWidth={t.major ? 2 : 1.2} strokeLinecap="round" />
        ))}
        <Circle cx={c} cy={c} r={ringR} stroke="rgba(255,255,255,0.07)" strokeWidth={stroke} fill="none" />
        <G rotation={-90} origin={`${c}, ${c}`}>
          <AnimatedCircle
            cx={c}
            cy={c}
            r={ringR}
            stroke="url(#brass)"
            strokeWidth={stroke}
            strokeLinecap="round"
            fill="none"
            strokeDasharray={`${circumference} ${circumference}`}
            strokeDashoffset={dashOffset}
          />
        </G>
        <Circle cx={c} cy={c} r={ringR - 22} fill="rgba(255,255,255,0.025)" stroke="rgba(255,255,255,0.05)" strokeWidth={1} />
      </Svg>
      <View style={{ position: "absolute", inset: 0, alignItems: "center", justifyContent: "center", paddingHorizontal: 50 }}>
        {center ?? (
          <>
            {caption ? <Text style={{ color: colors.muted, fontSize: 14, marginBottom: 2 }}>{caption}</Text> : null}
            <Text
              numberOfLines={1}
              adjustsFontSizeToFit
              style={{ color: colors.text, fontSize: 58, lineHeight: 62, fontFamily: typeface.display, fontWeight: typeface.display ? undefined : "700", fontVariant: ["tabular-nums"] }}
            >
              {amount ?? "—"}
            </Text>
            <Text style={{ color: colors.brass, fontSize: 15, fontWeight: "600", letterSpacing: 1 }}>{unit}</Text>
            {detail ? <Text style={{ color: colors.muted, fontSize: 14, marginTop: 4, fontVariant: ["tabular-nums"] }}>{detail}</Text> : null}
          </>
        )}
      </View>
    </View>
  );
}

/** Proporciones del logo de H10X (las de h10xindex.xyz/logo.svg): ancho = alto × 350/112. */
const LOGO_RATIO = 350 / 112;
const GLYPHS = {
  h: "M0 4h27v40h24V4h27v104H51V65H27v43H0z",
  one: "M112 4h28v104h-28V36l-22 9V21z",
  zero: "M189 4c24 0 38 14 38 38v28c0 24-14 38-38 38s-38-14-38-38V42c0-24 14-38 38-38zm0 25c-7 0-11 4-11 11v32c0 7 4 11 11 11s11-4 11-11V40c0-7-4-11-11-11z",
  x: "M238 4h29l16 32 16-32h29l-30 52 31 52h-29l-17-34-17 34h-29l31-52z",
};

/** El logo de H10X (H y X claras, 1 y 0 en menta, con su sombra verde), para la bienvenida, el bloqueo y el inicio. */
export function H10XMark({ width = 120 }: { width?: number }) {
  const height = width / LOGO_RATIO;
  return (
    <Svg width={width} height={height} viewBox="-10 0 350 112" accessibilityElementsHidden importantForAccessibility="no">
      <G fill={colors.brassDeep} transform="translate(-7 4)">
        <Path d={GLYPHS.h} />
        <Path d={GLYPHS.one} />
        <Path d={GLYPHS.zero} fillRule="evenodd" />
        <Path d={GLYPHS.x} />
      </G>
      <G fill={LOGO_LIGHT}>
        <Path d={GLYPHS.h} />
        <Path d={GLYPHS.x} />
      </G>
      <G fill={colors.brass}>
        <Path d={GLYPHS.one} />
        <Path d={GLYPHS.zero} fillRule="evenodd" />
      </G>
    </Svg>
  );
}

/** «H10X Wallet»: el logo y la palabra Wallet en Inter Tight. `height` es el alto del logo. */
export function BrandTitle({ height = 26, center }: { height?: number; center?: boolean }) {
  return (
    <View
      style={{ flexDirection: "row", alignItems: "center", gap: height * 0.32, alignSelf: center ? "center" : undefined }}
      accessible
      accessibilityRole="header"
      accessibilityLabel="H10X Wallet"
    >
      <H10XMark width={height * LOGO_RATIO} />
      <Text
        style={{
          color: colors.text,
          fontSize: height * 1.02,
          lineHeight: height * 1.2,
          fontFamily: typeface.display,
          fontWeight: typeface.display ? undefined : "600",
          letterSpacing: -0.3,
        }}
      >
        Wallet
      </Text>
    </View>
  );
}
