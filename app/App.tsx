import React, { useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useFonts } from "expo-font";
import { WalletProvider, useWallet } from "./src/wallet";
import { WalletsProvider, useWallets } from "./src/wallets";
import { PrefsProvider, usePrefs } from "./src/prefs";
import { PricesProvider } from "./src/prices";
import { MarketProvider } from "./src/market";
import { TokenLogosProvider } from "./src/logos";
import { GuardianStatusProvider } from "./src/guardianStatus";
import { LockGate } from "./src/LockGate";
import { colors, typeface } from "./src/theme";
import { Backdrop, TabBar, type Tab } from "./src/ui";
import { CreateVault, Fund, RecoveryKit, VaultReady, Welcome } from "./src/screens/Onboarding";
import { NewKit } from "./src/screens/NewKit";
import { Activity, Home, type HomeAction } from "./src/screens/Home";
import { Allowances, ChangeDelays, Deposit, EmailAlerts, Evacuate, Migrate, Receive, Recover, Rescue, Send, Settings, Withdraw } from "./src/screens/Actions";
import { NftDetail, NftHome, type NftPlace } from "./src/screens/Nfts";
import { DappPrompt, DappsHome, ScanWc } from "./src/screens/Dapps";
import { DappBrowser } from "./src/screens/DappBrowser";
import { Staking } from "./src/screens/Staking";
import { SwapHome } from "./src/screens/Swap";
import { DaoScreen, H10xScreen } from "./src/screens/H10x";
import { WalletsScreen } from "./src/screens/Wallets";
import { AccountScreen } from "./src/screens/Account";
import { TokenScreen } from "./src/screens/Token";
import { About } from "./src/screens/About";
import { MoveHelp, MoveIn, MoveWaiting } from "./src/screens/Move";
import { DappsProvider } from "./src/walletconnect";
import { DerecProvider } from "./src/derec/DerecProvider";
import { FriendsRecover, FriendsScreen } from "./src/screens/Friends";
import type { NftItem } from "./src/wallet";

/** `back`: a dónde vuelve (si no, a Inicio). `asset`: el token con el que empieza enviar, guardar o sacar. */
type Route =
  | { name: Tab }
  | { name: Exclude<HomeAction, "settings" | "activity" | "vault" | "pocket">; back?: Route; asset?: string }
  | { name: "vault" }
  | { name: "pocket" }
  | { name: "token"; id: string; back?: Route }
  | { name: "about" }
  | { name: "moveIn" }
  | { name: "moveHelp" }
  | { name: "rescue" }
  | { name: "recover"; stolen?: boolean }
  | { name: "createVault" }
  | { name: "kit"; words: string[]; vaultId: string; password?: string | null }
  | { name: "vaultReady"; vaultId: string; password?: string | null }
  | { name: "nft"; item: NftItem; where: NftPlace }
  | { name: "scan" }
  | { name: "browser"; dappId: string; path?: string; back?: Route["name"] }
  | { name: "delays" }
  | { name: "newKit" }
  | { name: "email" }
  | { name: "allowances" }
  | { name: "wallets"; back?: Route }
  | { name: "friends"; back?: Route }
  | { name: "friendsRecover" };

