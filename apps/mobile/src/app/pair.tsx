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
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { decodePairingQR } from "@prospero/protocol";
import { useDiscovery } from "@/lib/discovery";
import { upsertHostFromPairing } from "@/lib/hosts";

export default function PairScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const insets = useSafeAreaInsets();
  const [manual, setManual] = useState("");
  const scannedRef = useRef(false);
  const { d } = useLocalSearchParams<{ d?: string }>();
  // 扫描同网段的 prosperod:让用户确认这台电脑确实在线，再去扫码。
  const { hosts: discovered, scanning, unavailable, timedOut } = useDiscovery(true);

  const discoveryHint =
    discovered.length > 0
      ? `已在本网络发现 ${String(discovered.length)} 台：${discovered
          .map((h) => h.name)
          .join("、")} —— 扫描它的配对码`
      : unavailable
        ? "局域网发现不可用；仍可直接扫码或粘贴配对串"
        : timedOut
          ? "未发现附近的电脑；部分 Android ROM 会限制 mDNS，直接扫码不受影响"
          : scanning
            ? "正在发现同一网络里的电脑…也可以直接扫描配对码"
            : "对准电脑终端里 prosperod pair 打印的二维码";

  const handle = useCallback(async (text: string): Promise<void> => {
    if (scannedRef.current) return;
    scannedRef.current = true;
    try {
      // Production pairing must reject cleartext relay URLs.  The only
      // development exception mirrors the protocol policy: loopback ws://.
      const payload = decodePairingQR(text.trim(), {
        allowInsecureLoopback: typeof __DEV__ !== "undefined" && __DEV__,
      });
      const host = await upsertHostFromPairing(payload);
      // 深链每次都会把 /pair 压进栈,replace 只换掉这一层 —— 反复扫码/点深链
      // 会攒出一摞 host 页,返回要点很多下。先退回根再进。
      if (router.canDismiss()) router.dismissAll();
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
    // 外部相机/配对链接已经带了完整 payload，不应再弹内部相机权限遮住跳转。
    if (typeof d !== "string" && permission && !permission.granted && permission.canAskAgain) {
      void requestPermission();
    }
  }, [d, permission, requestPermission]);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <Stack.Screen options={{ title: "配对电脑" }} />
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
            {discoveryHint}
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
          // 回车即配对 —— 单行框按下 return 会自动失焦,顺带把键盘收了
          returnKeyType="go"
          onSubmitEditing={() => void handle(manual)}
        />
        <Pressable style={styles.btn} onPress={() => void handle(manual)}>
          <Text style={styles.btnText}>添加</Text>
        </Pressable>
      </View>
      <Text style={[styles.note, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        {Platform.OS === "ios"
          ? "首次连接时 iOS 会请求「本地网络」权限，请允许，否则无法发现或连接电脑。"
          : "Android 的 mDNS 发现可能受 ROM 或 VPN 限制；发现失败时直接扫码即可，配对与连接不依赖发现。"}
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
    textAlign: "center",
    maxWidth: "92%",
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
  note: { color: "#6a6a76", fontSize: 12, lineHeight: 17, paddingHorizontal: 12 },
});
