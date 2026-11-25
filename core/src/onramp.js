// @ts-check
// Comprar con tarjeta (on-ramp): PREPARADO PERO APAGADO.
//
// La idea: un proveedor externo (con su propio KYC y su pasarela de pago) manda HBAR a la Cartera del usuario y,
// después, la app lo cambia por H10X con el swap. La app no toca el dinero ni los datos de la tarjeta: abre la página
// del proveedor en el navegador del sistema con la dirección de la Cartera ya puesta.
//
// Se enciende al compilar la app con EXPO_PUBLIC_ONRAMP_URL: la dirección del proveedor con {address} donde va la
// Cuenta (y, si la usa, {network}). Solo https y sin credenciales en la propia dirección.

/**
 * Dirección del proveedor para esta Cartera, o null si no está configurado o la plantilla no vale.
 * @param {string | null | undefined} template p. ej. https://proveedor.example/compra?wallet={address}&red={network}
 * @param {{ address: string, network: string }} p
 */
export function onrampUrl(template, { address, network }) {
  const tpl = String(template ?? "").trim();
  if (!tpl || !tpl.includes("{address}")) return null;
  if (!/^0\.0\.\d+$/.test(address) && !/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  let url;
  try {
    url = new URL(tpl.replaceAll("{address}", encodeURIComponent(address)).replaceAll("{network}", encodeURIComponent(network)));
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  return url.toString();
}

/** Nombre del proveedor que se enseña (su dominio, sin «www.»), o null. @param {string | null} url */
export function onrampHost(url) {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, "") : null;
  } catch {
    return null;
  }
}
