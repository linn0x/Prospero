import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = process.env.PROSPERO_GHOSTTY_SOURCE || resolve(homedir(), "Library/Caches/Prospero-native/ghostty-v1.3.1");
const zig = process.env.PROSPERO_ZIG || resolve(homedir(), "Library/Caches/Prospero-native/zig-aarch64-macos-0.15.2/zig");
const revision = "332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28";
const target = process.env.PROSPERO_GHOSTTY_ANDROID_TARGET || "aarch64-linux-android.24";
const abi = process.env.PROSPERO_GHOSTTY_ANDROID_ABI || "arm64-v8a";
const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || resolve(homedir(), "Library/Android/sdk");
const out = resolve(root, "modules/prospero-ghostty/android/src/main/jniLibs", abi);
const include = resolve(root, "modules/prospero-ghostty/android/src/main/cpp/include");
const ndkTriple = "aarch64-linux-android";

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.error || ""}`);
};

const hasArm64Stubs = (sdk) => {
  try {
    const tbd = readFileSync(join(sdk, "usr/lib/libSystem.tbd"), "utf8");
    const start = tbd.indexOf("targets:");
    return start >= 0 && /\barm64-macos\b/.test(tbd.slice(start, tbd.indexOf("]", start)));
  } catch {
    return false;
  }
};

const linkableSdk = () => {
  if (process.env.PROSPERO_GHOSTTY_SDK) return process.env.PROSPERO_GHOSTTY_SDK;
  const current = spawnSync("xcrun", ["--sdk", "macosx", "--show-sdk-path"], { encoding: "utf8" }).stdout.trim();
  if (hasArm64Stubs(current)) return null;
  const roots = [
    "/Library/Developer/CommandLineTools/SDKs",
    "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs",
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const found = readdirSync(root)
      .filter((name) => /^MacOSX\d+(\.\d+)*\.sdk$/.test(name))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((name) => join(root, name))
      .find(hasArm64Stubs);
    if (found) return found;
  }
  throw new Error(`No macOS SDK with arm64 stubs found; set PROSPERO_GHOSTTY_SDK`);
};

const toolShims = () => {
  const sdk = linkableSdk();
  if (!sdk) return null;
  const dir = mkdtempSync(join(tmpdir(), "prospero-android-ghostty-shims-"));
  writeFileSync(join(dir, "xcrun"), `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "--show-sdk-path" ]; then echo '${sdk}'; exit 0; fi
done
exec /usr/bin/xcrun "$@"
`);
  chmodSync(join(dir, "xcrun"), 0o755);
  console.log(`Using ${sdk} for Zig host tools`);
  return dir;
};

const androidNdk = () => {
  if (process.env.ANDROID_NDK_HOME) return process.env.ANDROID_NDK_HOME;
  const ndkRoot = join(androidHome, "ndk");
  const version = readdirSync(ndkRoot)
    .filter((name) => /^\d+(\.\d+)*$/.test(name))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
  if (!version) throw new Error(`No Android NDK found under ${ndkRoot}`);
  return join(ndkRoot, version);
};

const appendPath = (value, extra) => value ? `${extra}${delimiter}${value}` : extra;

const androidVtHeader = `typedef void* ghostty_android_vt_t;

typedef struct {
  uint32_t codepoint;
  uint8_t fg_r;
  uint8_t fg_g;
  uint8_t fg_b;
  uint8_t bg_r;
  uint8_t bg_g;
  uint8_t bg_b;
  uint8_t flags;
} ghostty_android_vt_cell_s;

`;

const androidVtApiHeader = `ghostty_android_vt_t ghostty_android_vt_new(uint32_t, uint32_t);
void ghostty_android_vt_free(ghostty_android_vt_t);
bool ghostty_android_vt_resize(ghostty_android_vt_t, uint32_t, uint32_t);
bool ghostty_android_vt_feed(ghostty_android_vt_t, const char*, uintptr_t);
bool ghostty_android_vt_snapshot(ghostty_android_vt_t,
                                 ghostty_android_vt_cell_s*,
                                 uintptr_t,
                                 uint32_t*,
                                 uint32_t*,
                                 uint32_t*,
                                 uint32_t*);