function Router() {
  const { ready, profile } = useWallet();
  const [route, setRoute] = useState<Route>({ name: "home" });
  const home = () => setRoute({ name: "home" });
  const showKit = (words: string[], vaultId: string, password?: string | null) => setRoute({ name: "kit", words, vaultId, password });
  const onTab = (t: Tab) => setRoute({ name: t });
  const go = (a: HomeAction) => setRoute({ name: a } as Route);
  /** Igual que go, pero al volver regresa a `from` (la Bóveda, la Cartera o la ficha de un token). */
  const goFrom = (from: Route) => (a: HomeAction) => setRoute({ name: a, back: from } as Route);
  const back = (r: Route) => () => {
    const b = (r as { back?: unknown }).back;
    setRoute(b && typeof b === "object" ? (b as Route) : { name: "home" });
  };

  if (!ready) {
    return (
      <Backdrop>
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={colors.brass} />
        </View>
      </Backdrop>
    );
  }

  // El kit de rescate se muestra justo después de crear la bóveda (o de pasar a la v2). Hasta comprobarlo, queda
  // guardado detrás de Face ID y se puede volver a ver desde Inicio; después se borra del móvil.
  if (route.name === "kit") return <RecoveryKit words={route.words} vaultId={route.vaultId} password={route.password} onDone={home} />;
  // Bóveda recién creada con el kit ya comprobado: su número y la contraseña, para apuntarlos.
  if (route.name === "vaultReady") return <VaultReady vaultId={route.vaultId} password={route.password} onDone={home} />;
  // Varias wallets (0.10): la lista se abre desde Inicio, Ajustes o la bienvenida; elegir otra monta la app de nuevo.
  if (route.name === "wallets") return <WalletsScreen onBack={back(route)} />;
  // La recuperación con el kit crea la cartera a mitad de camino: se queda en su pantalla hasta acabar.
  if (route.name === "recover") {
    const pending = profile?.pendingRecovery;
    return <Recover onBack={home} onDone={home} initialVaultId={pending?.vaultId} initialStolen={route.stolen ?? pending?.stolen} />;
  }
  if (route.name === "rescue") return <Rescue onBack={home} />;
  // DeRec: recuperar con amigos en un móvil nuevo. Se queda aquí hasta acabar (al instalar ya hay perfil).
  if (route.name === "friendsRecover") return <FriendsRecover onBack={home} onDone={home} />;

  // Cambio de móvil hacia este móvil: hasta que el viejo confirme, solo esta pantalla.
  if (profile?.pendingMove) return <MoveWaiting />;
  if (route.name === "moveIn" && (!profile || !profile.vault)) return <MoveIn onBack={home} />;
  if (!profile)
    return (
      <Welcome
        onRecover={() => setRoute({ name: "recover" })}
        onStolen={() => setRoute({ name: "recover", stolen: true })}
        onMoveIn={() => setRoute({ name: "moveIn" })}
        onWallets={() => setRoute({ name: "wallets", back: { name: "home" } })}
        onFriends={() => setRoute({ name: "friendsRecover" })}
      />
    );
  if (route.name === "friends") return <FriendsScreen onBack={back(route)} />;
  if (!profile.vault) {
    if (route.name === "createVault") return <CreateVault onBack={home} onDone={(vaultId, password) => setRoute({ name: "vaultReady", vaultId, password })} />;
    return (
      <Fund
        onContinue={() => setRoute({ name: "createVault" })}
        onRecover={() => setRoute({ name: "recover" })}
        onMoveIn={() => setRoute({ name: "moveIn" })}
        onWallets={() => setRoute({ name: "wallets", back: { name: "home" } })}
      />
    );
  }

  const settingsProps = {
    onRescue: () => setRoute({ name: "rescue" }),
    onEvacuate: () => setRoute({ name: "evacuate" }),
    onMigrate: () => setRoute({ name: "migrate" }),
    onDelays: () => setRoute({ name: "delays" }),
    onStaking: () => setRoute({ name: "staking" }),
    onEmail: () => setRoute({ name: "email" }),
    onAllowances: () => setRoute({ name: "allowances" }),
    onAbout: () => setRoute({ name: "about" }),
    onMoveHelp: () => setRoute({ name: "moveHelp" }),
    onNewKit: () => setRoute({ name: "newKit" }),
    onWallets: () => setRoute({ name: "wallets", back: { name: "settings" } }),
    onFriends: () => setRoute({ name: "friends", back: { name: "settings" } }),
  };

  switch (route.name) {
    case "activity":
      return <Activity onTab={onTab} />;
    case "settings":
      return <Settings {...settingsProps} onBack={home} />;
    case "about":
      return <About onBack={() => setRoute({ name: "settings" })} />;
    case "moveHelp":
      return <MoveHelp onBack={() => setRoute({ name: "settings" })} />;
    case "vault":
    case "pocket":
      return <AccountScreen key={route.name} kind={route.name} onBack={home} go={goFrom(route)} onTab={onTab} onToken={(id) => setRoute({ name: "token", id, back: route })} />;
    case "token":
      return (
        <TokenScreen
          id={route.id}
          onBack={back(route)}
          act={(a, asset) => setRoute({ name: a, asset, back: route })}
          onTab={onTab}
          onAccount={(kind) => setRoute(kind === "vault" ? { name: "vault" } : { name: "pocket" })}
          onH10x={() => setRoute({ name: "h10x", back: route })}
        />
      );
    case "send":
      return <Send onBack={back(route)} initialAsset={route.asset} />;
    case "receive":
      return <Receive onBack={back(route)} />;
    case "deposit":
      return <Deposit onBack={back(route)} initialAsset={route.asset} />;
    case "withdraw":
      return <Withdraw onBack={back(route)} initialAsset={route.asset} />;
    case "evacuate":
      return <Evacuate onBack={back(route)} />;
    case "evacuate-kit":
      return <Evacuate onBack={home} suspect="kit" />;
    case "evacuate-device":
      return <Evacuate onBack={home} suspect="device" />;
    case "migrate":
      return <Migrate onBack={home} onDone={showKit} />;
    case "swap":
      return <SwapHome footer={<TabBar current="swap" onChange={onTab} />} onDeposit={() => setRoute({ name: "deposit" })} />;
    case "nfts":
      return <NftHome footer={<TabBar current="nfts" onChange={onTab} />} onOpen={(item, where) => setRoute({ name: "nft", item, where })} />;
    case "nft":
      return <NftDetail item={route.item} where={route.where} onBack={() => setRoute({ name: "nfts" })} />;
    case "dapps":
      return <DappsHome footer={<TabBar current="dapps" onChange={onTab} />} onScan={() => setRoute({ name: "scan" })} onOpen={(dappId) => setRoute({ name: "browser", dappId })} />;
    case "browser":
      return <DappBrowser dappId={route.dappId} path={route.path} onClose={() => setRoute({ name: route.back ?? "dapps" } as Route)} />;
    case "scan":
      return <ScanWc onBack={() => setRoute({ name: "dapps" })} />;
    case "delays":
      return <ChangeDelays onBack={() => setRoute({ name: "settings" })} />;
    case "newKit":
      return <NewKit onBack={() => setRoute({ name: "settings" })} onWithdraw={() => setRoute({ name: "withdraw", back: { name: "newKit" } })} />;
    case "email":
      return <EmailAlerts onBack={() => setRoute({ name: "settings" })} />;
    case "allowances":
      return <Allowances onBack={() => setRoute({ name: "settings" })} />;
    case "staking":
      return (
        <Staking
          onBack={back(route)}
          footer={<TabBar current="home" onChange={onTab} />}
          onH10x={() => setRoute({ name: "h10x", back: route })}
          onOpenDapp={(dappId) => setRoute({ name: "browser", dappId, back: "staking" })}
        />
      );
    case "h10x":
      return <H10xScreen onBack={back(route)} onDao={() => setRoute({ name: "dao" })} onSwap={() => setRoute({ name: "swap" })} onDeposit={() => setRoute({ name: "deposit" })} />;
    case "dao":
      return <DaoScreen onBack={() => setRoute({ name: "h10x" })} onOpenDapp={() => setRoute({ name: "browser", dappId: "h10x", path: "/#dao", back: "dao" })} />;
    default:
      return <Home go={go} onTab={onTab} onKit={(k) => showKit(k.words, k.vaultId, k.password)} onWallets={() => setRoute({ name: "wallets", back: { name: "home" } })} onFriends={() => setRoute({ name: "friends", back: { name: "home" } })} />;
  }
}

