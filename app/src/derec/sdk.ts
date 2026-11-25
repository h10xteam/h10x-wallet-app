// El SDK de DeRec (@derec-alliance/react-native) trae código nativo (JSI): no existe en Expo Go. Se carga solo cuando
// hace falta y, si no está, la app sigue igual y «Amigos de confianza» explica que hace falta la app instalada.
// Nunca se importa arriba en ningún archivo: un import fijo rompería la app en Expo Go.
import { isExpoGo } from "../env";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DerecSdk = any;
let cached: DerecSdk | null | undefined;

export function derecSdk(): DerecSdk | null {
  if (cached !== undefined) return cached;
  if (isExpoGo) {
    cached = null;
    return cached;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require("@derec-alliance/react-native");
    cached = m && typeof m.DeRecProtocolBuilder === "function" ? m : null;
  } catch {
    cached = null;
  }
  return cached;
}

export const derecAvailable = (): boolean => derecSdk() != null;