bool ghostty_android_vt_snapshot_range(ghostty_android_vt_t,
                                       ghostty_android_vt_cell_s*,
                                       uintptr_t,
                                       uint32_t,
                                       uint32_t,
                                       uint32_t*,
                                       uint32_t*,
                                       uint32_t*,
                                       uint32_t*,
                                       uint32_t*);
bool ghostty_android_vt_encode_text(ghostty_android_vt_t, const char*, uintptr_t, char*, uintptr_t, uintptr_t*);
bool ghostty_android_vt_encode_key(ghostty_android_vt_t, uint32_t, uint32_t, const char*, uintptr_t, bool, uint32_t, char*, uintptr_t, uintptr_t*);
bool ghostty_android_vt_encode_paste(ghostty_android_vt_t, const char*, uintptr_t, char*, uintptr_t, uintptr_t*);
bool ghostty_android_vt_encode_mouse(ghostty_android_vt_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, char*, uintptr_t, uintptr_t*);
bool ghostty_android_vt_bracketed_paste(ghostty_android_vt_t);
bool ghostty_android_vt_mouse_reporting(ghostty_android_vt_t);

`;

const androidVtApiHeaderLegacy = androidVtApiHeader.replace(
  `bool ghostty_android_vt_snapshot_range(ghostty_android_vt_t,
                                       ghostty_android_vt_cell_s*,
                                       uintptr_t,
                                       uint32_t,
                                       uint32_t,
                                       uint32_t*,
                                       uint32_t*,
                                       uint32_t*,
                                       uint32_t*,
                                       uint32_t*);

`,
  "",
);

const androidVtZig = `const terminalpkg = @import("terminal/main.zig");
const inputpkg = @import("input.zig");
const terminal_color = @import("terminal/color.zig");
const terminal_size = @import("terminal/size.zig");

const AndroidVt = struct {
    term: terminalpkg.Terminal,
};

const AndroidVtCell = extern struct {
    codepoint: u32,
    fg_r: u8,
    fg_g: u8,
    fg_b: u8,
    bg_r: u8,
    bg_g: u8,
    bg_b: u8,
    flags: u8,
};

const android_vt_fg: terminal_color.RGB = .{ .r = 225, .g = 230, .b = 219 };
const android_vt_bg: terminal_color.RGB = .{ .r = 9, .g = 9, .b = 11 };

fn androidVtSize(value: u32) terminal_size.CellCountInt {
    return @intCast(@min(@max(value, 1), @as(u32, std.math.maxInt(terminal_size.CellCountInt))));
}

fn androidVtFlags(cell: *const @import("terminal/page.zig").Cell, style_value: @import("terminal/style.zig").Style) u8 {
    var flags: u8 = 0;
    if (style_value.flags.bold) flags |= 1;
    if (style_value.flags.italic) flags |= 2;
    if (style_value.flags.underline != .none) flags |= 4;
    if (style_value.flags.inverse) flags |= 8;
    if (style_value.flags.strikethrough) flags |= 16;
    if (style_value.flags.overline) flags |= 32;
    if (cell.wide == .wide) flags |= 64;
    if (cell.wide == .spacer_tail or cell.wide == .spacer_head) flags |= 128;
    return flags;
}

fn androidVtMods(value: u32) inputpkg.Mods {
    return .{
        .shift = value & 1 != 0,
        .ctrl = value & 2 != 0,
        .alt = value & 4 != 0,
        .super = value & 8 != 0,
        .caps_lock = value & 16 != 0,
        .num_lock = value & 32 != 0,
    };
}

