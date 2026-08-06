import { Keyboard, Pressable, StyleSheet, View } from "react-native";
import { Icon } from "@/components/Icon";
import { color, radius, space } from "@/lib/theme";

/**
 * 收起键盘。
 *
 * 多行输入框在 iOS 上没有 Done 键 —— 回车归换行用 —— 所以键盘一旦弹起来,
 * 唯一的出路是拖动旁边的滚动区。可聊天记录是空的、文件正好一屏、差异列表
 * 没几行的时候,连拖都没得拖,键盘就把下半屏占死了。终端那边早为同样的原因
 * 加过一个 ⌄,这里把它变成三处共用的一个东西。
 *
 * 只在输入框有焦点时给出来:没在打字的时候,它只是个碍眼的按钮。
 */
export function DismissKey({ visible, floating = false }: { visible: boolean; floating?: boolean }) {
  if (!visible) return null;
  const button = (
    <Pressable
      style={({ pressed }) => [styles.btn, pressed && styles.pressed]}
      onPress={() => { Keyboard.dismiss(); }}
      accessibilityRole="button"
      accessibilityLabel="收起键盘"
      hitSlop={8}
    >
      <Icon name="chevron.down" size={17} color={color.textDim} weight="semibold" />
    </Pressable>
  );
  // 编辑器那种"输入框铺满整屏"的地方没有一行可以并排摆按钮的地方,
  // 只能浮在右上角 —— 压在文字上,但那是唯一不会被键盘盖住的角落
  return floating ? <View style={styles.floating}>{button}</View> : button;
}

const styles = StyleSheet.create({
  btn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: color.surfaceRaised,
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: { backgroundColor: color.pressed },
  floating: {
    position: "absolute",
    right: space.md,
    top: space.md,
    zIndex: 10,
    borderRadius: radius.lg,
    // 浮在代码上面,得有个底才看得清
    shadowColor: "#000",
    shadowOpacity: 0.4,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
});
