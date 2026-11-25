// @ts-check
// Direcciones de correo de los avisos: comprobar, normalizar y enseñarlas a medias.

/** Correo en minúsculas y sin espacios alrededor (los dominios no distinguen mayúsculas). @param {unknown} email */
export const normalizeEmail = (email) => (typeof email === "string" ? email.trim().toLowerCase() : "");

/**
 * ¿Parece un correo al que se puede escribir? Sin espacios ni comillas, una sola @ y un dominio con punto.
 * No pretende validar todo lo que admite el estándar: basta para no mandar nada a direcciones absurdas.
 * @param {unknown} email
 */
export function isValidEmail(email) {
  const e = normalizeEmail(email);
  if (e.length < 6 || e.length > 254) return false;
  const m = /^([a-z0-9.!#$%&*+/=?^_{|}~-]{1,64})@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/.exec(e);
  if (!m) return false;
  if (m[1].startsWith(".") || m[1].endsWith(".") || m[1].includes("..")) return false;
  return /\.[a-z]{2,}$/.test(m[2]);
}

/**
 * El correo a medias, para enseñarlo sin darlo entero: «a•••@gmail.com». Cualquiera puede preguntar al
 * guardián por una bóveda, así que nunca devuelve el correo completo.
 * @param {unknown} email
 */
export function maskEmail(email) {
  const e = normalizeEmail(email);
  const at = e.lastIndexOf("@");
  if (at < 1) return "•••";
  return `${e[0]}•••${e.slice(at)}`;
}
