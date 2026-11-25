// About: qué es H10X Wallet, su versión, el enlace a la web de H10X y quién ha creado la app.
import React from "react";
import { Text, View } from "react-native";
import Constants from "expo-constants";
import * as Application from "expo-application";
import { H10X_WEB } from "@boveda/core";
import { Card, Group, ListRow, P, Screen, SectionTitle } from "../ui";
import { BrandTitle } from "../components/VaultDial";
import { colors, space, typeface } from "../theme";
import { NETWORK } from "../env";
import { t } from "../i18n";
import { open } from "../helpers";

/** Equipo de H10X (nombre y papel). */
export const TEAM: { person: string; role: string; tint: string }[] = [
  { person: "H10X team", role: "Design and development", tint: colors.safe },
];

export function About({ onBack }: { onBack: () => void }) {
  const version = Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? "";
  const build = Application.nativeBuildVersion;
  return (
    <Screen heading="About" onBack={onBack}>
      <Card style={{ alignItems: "center", marginTop: space.s }}>
        <BrandTitle height={30} center />
        <P muted center style={{ marginTop: space.m, marginBottom: 0 }}>
          {t("La wallet de H10X para Hedera, con tu dinero protegido en una bóveda.", "H10X's wallet for Hedera, with your money protected in a vault.")}
        </P>
        <Text style={{ color: colors.muted, fontSize: 13, marginTop: space.s }}>
          {[version ? t(`Versión ${version}`, `Version ${version}`) : null, build ? `(${build})` : null, NETWORK === "mainnet" ? "Beta · mainnet" : NETWORK].filter(Boolean).join(" ")}
        </Text>
      </Card>

      <Group>
        <ListRow icon="globe" iconColor={colors.brass} title="h10xindex.xyz" subtitle={t("El Index DTF de Hedera y su DAO", "Hedera's Index DTF and its DAO")} onPress={() => open(H10X_WEB)} />
      </Group>

      <SectionTitle>{t("Quién ha creado la app", "Who made the app")}</SectionTitle>
      <Group>
        {TEAM.map((m) => (
          <View key={m.person} style={{ flexDirection: "row", alignItems: "center", gap: space.m, paddingVertical: 12, paddingHorizontal: space.l, minHeight: 60 }} accessible accessibilityLabel={`${m.person}, ${m.role}`}>
            <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: `${m.tint}22`, alignItems: "center", justifyContent: "center" }}>
              <Text style={{ color: m.tint, fontSize: 17, fontFamily: typeface.display, fontWeight: typeface.display ? undefined : "700" }}>{m.person[0]}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.text, fontSize: 16, fontWeight: "600" }}>{m.person}</Text>
              <Text style={{ color: colors.muted, fontSize: 13, marginTop: 2 }}>{m.role}</Text>
            </View>
          </View>
        ))}
      </Group>
    </Screen>
  );
}
