import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

interface PromptDialogProps {
  visible: boolean;
  title: string;
  message?: string;
  value: string;
  confirmLabel?: string;
  secureTextEntry?: boolean;
  onChangeText: (value: string) => void;
  onCancel: () => void;
  onSubmit: (value: string) => void | Promise<void>;
  validate?: (value: string) => string | null;
}

/**
 * Alert.prompt 的跨平台替代品。
 *
 * value / visible 由调用方控制；组件只管理校验展示和异步提交状态，因而同一套
 * 行为能用于 iOS 与 Android，也不会在网络请求尚未完成时重复提交。
 */
export function PromptDialog({
  visible,
  title,
  message,
  value,
  confirmLabel = "确定",
  secureTextEntry = false,
  onChangeText,
  onCancel,
  onSubmit,
  validate,
}: PromptDialogProps): React.ReactElement {
  const inputRef = useRef<TextInput>(null);
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    // 每次打开/换题目都重置一次本地反馈；放在 effect 完成后的 microtask，避免
    // 在提交 props 的同步阶段再触发一轮渲染。
    queueMicrotask(() => {
      if (cancelled) return;
      setTouched(false);
      setSubmitting(false);
      setSubmitError(null);
    });
    return () => {
      cancelled = true;
    };
  }, [visible, title]);

  const validationError = validate?.(value) ?? null;
  const shownError = submitError ?? (touched ? validationError : null);

  const cancel = (): void => {
    if (!submitting) onCancel();
  };

  const submit = async (): Promise<void> => {
    setTouched(true);
    setSubmitError(null);
    if (validationError !== null || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(value);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      onShow={() => inputRef.current?.focus()}
      onRequestClose={cancel}
    >
      <View style={styles.overlay} accessibilityViewIsModal>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="关闭输入弹窗"
          style={StyleSheet.absoluteFill}
          onPress={cancel}
        />
        <KeyboardAvoidingView
          pointerEvents="box-none"
          style={styles.keyboardAvoider}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
        >
          <View style={styles.dialog}>
            <Text style={styles.title}>{title}</Text>
            {message !== undefined && <Text style={styles.message}>{message}</Text>}
            <TextInput
              ref={inputRef}
              style={[styles.input, shownError !== null && styles.inputError]}
              value={value}
              onChangeText={(next) => {
                setTouched(true);
                setSubmitError(null);
                onChangeText(next);
              }}
              onSubmitEditing={() => void submit()}
              editable={!submitting}
              selectTextOnFocus
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              returnKeyType="done"
              importantForAutofill="no"
              secureTextEntry={secureTextEntry}
            />
            <Text style={[styles.error, shownError === null && styles.errorHidden]}>
              {shownError ?? "占位"}
            </Text>
            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
                onPress={cancel}
                disabled={submitting}
              >
                <Text style={styles.cancelText}>取消</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                style={({ pressed }) => [
                  styles.button,
                  styles.confirmButton,
                  (validationError !== null || submitting) && styles.buttonDisabled,
                  pressed && styles.buttonPressed,
                ]}
                onPress={() => void submit()}
                disabled={validationError !== null || submitting}
              >
                {submitting ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.confirmText}>{confirmLabel}</Text>
                )}
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.62)",
  },
  keyboardAvoider: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  dialog: {
    alignSelf: "center",
    width: "100%",
    maxWidth: 420,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#34343f",
    backgroundColor: "#1a1a21",
    padding: 18,
  },
  title: { color: "#f0f0f5", fontSize: 18, fontWeight: "600" },
  message: { color: "#9a9aa6", fontSize: 13, lineHeight: 18, marginTop: 6 },
  input: {
    marginTop: 14,
    borderWidth: 1,
    borderColor: "#3a3a46",
    borderRadius: 10,
    backgroundColor: "#101014",
    color: "#f0f0f5",
    fontSize: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  inputError: { borderColor: "#e5534b" },
  error: { color: "#f08a84", fontSize: 12, lineHeight: 17, marginTop: 5 },
  errorHidden: { opacity: 0 },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 6 },
  button: {
    minWidth: 78,
    minHeight: 40,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  confirmButton: { backgroundColor: "#3557b7" },
  buttonPressed: { opacity: 0.72 },
  buttonDisabled: { opacity: 0.42 },
  cancelText: { color: "#b5b5c0", fontSize: 15 },
  confirmText: { color: "#fff", fontSize: 15, fontWeight: "600" },
});