fn androidVtKey(value: u32, utf8: []const u8) inputpkg.Key {
    return switch (value) {
        1 => .enter,
        2 => .backspace,
        3 => .tab,
        4 => .escape,
        5 => .arrow_up,
        6 => .arrow_down,
        7 => .arrow_left,
        8 => .arrow_right,
        9 => .delete,
        10 => .home,
        11 => .end,
        12 => .page_up,
        13 => .page_down,
        14 => .insert,
        else => key: {
            if (value >= 100 and value <= 125) {
                const ch: u8 = @intCast('a' + value - 100);
                break :key inputpkg.Key.fromASCII(ch) orelse .unidentified;
            }
            if (value >= 200 and value <= 209) {
                const ch: u8 = @intCast('0' + value - 200);
                break :key inputpkg.Key.fromASCII(ch) orelse .unidentified;
            }
            if (utf8.len == 1) break :key inputpkg.Key.fromASCII(utf8[0]) orelse .unidentified;
            break :key .unidentified;
        },
    };
}

fn androidVtFirstCodepoint(utf8: []const u8) u21 {
    var view = std.unicode.Utf8View.init(utf8) catch return 0;
    var iterator = view.iterator();
    return iterator.nextCodepoint() orelse 0;
}

fn androidVtEncodeEvent(
    vt: *AndroidVt,
    key_value: u32,
    mods_value: u32,
    data: ?[*]const u8,
    len: usize,
    composing: bool,
    action_value: u32,
    out: ?[*]u8,
    out_cap: usize,
    out_len: ?*usize,
) bool {
    if (out_len) |v| v.* = 0;
    const out_ptr = out orelse return false;
    const utf8 = if (len == 0) "" else (data orelse return false)[0..len];
    const mods = androidVtMods(mods_value);
    const action: inputpkg.Action = switch (action_value) {
        1 => .release,
        2 => .repeat,
        else => .press,
    };
    const event: inputpkg.KeyEvent = .{
        .action = action,
        .key = androidVtKey(key_value, utf8),
        .mods = mods,
        .consumed_mods = if (utf8.len > 0) mods else .{},
        .composing = composing,
        .utf8 = utf8,
        .unshifted_codepoint = androidVtFirstCodepoint(utf8),
    };
    var writer: std.Io.Writer = .fixed(out_ptr[0..out_cap]);
    inputpkg.key_encode.encode(&writer, event, inputpkg.key_encode.Options.fromTerminal(&vt.term)) catch return false;
    if (out_len) |v| v.* = writer.buffered().len;
    return true;
}

fn androidVtCopyPasteSlice(writer: *std.Io.Writer, slice: []const u8) bool {
    writer.writeAll(slice) catch return false;
    return true;
}

fn androidVtMouseButtonCode(action_value: u32, button_value: u32, mods_value: u32, event_mode: terminalpkg.Terminal.MouseEvents, format: terminalpkg.Terminal.MouseFormat) ?u8 {
    var code: u8 = if (button_value == 0) 3 else if (action_value == 1 and format != .sgr and format != .sgr_pixels) 3 else switch (button_value) {
        1 => 0,
        2 => 2,
        3 => 1,
        4 => 64,
        5 => 65,
        6 => 66,
        7 => 67,
        8 => 128,
        9 => 129,
        else => return null,
    };
    const mods = androidVtMods(mods_value);
    if (event_mode != .x10) {
        if (mods.shift) code += 4;
        if (mods.alt) code += 8;
        if (mods.ctrl) code += 16;
    }
    if (action_value == 2) code += 32;
    return code;
}

fn androidVtWriteMouseUtf8(writer: *std.Io.Writer, code: u8, col: u32, row: u32) bool {
    writer.writeByte(0x1b) catch return false;
    writer.writeByte('[') catch return false;
    writer.writeByte('M') catch return false;
    writer.writeByte(32 + code) catch return false;
    var buf: [4]u8 = undefined;
    const x_len = std.unicode.utf8Encode(@intCast(32 + col + 1), &buf) catch return false;
    writer.writeAll(buf[0..x_len]) catch return false;
    const y_len = std.unicode.utf8Encode(@intCast(32 + row + 1), &buf) catch return false;
    writer.writeAll(buf[0..y_len]) catch return false;
    return true;
}

