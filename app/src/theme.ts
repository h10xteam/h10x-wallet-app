// Identidad visual de H10X Wallet: la de h10xindex.xyz. Fondo casi negro con un velo verde arriba, menta H10X para lo
// importante y cifras en Inter Tight.
//
// Los nombres de la paleta vienen del primer diseño (acero y latón) y se mantienen para no tocar cada pantalla:
// `brass` es el acento (menta H10X) y `steelTop`/`steelBottom` son el degradado del fondo.
export const palette = {
  steelTop: "#0D1A13",
  steelBottom: "#060807",
  surface: "rgba(255,255,255,0.04)",
  surfaceStrong: "rgba(255,255,255,0.08)",
  hairline: "rgba(169,220,192,0.12)",
  text: "#EEF3EF",
  muted: "#93A59B",
  faint: "#5B6B62",
  brass: "#66DF9C",
  brassDeep: "#2F8F61",
  brassSoft: "rgba(102,223,156,0.10)",
  brassLine: "rgba(102,223,156,0.35)",
  onBrass: "#08160F",
  safe: "#66DF9C",
  safeSoft: "rgba(102,223,156,0.10)",
  safeLine: "rgba(102,223,156,0.32)",
  warn: "#E0A458",
  warnSoft: "rgba(224,164,88,0.13)",
  warnLine: "rgba(224,164,88,0.35)",
  danger: "#F2937F",
  dangerSoft: "rgba(242,147,127,0.13)",
  dangerLine: "rgba(242,147,127,0.40)",
  onDanger: "#240A05",
  link: "#A9DCC0",
};

/** Nombres que usan las pantallas (los antiguos apuntan a la paleta nueva). */
export const colors = {
  ...palette,
  bg: palette.steelBottom,
  card: palette.surface,
  cardAlt: palette.surfaceStrong,
  border: palette.hairline,
  accent: palette.safe,
  accentDark: palette.brassDeep,
  blue: palette.link,
  warnBg: palette.warnSoft,
  dangerBg: palette.dangerSoft,
};

/**
 * Tipografía: SF Pro (la del sistema) para la interfaz e Inter Tight, la de los titulares de la web de H10X, para las
 * cifras y el nombre. Si la fuente no carga, `display` queda sin definir y se usa la del sistema.
 */
export const typeface: { display: string | undefined; displayBold: string | undefined } = {
  display: "InterTight-SemiBold",
  displayBold: "InterTight-Bold",
};

export const space = { xs: 4, s: 8, m: 12, l: 16, xl: 24, xxl: 32 };
export const radius = { s: 10, m: 16, l: 22, xl: 30 };
