// Se carga antes que nada.
//  - El SDK de Hedera (y ethers) necesitan crypto.getRandomValues para generar llaves y firmas. En React
//    Native no viene de serie; expo-crypto lo da con el generador seguro del sistema.
//  - WalletConnect espera lo mismo que pone su paquete react-native-compat, pero ese paquete trae módulos
//    nativos que Expo Go no tiene. Aquí se pone lo mismo usando solo módulos que Expo Go sí incluye.
import { getRandomValues } from "expo-crypto";
import "fast-text-encoding";
import "react-native-url-polyfill/auto";
import { Buffer } from "buffer";
import { Linking, Platform } from "react-native";
import NetInfo from "@react-native-community/netinfo";
import * as Application from "expo-application";

type G = {
  crypto?: { getRandomValues?: typeof getRandomValues };
  Buffer?: typeof Buffer;
  Linking?: typeof Linking;
  Platform?: typeof Platform;
  NetInfo?: typeof NetInfo;
  Application?: { applicationId: string | null; applicationName: string | null };
};
const g = globalThis as unknown as G;
if (!g.crypto) g.crypto = {};
if (typeof g.crypto.getRandomValues !== "function") g.crypto.getRandomValues = getRandomValues;
if (typeof g.Buffer === "undefined") g.Buffer = Buffer;
if (typeof g.Linking === "undefined") g.Linking = Linking;
if (typeof g.Platform === "undefined") g.Platform = Platform;
if (typeof g.NetInfo === "undefined") g.NetInfo = NetInfo;
if (typeof g.Application === "undefined") g.Application = { applicationId: Application.applicationId, applicationName: Application.applicationName };
