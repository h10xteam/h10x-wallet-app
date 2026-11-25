// @ts-check
// Correo de los avisos graves del guardián. Se manda con la API web del servicio que elijas (Brevo,
// Resend o Postmark), sin librerías: una petición https con la clave del servicio, que se queda en el VPS.
// Con EMAIL_PROVIDER=archivo no sale nada: cada correo se escribe en DATA_DIR/correos.jsonl (pruebas).
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * @typedef {{ enabled: boolean, provider: string, apiKey: string, from: string, fromName: string, outbox: string, problem: string | null }} EmailConfig
 */

const PROVIDERS = ["brevo", "resend", "postmark", "archivo"];

/**
 * Configuración a partir de las variables de entorno. Si falta algo, el correo queda apagado y `problem`
 * dice por qué (el guardián lo escribe al arrancar).
 * @param {Record<string, string | undefined>} env @param {string} dataDir @returns {EmailConfig}
 */
export function emailConfig(env, dataDir) {
  const provider = (env.EMAIL_PROVIDER ?? "").trim().toLowerCase();
  const apiKey = (env.EMAIL_API_KEY ?? "").trim();
  const from = (env.EMAIL_FROM ?? "").trim();
  const fromName = (env.EMAIL_FROM_NAME ?? "H10X Wallet").trim() || "H10X Wallet";
  const outbox = join(dataDir, "correos.jsonl");
  /** @type {string | null} */
  let problem = null;
  if (!provider) problem = "sin EMAIL_PROVIDER: avisos por correo apagados";
  else if (!PROVIDERS.includes(provider)) problem = `EMAIL_PROVIDER=${provider} no existe (usa brevo, resend o postmark)`;
  else if (provider !== "archivo" && !apiKey) problem = "falta EMAIL_API_KEY";
  else if (provider !== "archivo" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) problem = "falta EMAIL_FROM (p. ej. avisos@h10xindex.xyz)";
  return { enabled: problem == null, provider, apiKey, from: from || "avisos@localhost", fromName, outbox, problem };
}

/**
 * Manda un correo de texto. Nunca lanza: devuelve si ha salido y, si no, por qué.
 * @param {EmailConfig} cfg @param {{ to: string, subject: string, text: string }} mail
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function sendEmail(cfg, { to, subject, text }, fetchImpl = fetch) {
  if (!cfg.enabled) return { ok: false, error: cfg.problem ?? "correo apagado" };
  try {
    if (cfg.provider === "archivo") {
      mkdirSync(dirname(cfg.outbox), { recursive: true });
      appendFileSync(cfg.outbox, `${JSON.stringify({ at: new Date().toISOString(), to, subject, text })}\n`, { mode: 0o600 });
      return { ok: true };
    }
    /** @type {{ url: string, headers: Record<string, string>, body: unknown }} */
    let req;
    if (cfg.provider === "brevo") {
      req = {
        url: "https://api.brevo.com/v3/smtp/email",
        headers: { "api-key": cfg.apiKey },
        body: { sender: { name: cfg.fromName, email: cfg.from }, to: [{ email: to }], subject, textContent: text },
      };
    } else if (cfg.provider === "resend") {
      req = {
        url: "https://api.resend.com/emails",
        headers: { authorization: `Bearer ${cfg.apiKey}`, "user-agent": "h10x-guardian" },
        body: { from: `${cfg.fromName} <${cfg.from}>`, to: [to], subject, text },
      };
    } else {
      req = {
        url: "https://api.postmarkapp.com/email",
        headers: { "x-postmark-server-token": cfg.apiKey },
        body: { From: `${cfg.fromName} <${cfg.from}>`, To: to, Subject: subject, TextBody: text, MessageStream: "outbound" },
      };
    }
    const res = await fetchImpl(req.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...req.headers },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return { ok: true };
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    return { ok: false, error: `${cfg.provider} respondió ${res.status} ${detail}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Texto de un aviso por correo: lo que ha pasado, qué hacer si no has sido tú (con y sin el móvil) y la
 * regla contra el phishing. Sin enlaces: nadie debe actuar desde un correo.
 * @param {"es" | "en"} lang @param {string} body @param {string} vaultId
 */
export function alertText(lang, body, vaultId) {
  if (lang === "en") {
    return [
      body,
      "",
      `Vault: ${vaultId}`,
      "",
      "Wasn't you?",
      "· If you have your phone: open H10X Wallet and block it, or evacuate the vault with your phone and your rescue kit.",
      "· If you don't: install H10X Wallet on another phone, tap “My phone was stolen” and follow the steps with your 24 words.",
      "",
      "H10X Wallet will never ask for your 24 words by email or send you links to do anything. If an email does, it's fake.",
    ].join("\n");
  }
  return [
    body,
    "",
    `Bóveda: ${vaultId}`,
    "",
    "¿No has sido tú?",
    "· Si tienes el móvil: abre H10X Wallet y bloquéalo, o evacúa la bóveda con el móvil y el kit de rescate.",
    "· Si no lo tienes: instala H10X Wallet en otro móvil, pulsa «Me han robado el móvil» y sigue los pasos con tus 24 palabras.",
    "",
    "H10X Wallet nunca te pedirá tus 24 palabras por correo ni te mandará enlaces para hacer nada. Si un correo lo hace, es falso.",
  ].join("\n");
}

/** Texto del correo con el código. @param {"es" | "en"} lang @param {string} code @param {string} vaultId */
export function codeText(lang, code, vaultId) {
  if (lang === "en") {
    return [
      `Your code: ${code}`,
      "",
      `Type it in H10X Wallet to receive the important alerts of vault ${vaultId} at this address. It expires in 15 minutes.`,
      "",
      "If you didn't ask for it, ignore this email: someone typed your address by mistake.",
      "",
      "H10X Wallet will never ask for your 24 words by email or send you links to do anything. If an email does, it's fake.",
    ].join("\n");
  }
  return [
    `Tu código: ${code}`,
    "",
    `Escríbelo en H10X Wallet para recibir aquí los avisos importantes de la bóveda ${vaultId}. Caduca en 15 minutos.`,
    "",
    "Si no lo has pedido tú, ignora este correo: alguien ha escrito tu dirección por error.",
    "",
    "H10X Wallet nunca te pedirá tus 24 palabras por correo ni te mandará enlaces para hacer nada. Si un correo lo hace, es falso.",
  ].join("\n");
}
