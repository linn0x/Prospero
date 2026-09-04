import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  AccessibilityInfo,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  type StyleProp,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ViewStyle,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from "expo-glass-effect";
import * as Linking from "expo-linking";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { decodePairingQR } from "@prospero/protocol";
import { useDiscovery } from "@/lib/discovery";
import { upsertHostFromPairing } from "@/lib/hosts";
import { pairingErrorNotice } from "@/lib/pairing-error-notice";
import { color, radius, space } from "@/lib/theme";

const glassApiAvailable = Platform.OS === "ios" && isLiquidGlassAvailable() && isGlassEffectAPIAvailable();

function GlassSurface({
  children,
  enabled,
  style,
  fallbackStyle,
}: {
  children: ReactNode;
  enabled: boolean;
  style: StyleProp<ViewStyle>;
  fallbackStyle: StyleProp<ViewStyle>;
}) {
  if (enabled) {
    return <GlassView style={style} glassEffectStyle="regular" tintColor="#16161AD9" colorScheme="dark">{children}</GlassView>;
  }
  return <View style={[style, fallbackStyle]}>{children}</View>;
}

export default function PairScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const insets = useSafeAreaInsets();
  const [manual, setManual] = useState("");
  const [pairing, setPairing] = useState(false);
  const [reduceTransparency, setReduceTransparency] = useState(false);
  const scannedRef = useRef(false);
  const { d } = useLocalSearchParams<{ d?: string }>();
  const glassEnabled = glassApiAvailable && !reduceTransparency;
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
          ? Platform.OS === "ios"
            ? "未发现附近的电脑；请确认已允许本地网络访问，直接扫码不受影响"
            : "未发现附近的电脑；部分 Android ROM 会限制 mDNS，直接扫码不受影响"
          : scanning
            ? "正在发现同一网络里的电脑…也可以直接扫描配对码"
            : "对准电脑终端里 prosperod pair 打印的二维码";

  const handle = useCallback(async (text: string): Promise<void> => {
    if (scannedRef.current) return;
    scannedRef.current = true;
    setPairing(true);
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
      setPairing(false);
      const notice = pairingErrorNotice(e);
      Alert.alert(notice.title, notice.message);
    }
  }, []);

  const requestCameraAccess = (): void => {
    const action = permission?.canAskAgain === false ? Linking.openSettings() : requestPermission();
    void action.catch(() => Alert.alert("无法打开设置", "请在系统设置中为 Prospero 开启相机权限。"));
  };

  const pastePairingCode = async (): Promise<void> => {
    try {
      const value = (await Clipboard.getStringAsync()).trim();
      if (value) setManual(value);
      else Alert.alert("剪贴板为空", "请先在电脑端复制配对串。");
    } catch {
      Alert.alert("无法读取剪贴板", "请长按输入框手动粘贴配对串。");
    }
  };

  useEffect(() => {
    if (Platform.OS !== "ios") return;
    let active = true;
    void AccessibilityInfo.isReduceTransparencyEnabled().then((value) => {
      if (active) setReduceTransparency(value);
    });
    const subscription = AccessibilityInfo.addEventListener("reduceTransparencyChanged", setReduceTransparency);
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  // iOS 相机 App 扫码走 prospero:// 深链进入本页
  useEffect(() => {
    if (typeof d !== "string" || d.length === 0) return;
    const timer = setTimeout(() => void handle(`prospero://pair?d=${d}`), 0);
    return () => clearTimeout(timer);
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
            onBarcodeScanned={pairing ? undefined : ({ data }) => void handle(data)}
          />
        ) : (
          <View style={styles.noCam}>
            <GlassSurface enabled={glassEnabled} style={styles.permissionCard} fallbackStyle={styles.permissionFallback}>
              <Text style={styles.noCamText}>
                {permission?.canAskAgain === false
                  ? "相机权限已关闭，可前往系统设置开启，或粘贴下方配对串。"
                  : "允许相机后，对准电脑上的配对二维码即可连接。"}
              </Text>
              <Pressable
                style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}
                onPress={requestCameraAccess}
                accessibilityRole="button"
                accessibilityLabel={permission?.canAskAgain === false ? "打开系统设置" : "允许使用相机"}
              >
                <Text style={styles.btnText}>{permission?.canAskAgain === false ? "打开系统设置" : "允许使用相机"}</Text>
              </Pressable>
            </GlassSurface>
          </View>
        )}
        <View style={styles.hintWrap} pointerEvents="none">
          <GlassSurface enabled={glassEnabled} style={styles.hint} fallbackStyle={styles.hintFallback}>
            <Text style={styles.hintText}>{discoveryHint}</Text>
          </GlassSurface>
        </View>
      </View>
      <GlassSurface
        enabled={glassEnabled}
        style={[styles.bottomPanel, { paddingBottom: Math.max(insets.bottom, space.lg) }]}
        fallbackStyle={styles.bottomFallback}
      >
        <View style={styles.manual}>
          <TextInput
            style={styles.input}
            placeholder="粘贴 prospero://pair?d=… 配对串"
            placeholderTextColor={color.textFaint}
            value={manual}
            onChangeText={setManual}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="go"
            onSubmitEditing={() => manual.trim() && void handle(manual)}
          />
          <Pressable
            style={({ pressed }) => [styles.iconButton, pressed && styles.btnPressed]}
            onPress={() => void pastePairingCode()}
            accessibilityRole="button"
            accessibilityLabel="从剪贴板粘贴配对串"
          >
            <Text style={styles.iconButtonText}>粘贴</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.btn, (!manual.trim() || pairing) && styles.disabled, pressed && styles.btnPressed]}
            disabled={!manual.trim() || pairing}
            onPress={() => void handle(manual)}
            accessibilityRole="button"
            accessibilityLabel="添加配对电脑"
            accessibilityState={{ disabled: !manual.trim() || pairing, busy: pairing }}
          >
            {pairing ? <ActivityIndicator size="small" color={color.onAccent} /> : <Text style={styles.btnText}>添加</Text>}
          </Pressable>
        </View>
        <Text style={styles.note}>
          {Platform.OS === "ios"
            ? "首次连接请允许「本地网络」访问；若曾拒绝，可在系统设置中重新开启。"
            : "Android 的 mDNS 发现可能受 ROM 或 VPN 限制；发现失败时直接扫码即可。"}
        </Text>
      </GlassSurface>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: color.bg },
  cameraWrap: { flex: 1, overflow: "hidden" },
  camera: { flex: 1 },
  noCam: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl },
  permissionCard: { width: "100%", maxWidth: 360, alignItems: "center", gap: space.lg, padding: space.xl, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: "#FFFFFF20" },
  permissionFallback: { backgroundColor: color.surface },
  noCamText: { color: color.textDim, textAlign: "center", lineHeight: 20 },
  hintWrap: { position: "absolute", bottom: 16, left: 0, right: 0, alignItems: "center" },
  hint: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#FFFFFF24",
    maxWidth: "92%",
  },
  hintFallback: { backgroundColor: "rgba(0,0,0,0.62)" },
  hintText: {
    color: color.text,
    fontSize: 12,
    textAlign: "center",
  },
  bottomPanel: { paddingHorizontal: space.md, paddingTop: space.md, gap: space.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#FFFFFF1A" },
  bottomFallback: { backgroundColor: color.surface },
  manual: { flexDirection: "row", alignItems: "center", gap: space.sm },
  input: {
    flex: 1,
    minHeight: 44,
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.sm,
    paddingHorizontal: 12,
    color: color.text,
    fontSize: 13,
  },
  btn: {
    minHeight: 44,
    backgroundColor: color.accent,
    borderRadius: radius.sm,
    paddingHorizontal: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  btnPressed: { opacity: 0.82 },
  btnText: { color: color.onAccent, fontWeight: "700" },
  iconButton: { minWidth: 48, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.sm, backgroundColor: color.surfaceRaised },
  iconButtonText: { color: color.accent, fontSize: 12, fontWeight: "700" },
  disabled: { opacity: 0.45 },
  note: { color: color.textDim, fontSize: 12, lineHeight: 17 },
});