pub export fn ghostty_android_vt_new(cols: u32, rows: u32) ?*AndroidVt {
    const alloc = std.heap.c_allocator;
    const handle = alloc.create(AndroidVt) catch return null;
    const term = terminalpkg.Terminal.init(alloc, .{
        .cols = androidVtSize(cols),
        .rows = androidVtSize(rows),
        .max_scrollback = 10000,
        .colors = .{
            .foreground = terminal_color.DynamicRGB.init(android_vt_fg),
            .background = terminal_color.DynamicRGB.init(android_vt_bg),
            .cursor = terminal_color.DynamicRGB.init(android_vt_fg),
            .palette = .default,
        },
    }) catch {
        alloc.destroy(handle);
        return null;
    };
    handle.* = .{ .term = term };
    return handle;
}

pub export fn ghostty_android_vt_free(handle: ?*AndroidVt) void {
    const vt = handle orelse return;
    const alloc = std.heap.c_allocator;
    vt.term.deinit(alloc);
    alloc.destroy(vt);
}

pub export fn ghostty_android_vt_resize(handle: ?*AndroidVt, cols: u32, rows: u32) bool {
    const vt = handle orelse return false;
    vt.term.resize(std.heap.c_allocator, androidVtSize(cols), androidVtSize(rows)) catch return false;
    return true;
}

pub export fn ghostty_android_vt_feed(handle: ?*AndroidVt, data: ?[*]const u8, len: usize) bool {
    const vt = handle orelse return false;
    if (len == 0) return true;
    const ptr = data orelse return false;
    var stream = vt.term.vtStream();
    defer stream.deinit();
    stream.nextSlice(ptr[0..len]) catch return false;
    return true;
}

pub export fn ghostty_android_vt_encode_text(
    handle: ?*AndroidVt,
    data: ?[*]const u8,
    len: usize,
    out: ?[*]u8,
    out_cap: usize,
    out_len: ?*usize,
) bool {
    const vt = handle orelse return false;
    return androidVtEncodeEvent(vt, 0, 0, data, len, false, 0, out, out_cap, out_len);
}

pub export fn ghostty_android_vt_encode_key(
    handle: ?*AndroidVt,
    key_value: u32,
    mods_value: u32,
    data: ?[*]const u8,
    len: usize,
    composing: bool,
    action_value: u32,
    out: ?[*]u8,
    out_cap: usize,
    out_len: ?*usize,
) bool {
    const vt = handle orelse return false;
    return androidVtEncodeEvent(vt, key_value, mods_value, data, len, composing, action_value, out, out_cap, out_len);
}

pub export fn ghostty_android_vt_encode_paste(
    handle: ?*AndroidVt,
    data: ?[*]const u8,
    len: usize,
    out: ?[*]u8,
    out_cap: usize,
    out_len: ?*usize,
) bool {
    const vt = handle orelse return false;
    if (out_len) |v| v.* = 0;
    const out_ptr = out orelse return false;
    const in_ptr = if (len == 0) "" else (data orelse return false)[0..len];
    const alloc = std.heap.c_allocator;
    const mutable = alloc.alloc(u8, in_ptr.len) catch return false;
    defer alloc.free(mutable);
    @memcpy(mutable, in_ptr);
    const slices = inputpkg.paste.encode(mutable, inputpkg.paste.Options.fromTerminal(&vt.term));
    var writer: std.Io.Writer = .fixed(out_ptr[0..out_cap]);
    if (!androidVtCopyPasteSlice(&writer, slices[0])) return false;
    if (!androidVtCopyPasteSlice(&writer, slices[1])) return false;
    if (!androidVtCopyPasteSlice(&writer, slices[2])) return false;
    if (out_len) |v| v.* = writer.buffered().len;
    return true;
}