/** Bloqueo con Face ID cuando hay cartera y está activado. Al cambiar de idioma, todo se vuelve a pintar. */
function Shell() {
  const { prefs, lang } = usePrefs();
  const { ready, profile } = useWallet();
  // El bloqueo se monta cuando ya se sabe si hay cartera: así bloquea desde el primer momento.
  if (!ready) return <Router key={lang} />;
  return (
    <LockGate enabled={!!profile && prefs.appLock} unlockedOnly={<DappPrompt />}>
      <Router key={lang} />
    </LockGate>
  );
}

/**
 * La wallet abierta. `key`: al elegir otra, todo lo que depende de ella (saldos, guardián, dApps, pantallas) se monta de
 * cero con lo suyo. Lo que sea igual para todas (precios, logos) se queda fuera y no se vuelve a pedir.
 */
function ActiveWallet() {
  const { ready, active, removeActive, reload } = useWallets();
  if (!ready) return null;
  return (
    <WalletProvider key={active} walletId={active} onWiped={removeActive} onChanged={reload}>
      <GuardianStatusProvider>
        <DappsProvider>
          <DerecProvider>
            <Shell />
          </DerecProvider>
        </DappsProvider>
      </GuardianStatusProvider>
    </WalletProvider>
  );
}

export default function App() {
  // Cifras y nombre con Inter Tight (la de la web de H10X). Si no carga, se usa la fuente del sistema.
  const [loaded, error] = useFonts({
    "InterTight-SemiBold": require("@expo-google-fonts/inter-tight/600SemiBold/InterTight_600SemiBold.ttf"),
    "InterTight-Bold": require("@expo-google-fonts/inter-tight/700Bold/InterTight_700Bold.ttf"),
  });
  if (error) {
    typeface.display = undefined;
    typeface.displayBold = undefined;
  }
  return (
    <SafeAreaProvider>
      <PrefsProvider>
        <PricesProvider>
          <MarketProvider>
            <TokenLogosProvider>
              <WalletsProvider>
                <StatusBar style="light" />
                {loaded || error ? (
                  <ActiveWallet />
                ) : (
                  <Backdrop>
                    <View style={{ flex: 1 }} />
                  </Backdrop>
                )}
              </WalletsProvider>
            </TokenLogosProvider>
          </MarketProvider>
        </PricesProvider>
      </PrefsProvider>
    </SafeAreaProvider>
  );
}
