import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { CameraView, useCameraPermissions } from "expo-camera";
import { decodePairingQR } from "@prospero/protocol";
import { useDiscovery } from "@/lib/discovery";
import { upsertHostFromPairing } from "@/lib/hosts";

export default function PairScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [manual, setManual] = useState("");
  const scannedRef = useRef(false);
  const { d } = useLocalSearchParams<{ d?: string }>();
  // 扫描同网段的 prosperod:让用户确认"这台 Mac 确实在跑",再去扫码
  const { hosts: discovered } = useDiscovery(true);

  const handle = useCallback(async (text: string): Promise<void> => {
    if (scannedRef.current) return;
    scannedRef.current = true;
    try {
      const payload = decodePairingQR(text.trim());
      const host = await upsertHostFromPairing(payload);
      router.replace(`/host/${host.id}`);
    } catch (e) {
      scannedRef.current = false;
      Alert.alert("配对码无效", e instanceof Error ? e.message : String(e));
    }
  }, []);

  // iOS 相机 App 扫码走 prospero:// 深链进入本页
  useEffect(() => {
    if (typeof d === "string" && d.length > 0) {
      void handle(`prospero://pair?d=${d}`);
    }
  }, [d, handle]);

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) {
      void requestPermission();
    }
  }, [permission, requestPermission]);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <Stack.Screen options={{ title: "配对 Mac" }} />
      <View style={styles.cameraWrap}>
        {permission?.granted ? (
          <CameraView
            style={styles.camera}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={({ data }) => void handle(data)}
          />
        ) : (
          <View style={styles.noCam}>
            <Text style={styles.noCamText}>
              {permission?.canAskAgain === false
                ? "相机权限被拒绝,请在系统设置中开启,或使用下方手动输入。"
                : "需要相机权限来扫描配对二维码"}
            </Text>
            <Pressable style={styles.btn} onPress={() => void requestPermission()}>
              <Text style={styles.btnText}>授权相机</Text>
            </Pressable>
          </View>
        )}
        <View style={styles.hintWrap} pointerEvents="none">
          <Text style={styles.hint}>
            {discovered.length > 0
              ? `已在本网络发现 ${String(discovered.length)} 台:${discovered
                  .map((h) => h.name)
                  .join("、")} —— 扫描它的配对码`
              : "对准 Mac 终端里 prosperod pair 打印的二维码"}
          </Text>
        </View>
      </View>
      <View style={styles.manual}>
        <TextInput
          style={styles.input}
          placeholder="或粘贴 prospero://pair?d=… 配对串"
          placeholderTextColor="#5a5a66"
          value={manual}
          onChangeText={setManual}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Pressable style={styles.btn} onPress={() => void handle(manual)}>
          <Text style={styles.btnText}>添加</Text>
        </Pressable>
      </View>
      <Text style={styles.note}>
        首次连接时 iOS 会请求「本地网络」权限,请务必允许,否则无法发现/连接 Mac。
      </Text>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  cameraWrap: { flex: 1, overflow: "hidden" },
  camera: { flex: 1 },
  noCam: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 16 },
  noCamText: { color: "#9a9aa6", textAlign: "center", lineHeight: 20 },
  hintWrap: { position: "absolute", bottom: 16, left: 0, right: 0, alignItems: "center" },
  hint: {
    color: "#e8e8ee",
    backgroundColor: "rgba(0,0,0,0.55)",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    fontSize: 12,
    overflow: "hidden",
  },
  manual: { flexDirection: "row", gap: 8, padding: 12 },
  input: {
    flex: 1,
    backgroundColor: "#17171d",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: "#e8e8ee",
    fontSize: 13,
  },
  btn: {
    backgroundColor: "#3557b7",
    borderRadius: 8,
    paddingHorizontal: 16,
    justifyContent: "center",
    paddingVertical: 10,
  },
  btnText: { color: "#fff", fontWeight: "600" },
  note: { color: "#6a6a76", fontSize: 12, paddingHorizontal: 12, paddingBottom: 16 },
});