pub export fn ghostty_android_vt_encode_mouse(
    handle: ?*AndroidVt,
    action_value: u32,
    button_value: u32,
    mods_value: u32,
    col_value: u32,
    row_value: u32,
    out: ?[*]u8,
    out_cap: usize,
    out_len: ?*usize,
) bool {
    const vt = handle orelse return false;
    if (out_len) |v| v.* = 0;
    const out_ptr = out orelse return false;
    const event_mode = vt.term.flags.mouse_event;
    const format = vt.term.flags.mouse_format;
    switch (event_mode) {
        .none => return false,
        .x10 => if (action_value != 0 or button_value == 0 or button_value > 3) return false,
        .normal => if (action_value == 2) return false,
        .button => if (button_value == 0) return false,
        .any => {},
    }
    const col = @min(col_value, @as(u32, @intCast(@max(vt.term.cols, 1) - 1)));
    const row = @min(row_value, @as(u32, @intCast(@max(vt.term.rows, 1) - 1)));
    const code = androidVtMouseButtonCode(action_value, button_value, mods_value, event_mode, format) orelse return false;
    var writer: std.Io.Writer = .fixed(out_ptr[0..out_cap]);
    switch (format) {
        .x10 => {
            if (col > 222 or row > 222) return false;
            writer.writeByte(0x1b) catch return false;
            writer.writeByte('[') catch return false;
            writer.writeByte('M') catch return false;
            writer.writeByte(32 + code) catch return false;
            writer.writeByte(@intCast(32 + col + 1)) catch return false;
            writer.writeByte(@intCast(32 + row + 1)) catch return false;
        },
        .utf8 => if (!androidVtWriteMouseUtf8(&writer, code, col, row)) return false,
        .sgr, .sgr_pixels => {
            const final: u8 = if (action_value == 1) 'm' else 'M';
            writer.print("\\x1B[<{d};{d};{d}{c}", .{ code, col + 1, row + 1, final }) catch return false;
        },
        .urxvt => {
            writer.print("\\x1B[{d};{d};{d}M", .{ 32 + code, col + 1, row + 1 }) catch return false;
        },
    }
    if (out_len) |v| v.* = writer.buffered().len;
    return true;
}

pub export fn ghostty_android_vt_bracketed_paste(handle: ?*AndroidVt) bool {
    const vt = handle orelse return false;
    return vt.term.modes.get(.bracketed_paste);
}

pub export fn ghostty_android_vt_mouse_reporting(handle: ?*AndroidVt) bool {
    const vt = handle orelse return false;
    return vt.term.flags.mouse_event != .none;
}

pub export fn ghostty_android_vt_snapshot(
    handle: ?*AndroidVt,
    cells: ?[*]AndroidVtCell,
    cell_count: usize,
    out_cols: ?*u32,
    out_rows: ?*u32,
    out_cursor_col: ?*u32,
    out_cursor_row: ?*u32,
) bool {
    const vt = handle orelse return false;
    const screen = vt.term.screens.active;
    const cols = vt.term.cols;
    const rows = vt.term.rows;
    if (out_cols) |v| v.* = cols;
    if (out_rows) |v| v.* = rows;
    if (out_cursor_col) |v| v.* = screen.cursor.x;
    if (out_cursor_row) |v| v.* = screen.cursor.y;

    const out = cells orelse return false;
    const needed = @as(usize, cols) * @as(usize, rows);
    if (cell_count < needed) return false;

    const palette = &vt.term.colors.palette.current;
    const default_fg = vt.term.colors.foreground.get() orelse android_vt_fg;
    const default_bg = vt.term.colors.background.get() orelse android_vt_bg;

    for (0..@as(usize, rows)) |row| {
        for (0..@as(usize, cols)) |col| {
            const index = row * @as(usize, cols) + col;
            var codepoint: u32 = 32;
            var fg = default_fg;
            var bg = default_bg;
            var flags: u8 = 0;
            if (screen.pages.getCell(.{ .active = .{
                .x = @intCast(col),
                .y = @intCast(row),
            } })) |page_cell| {
                const cell = page_cell.cell;
                const style_value = page_cell.style();
                if (cell.hasText()) codepoint = cell.codepoint();
                fg = style_value.fg(.{ .default = default_fg, .palette = palette, .bold = null });
                bg = style_value.bg(cell, palette) orelse default_bg;
                flags = androidVtFlags(cell, style_value);
                if (style_value.flags.inverse) {
                    const tmp = fg;
                    fg = bg;
                    bg = tmp;
                }
            }
            out[index] = .{
                .codepoint = codepoint,
                .fg_r = fg.r,
                .fg_g = fg.g,
                .fg_b = fg.b,
                .bg_r = bg.r,
                .bg_g = bg.g,
                .bg_b = bg.b,
                .flags = flags,
            };
        }
    }

    return true;
}

