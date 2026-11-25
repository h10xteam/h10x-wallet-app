// El orden importa: los polyfills tienen que evaluarse antes de cargar el SDK de Hedera.
import "./src/polyfills";
import { registerRootComponent } from "expo";

import App from "./App";

registerRootComponent(App);