pub export fn ghostty_android_vt_snapshot_range(
    handle: ?*AndroidVt,
    cells: ?[*]AndroidVtCell,
    cell_count: usize,
    start_line: u32,
    row_count: u32,
    out_cols: ?*u32,
    out_rows: ?*u32,
    out_total_rows: ?*u32,
    out_cursor_col: ?*u32,
    out_cursor_row: ?*u32,
) bool {
    const vt = handle orelse return false;
    const screen = vt.term.screens.active;
    const cols = vt.term.cols;
    const total_rows = screen.pages.total_rows;
    const total_rows_u32: u32 = @intCast(@min(total_rows, @as(usize, std.math.maxInt(u32))));
    const requested_rows = @max(row_count, 1);
    if (out_cols) |v| v.* = cols;
    if (out_rows) |v| v.* = requested_rows;
    if (out_total_rows) |v| v.* = total_rows_u32;
    if (out_cursor_col) |v| v.* = screen.cursor.x;
    if (out_cursor_row) |v| {
        const active_start = total_rows - @as(usize, vt.term.rows);
        v.* = @intCast(@min(active_start + @as(usize, screen.cursor.y), @as(usize, std.math.maxInt(u32))));
    }

    const out = cells orelse return false;
    const needed = @as(usize, cols) * @as(usize, requested_rows);
    if (cell_count < needed) return false;

    const palette = &vt.term.colors.palette.current;
    const default_fg = vt.term.colors.foreground.get() orelse android_vt_fg;
    const default_bg = vt.term.colors.background.get() orelse android_vt_bg;
    const start = @min(@as(usize, start_line), total_rows);

    for (0..@as(usize, requested_rows)) |row| {
        const screen_y = start + row;
        for (0..@as(usize, cols)) |col| {
            const index = row * @as(usize, cols) + col;
            var codepoint: u32 = 32;
            var fg = default_fg;
            var bg = default_bg;
            var flags: u8 = 0;
            if (screen_y < total_rows) {
                if (screen.pages.getCell(.{ .screen = .{
                    .x = @intCast(col),
                    .y = @intCast(screen_y),
                } })) |page_cell| {
                    const cell = page_cell.cell;
                    const style_value = page_cell.style();
                    if (cell.hasText()) codepoint = cell.codepoint();
                    fg = style_value.fg(.{ .default = default_fg, .palette = palette, .bold = null });
                    bg = style_value.bg(cell, palette) orelse default_bg;
                    flags = androidVtFlags(cell, style_value);
                    if (style_value.flags.inverse) {
                        const tmp = fg;
                        fg = bg;
                        bg = tmp;
                    }
                }
            }
            out[index] = .{
                .codepoint = codepoint,
                .fg_r = fg.r,
                .fg_g = fg.g,
                .fg_b = fg.b,
                .bg_r = bg.r,
                .bg_g = bg.g,
                .bg_b = bg.b,
                .flags = flags,
            };
        }
    }

    return true;
}

`;

const replaceOnce = (file, before, after) => {
  const text = readFileSync(file, "utf8");
  if (text.includes(after)) return;
  if (!text.includes(before)) throw new Error(`Patch target not found in ${file}`);
  writeFileSync(file, text.replace(before, after));
};

const patchAndroidVtHeader = () => {
  const file = join(source, "include/ghostty.h");
  const text = readFileSync(file, "utf8");
  if (text.includes(androidVtApiHeader)) return;
  const blockStart = text.indexOf(`typedef void* ghostty_android_vt_t;\n`);
  const blockEnd = blockStart >= 0 ? text.indexOf(`int ghostty_init(uintptr_t, char**);\n`, blockStart) : -1;
  if (blockStart >= 0 && blockEnd > blockStart) {
    writeFileSync(file, `${text.slice(0, blockStart)}${androidVtHeader}//-------------------------------------------------------------------\n// Published API\n\n${androidVtApiHeader}${text.slice(blockEnd)}`);
    return;
  }
  if (text.includes(androidVtApiHeaderLegacy)) {
    writeFileSync(file, text.replace(androidVtApiHeaderLegacy, androidVtApiHeader));
    return;
  }
  replaceOnce(
    file,
    `//-------------------------------------------------------------------
// Published API

`,
    `${androidVtHeader}//-------------------------------------------------------------------
// Published API

${androidVtApiHeader}`,
  );
};

const patchAndroidVtZig = () => {
  const file = join(source, "src/main_c.zig");
  const text = readFileSync(file, "utf8");
  if (text.includes(androidVtZig)) return;
  const start = text.indexOf(`const terminalpkg = @import("terminal/main.zig");\n`);
  const end = start >= 0 ? text.indexOf(`test "ghostty_string_s empty string" {\n`, start) : -1;
  if (start >= 0 && end > start) {
    writeFileSync(file, `${text.slice(0, start)}${androidVtZig}${text.slice(end)}`);
    return;
  }
  replaceOnce(
    file,
    `test "ghostty_string_s empty string" {
`,
    `${androidVtZig}test "ghostty_string_s empty string" {
`,
  );
};

const patchGhostty = () => {
  replaceOnce(
    join(source, "pkg/libpng/build.zig"),
    `    if (target.result.os.tag == .linux) {
        lib.linkSystemLibrary("m");
    }
`,
    `    if (target.result.os.tag == .linux and target.result.abi != .android) {
        lib.linkSystemLibrary("m");
    }
`,
  );
  replaceOnce(
    join(source, "src/build/GhosttyLib.zig"),
    `    _ = try deps.add(lib);

    // Get our debug symbols
`,
    `    _ = try deps.add(lib);
    if (deps.config.target.result.abi == .android) {
        try @import("android_ndk").addPaths(b, lib);
    }

    // Get our debug symbols
`,
  );
  replaceOnce(
    join(source, "include/ghostty.h"),
    `  GHOSTTY_PLATFORM_MACOS,
  GHOSTTY_PLATFORM_IOS,
} ghostty_platform_e;
`,
    `  GHOSTTY_PLATFORM_MACOS,
  GHOSTTY_PLATFORM_IOS,
  GHOSTTY_PLATFORM_ANDROID,
} ghostty_platform_e;
`,
  );
  replaceOnce(
    join(source, "include/ghostty.h"),
    `typedef struct {
  void* uiview;
} ghostty_platform_ios_s;

typedef union {
  ghostty_platform_macos_s macos;
  ghostty_platform_ios_s ios;
} ghostty_platform_u;
`,
    `typedef struct {
  void* uiview;
} ghostty_platform_ios_s;

typedef struct {
  void* native_window;
} ghostty_platform_android_s;

typedef union {
  ghostty_platform_macos_s macos;
  ghostty_platform_ios_s ios;
  ghostty_platform_android_s android;
} ghostty_platform_u;
`,
  );
  replaceOnce(
    join(source, "src/apprt/embedded.zig"),
    `pub const Platform = union(PlatformTag) {
    macos: MacOS,
    ios: IOS,

    // If our build target for libghostty is not darwin then we do
`,
    `pub const Platform = union(PlatformTag) {
    macos: MacOS,
    ios: IOS,
    android: Android,

    // If our build target for libghostty is not darwin then we do
`,
  );
  replaceOnce(
    join(source, "src/apprt/embedded.zig"),
    `    pub const IOS = if (builtin.target.os.tag.isDarwin()) struct {
        /// The view to render the surface on.
        uiview: objc.Object,
    } else void;

    // The C ABI compatible version of this union. The tag is expected
`,
    `    pub const IOS = if (builtin.target.os.tag.isDarwin()) struct {
        /// The view to render the surface on.
        uiview: objc.Object,
    } else void;

    pub const Android = if (builtin.target.abi == .android) struct {
        native_window: *anyopaque,
    } else void;

    // The C ABI compatible version of this union. The tag is expected
`,
  );
  replaceOnce(
    join(source, "src/apprt/embedded.zig"),
    `        ios: extern struct {
            uiview: ?*anyopaque,
        },
    };
`,
    `        ios: extern struct {
            uiview: ?*anyopaque,
        },

        android: extern struct {
            native_window: ?*anyopaque,
        },
    };
`,
  );
  replaceOnce(
    join(source, "src/apprt/embedded.zig"),
    `            .ios => if (IOS != void) ios: {
                const config = c_platform.ios;
                const uiview = objc.Object.fromId(config.uiview orelse
                    break :ios error.UIViewMustBeSet);
                break :ios .{ .ios = .{ .uiview = uiview } };
            } else error.UnsupportedPlatform,
        };
    }
};
`,
    `            .ios => if (IOS != void) ios: {
                const config = c_platform.ios;
                const uiview = objc.Object.fromId(config.uiview orelse
                    break :ios error.UIViewMustBeSet);
                break :ios .{ .ios = .{ .uiview = uiview } };
            } else error.UnsupportedPlatform,

            .android => if (Android != void) android: {
                const config = c_platform.android;
                const native_window = config.native_window orelse
                    break :android error.NativeWindowMustBeSet;
                break :android .{ .android = .{ .native_window = native_window } };
            } else error.UnsupportedPlatform,
        };
    }
};
`,
  );
  replaceOnce(
    join(source, "src/apprt/embedded.zig"),
    `    macos = 1,
    ios = 2,
};
`,
    `    macos = 1,
    ios = 2,
    android = 3,
};
`,
  );
  patchAndroidVtHeader();
  patchAndroidVtZig();
};

if (!existsSync(source)) throw new Error(`Ghostty source is missing at ${source}`);
if (!existsSync(zig)) throw new Error(`Zig 0.15.2 is missing at ${zig}; set PROSPERO_ZIG to override`);

const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).stdout.trim();
if (head !== revision) throw new Error(`Ghostty revision mismatch: expected ${revision}, got ${head}`);
patchGhostty();

run(zig, ["version"]);
const shims = toolShims();
const ndk = androidNdk();
const ndkSysroot = join(ndk, "toolchains/llvm/prebuilt/darwin-x86_64/sysroot");
const ndkIncludes = [
  join(ndkSysroot, "usr/include"),
  join(ndkSysroot, "usr/include", ndkTriple),
];
const ndkCppIncludes = [
  ...ndkIncludes,
];
const ndkLib = join(ndkSysroot, "usr/lib", ndkTriple, target.split(".").at(-1) || "24");
try {
  run(zig, [
    "build",
    `-Dtarget=${target}`,
    "-Doptimize=ReleaseFast",
    "-Dapp-runtime=none",
    "-Dfont-backend=freetype",
    "-Demit-docs=false",
    "-Demit-themes=false",
    "-Demit-webdata=false",
    "-Demit-bench=false",
    "-Demit-helpgen=false",
    "-Demit-exe=false",
    "-Dstrip=true",
  ], {
    cwd: source,
    env: {
      ...process.env,
      ANDROID_HOME: androidHome,
      ANDROID_SDK_ROOT: androidHome,
      ANDROID_NDK_HOME: ndk,
      CPATH: appendPath(process.env.CPATH, ndkIncludes.join(delimiter)),
      CPLUS_INCLUDE_PATH: appendPath(process.env.CPLUS_INCLUDE_PATH, ndkCppIncludes.join(delimiter)),
      LIBRARY_PATH: appendPath(process.env.LIBRARY_PATH, ndkLib),
      PATH: shims ? `${shims}${delimiter}${process.env.PATH}` : process.env.PATH,
    },
  });
} finally {
  if (shims) rmSync(shims, { recursive: true, force: true });
}

const lib = resolve(source, "zig-out/lib/libghostty.so");
if (!existsSync(lib)) throw new Error(`Ghostty build did not produce ${lib}`);

mkdirSync(out, { recursive: true });
mkdirSync(include, { recursive: true });
cpSync(lib, resolve(out, "libghostty.so"));
cpSync(resolve(source, "include/ghostty.h"), resolve(include, "ghostty.h"));
console.log(`Android libghostty staged at ${out}`);
