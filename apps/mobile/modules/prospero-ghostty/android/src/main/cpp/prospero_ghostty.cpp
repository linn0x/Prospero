#include <jni.h>
#include <algorithm>
#include <android/bitmap.h>
#include <android/native_window.h>
#include <android/native_window_jni.h>
#include <EGL/egl.h>
#include <GLES3/gl3.h>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

#include "ghostty.h"

namespace {
struct Color {
  float r;
  float g;
  float b;
  float a;
};

struct Cell {
  uint32_t ch;
  Color fg;
  Color bg;
  bool bold;
  bool underline;
  bool inverse;
};

struct SelectionPoint {
  int col;
  int line;
};

std::mutex g_mutex;
EGLDisplay g_display = EGL_NO_DISPLAY;
EGLContext g_context = EGL_NO_CONTEXT;
EGLSurface g_surface = EGL_NO_SURFACE;
ANativeWindow* g_window = nullptr;
GLuint g_program = 0;
GLuint g_vbo = 0;
GLuint g_atlas = 0;
GLint g_screen_loc = -1;
int g_surface_width = 0;
int g_surface_height = 0;
int g_cols = 80;
int g_rows = 24;
int g_cursor_col = 0;
int g_cursor_row = 0;
int g_saved_cursor_col = 0;
int g_saved_cursor_row = 0;
int g_atlas_width = 0;
int g_atlas_height = 0;
int g_atlas_cols = 0;
int g_atlas_first = 32;
int g_cell_width = 8;
int g_cell_height = 16;
int g_viewport_offset = 0;
int g_max_scrollback = 2000;
int g_total_lines = 24;
int g_view_start_line = 0;
int g_cursor_abs_line = 0;
bool g_has_selection = false;
ghostty_android_vt_t g_vt = nullptr;
SelectionPoint g_selection_start{0, 0};
SelectionPoint g_selection_end{0, 0};
Color g_default_fg{0.88f, 0.90f, 0.86f, 1.0f};
Color g_default_bg{0.035f, 0.035f, 0.043f, 1.0f};
Color g_current_fg = g_default_fg;
Color g_current_bg = g_default_bg;
bool g_current_bold = false;
bool g_current_underline = false;
bool g_current_inverse = false;
std::vector<Cell> g_grid;
std::vector<std::vector<Cell>> g_scrollback;
std::vector<ghostty_android_vt_cell_s> g_snapshot;

Cell blankCell() {
  return Cell{32, g_default_fg, g_default_bg, false, false, false};
}

Cell currentCell(uint32_t ch) {
  return Cell{ch, g_current_fg, g_current_bg, g_current_bold, g_current_underline, g_current_inverse};
}

std::string ghosttyVersion() {
  const ghostty_info_s info = ghostty_info();
  if (info.version == nullptr || info.version_len == 0) return "ghostty";
  return std::string(info.version, info.version + info.version_len);
}

void clampViewport() {
  g_viewport_offset = std::max(0, std::min(g_viewport_offset, std::max(0, g_total_lines - g_rows)));
}

Color ghosttyColor(uint8_t r, uint8_t g, uint8_t b) {
  return Color{
    static_cast<float>(r) / 255.0f,
    static_cast<float>(g) / 255.0f,
    static_cast<float>(b) / 255.0f,
    1.0f
  };
}

Cell ghosttyCell(const ghostty_android_vt_cell_s& cell) {
  return Cell{
    cell.codepoint == 0 ? 32 : cell.codepoint,
    ghosttyColor(cell.fg_r, cell.fg_g, cell.fg_b),
    ghosttyColor(cell.bg_r, cell.bg_g, cell.bg_b),
    (cell.flags & 1) != 0,
    (cell.flags & 4) != 0,
    false
  };
}

void resetStyle() {
  g_current_fg = g_default_fg;
  g_current_bg = g_default_bg;
  g_current_bold = false;
  g_current_underline = false;
  g_current_inverse = false;
}

void resetGrid(int cols, int rows) {
  std::vector<Cell> old = g_grid;
  const int old_cols = g_cols;
  const int old_rows = g_rows;
  g_cols = std::max(1, cols);
  g_rows = std::max(1, rows);
  g_cursor_col = std::min(g_cols - 1, std::max(0, g_cursor_col));
  g_cursor_row = std::min(g_rows - 1, std::max(0, g_cursor_row));
  g_grid.assign(static_cast<size_t>(g_cols * g_rows), blankCell());
  const int copy_rows = std::min(old_rows, g_rows);
  const int copy_cols = std::min(old_cols, g_cols);
  for (int row = 0; row < copy_rows; row++) {
    for (int col = 0; col < copy_cols; col++) {
      g_grid[static_cast<size_t>(row * g_cols + col)] = old[static_cast<size_t>(row * old_cols + col)];
    }
  }
  clampViewport();
}

int bottomStartLine() {
  return std::max(0, g_total_lines - g_rows - g_viewport_offset);
}

bool ensureGhosttyVt() {
  if (g_vt != nullptr) return true;
  g_vt = ghostty_android_vt_new(static_cast<uint32_t>(std::max(1, g_cols)), static_cast<uint32_t>(std::max(1, g_rows)));
  return g_vt != nullptr;
}

void resetGhosttyVt(int cols, int rows) {
  if (g_vt != nullptr) {
    ghostty_android_vt_free(g_vt);
    g_vt = nullptr;
  }
  g_scrollback.clear();
  g_viewport_offset = 0;
  g_has_selection = false;
  resetGrid(cols, rows);
  g_total_lines = g_rows;
  g_view_start_line = 0;
  g_cursor_abs_line = 0;
  ensureGhosttyVt();
}

bool syncFromGhostty() {
  if (!ensureGhosttyVt()) return false;
  g_snapshot.resize(static_cast<size_t>(g_cols * g_rows));
  uint32_t cols = 0;
  uint32_t rows = 0;
  uint32_t total_rows = 0;
  uint32_t cursor_col = 0;
  uint32_t cursor_row = 0;
  int start_line = bottomStartLine();
  if (!ghostty_android_vt_snapshot_range(g_vt, g_snapshot.data(), g_snapshot.size(), static_cast<uint32_t>(start_line), static_cast<uint32_t>(g_rows), &cols, &rows, &total_rows, &cursor_col, &cursor_row)) return false;
  if (cols == 0 || rows == 0) return false;
  g_total_lines = std::max(static_cast<int>(rows), static_cast<int>(total_rows));
  clampViewport();
  const int resolved_start = bottomStartLine();
  if (static_cast<int>(cols) != g_cols || static_cast<int>(rows) != g_rows) {
    resetGrid(static_cast<int>(cols), static_cast<int>(rows));
    g_snapshot.resize(static_cast<size_t>(g_cols * g_rows));
    if (!ghostty_android_vt_snapshot_range(g_vt, g_snapshot.data(), g_snapshot.size(), static_cast<uint32_t>(resolved_start), static_cast<uint32_t>(g_rows), &cols, &rows, &total_rows, &cursor_col, &cursor_row)) return false;
  } else if (resolved_start != start_line) {
    if (!ghostty_android_vt_snapshot_range(g_vt, g_snapshot.data(), g_snapshot.size(), static_cast<uint32_t>(resolved_start), static_cast<uint32_t>(g_rows), &cols, &rows, &total_rows, &cursor_col, &cursor_row)) return false;
  }
  g_total_lines = std::max(static_cast<int>(rows), static_cast<int>(total_rows));
  g_view_start_line = resolved_start;
  g_grid.assign(static_cast<size_t>(g_cols * g_rows), blankCell());
  for (size_t i = 0; i < g_snapshot.size() && i < g_grid.size(); i++) {
    g_grid[i] = ghosttyCell(g_snapshot[i]);
  }
  g_cursor_col = std::min(g_cols - 1, std::max(0, static_cast<int>(cursor_col)));
  g_cursor_abs_line = std::min(g_total_lines - 1, std::max(0, static_cast<int>(cursor_row)));
  g_cursor_row = std::min(g_rows - 1, std::max(0, g_cursor_abs_line - g_view_start_line));
  clampViewport();
  return true;
}

void clearGrid() {
  std::fill(g_grid.begin(), g_grid.end(), blankCell());
  g_cursor_col = 0;
  g_cursor_row = 0;
  g_viewport_offset = 0;
  g_has_selection = false;
}

void appendScrollbackLine(const Cell* line) {
  g_scrollback.emplace_back(line, line + g_cols);
  if (static_cast<int>(g_scrollback.size()) > g_max_scrollback) {
    g_scrollback.erase(g_scrollback.begin(), g_scrollback.begin() + (static_cast<int>(g_scrollback.size()) - g_max_scrollback));
  }
}

void scrollGrid() {
  if (g_rows <= 1) {
    clearGrid();
    return;
  }
  appendScrollbackLine(g_grid.data());
  std::memmove(g_grid.data(), g_grid.data() + g_cols, static_cast<size_t>((g_rows - 1) * g_cols) * sizeof(Cell));
  std::fill(g_grid.begin() + static_cast<size_t>((g_rows - 1) * g_cols), g_grid.end(), blankCell());
  g_cursor_row = g_rows - 1;
  clampViewport();
}

void newline() {
  g_cursor_col = 0;
  g_cursor_row++;
  if (g_cursor_row >= g_rows) scrollGrid();
}

void putChar(uint32_t value) {
  if (value < 32) return;
  if (g_cursor_col >= g_cols) newline();
  g_grid[static_cast<size_t>(g_cursor_row * g_cols + g_cursor_col)] = currentCell(value);
  g_cursor_col++;
  if (g_cursor_col >= g_cols) newline();
  g_viewport_offset = 0;
}

std::vector<int> parseCsiParams(const std::string& value) {
  std::vector<int> result;
  int current = 0;
  bool has_digit = false;
  for (char ch : value) {
    if (ch >= '0' && ch <= '9') {
      current = current * 10 + ch - '0';
      has_digit = true;
    } else if (ch == ';') {
      result.push_back(has_digit ? current : 0);
      current = 0;
      has_digit = false;
    }
  }
  result.push_back(has_digit ? current : 0);
  return result;
}

Color ansiColor(int code) {
  switch (code) {
    case 0: return Color{0.00f, 0.00f, 0.00f, 1.0f};
    case 1: return Color{0.78f, 0.22f, 0.22f, 1.0f};
    case 2: return Color{0.47f, 0.68f, 0.34f, 1.0f};
    case 3: return Color{0.78f, 0.65f, 0.32f, 1.0f};
    case 4: return Color{0.32f, 0.52f, 0.78f, 1.0f};
    case 5: return Color{0.66f, 0.42f, 0.78f, 1.0f};
    case 6: return Color{0.34f, 0.66f, 0.70f, 1.0f};
    case 7: return Color{0.82f, 0.84f, 0.82f, 1.0f};
    case 8: return Color{0.34f, 0.35f, 0.36f, 1.0f};
    case 9: return Color{0.95f, 0.36f, 0.36f, 1.0f};
    case 10: return Color{0.59f, 0.83f, 0.42f, 1.0f};
    case 11: return Color{0.95f, 0.80f, 0.42f, 1.0f};
    case 12: return Color{0.46f, 0.66f, 0.95f, 1.0f};
    case 13: return Color{0.82f, 0.52f, 0.95f, 1.0f};
    case 14: return Color{0.47f, 0.82f, 0.86f, 1.0f};
    default: return Color{0.96f, 0.96f, 0.94f, 1.0f};
  }
}

void applySgr(const std::vector<int>& parsed) {
  if (parsed.empty()) {
    resetStyle();
    return;
  }
  for (size_t i = 0; i < parsed.size(); i++) {
    const int code = parsed[i];
    if (code == 0) resetStyle();
    else if (code == 1) g_current_bold = true;
    else if (code == 4) g_current_underline = true;
    else if (code == 7) g_current_inverse = true;
    else if (code == 22) g_current_bold = false;
    else if (code == 24) g_current_underline = false;
    else if (code == 27) g_current_inverse = false;
    else if (code == 39) g_current_fg = g_default_fg;
    else if (code == 49) g_current_bg = g_default_bg;
    else if (code >= 30 && code <= 37) g_current_fg = ansiColor(code - 30);
    else if (code >= 40 && code <= 47) g_current_bg = ansiColor(code - 40);
    else if (code >= 90 && code <= 97) g_current_fg = ansiColor(code - 90 + 8);
    else if (code >= 100 && code <= 107) g_current_bg = ansiColor(code - 100 + 8);
    else if ((code == 38 || code == 48) && i + 2 < parsed.size() && parsed[i + 1] == 5) {
      const int color = std::max(0, std::min(15, parsed[i + 2]));
      if (code == 38) g_current_fg = ansiColor(color);
      else g_current_bg = ansiColor(color);
      i += 2;
    }
  }
}

void clearLineRange(int row, int start, int end) {
  if (row < 0 || row >= g_rows) return;
  start = std::max(0, std::min(g_cols, start));
  end = std::max(start, std::min(g_cols, end));
  std::fill(
    g_grid.begin() + static_cast<size_t>(row * g_cols + start),
    g_grid.begin() + static_cast<size_t>(row * g_cols + end),
    blankCell()
  );
}

void applyCsi(const std::string& params, char command) {
  const std::vector<int> parsed = parseCsiParams(params);
  const int first = parsed.empty() ? 0 : parsed[0];
  switch (command) {
    case 'A':
      g_cursor_row = std::max(0, g_cursor_row - std::max(1, first));
      break;
    case 'B':
      g_cursor_row = std::min(g_rows - 1, g_cursor_row + std::max(1, first));
      break;
    case 'C':
      g_cursor_col = std::min(g_cols - 1, g_cursor_col + std::max(1, first));
      break;
    case 'D':
      g_cursor_col = std::max(0, g_cursor_col - std::max(1, first));
      break;
    case 'G':
      g_cursor_col = std::min(g_cols - 1, std::max(0, first - 1));
      break;
    case 'H':
    case 'f': {
      const int row = parsed.size() > 0 && parsed[0] > 0 ? parsed[0] : 1;
      const int col = parsed.size() > 1 && parsed[1] > 0 ? parsed[1] : 1;
      g_cursor_row = std::min(g_rows - 1, std::max(0, row - 1));
      g_cursor_col = std::min(g_cols - 1, std::max(0, col - 1));
      break;
    }
    case 'J':
      if (first == 2 || first == 3) clearGrid();
      else if (first == 0) {
        clearLineRange(g_cursor_row, g_cursor_col, g_cols);
        for (int row = g_cursor_row + 1; row < g_rows; row++) clearLineRange(row, 0, g_cols);
      } else if (first == 1) {
        for (int row = 0; row < g_cursor_row; row++) clearLineRange(row, 0, g_cols);
        clearLineRange(g_cursor_row, 0, g_cursor_col + 1);
      }
      break;
    case 'K':
      if (first == 0) clearLineRange(g_cursor_row, g_cursor_col, g_cols);
      else if (first == 1) clearLineRange(g_cursor_row, 0, g_cursor_col + 1);
      else if (first == 2) clearLineRange(g_cursor_row, 0, g_cols);
      break;
    case 'm':
      applySgr(parsed);
      break;
    case 's':
      g_saved_cursor_col = g_cursor_col;
      g_saved_cursor_row = g_cursor_row;
      break;
    case 'u':
      g_cursor_col = std::min(g_cols - 1, std::max(0, g_saved_cursor_col));
      g_cursor_row = std::min(g_rows - 1, std::max(0, g_saved_cursor_row));
      break;
  }
}

uint32_t readUtf8(const unsigned char* data, size_t len, size_t* index) {
  const unsigned char ch = data[*index];
  if (ch < 0x80) return ch;
  int count = 0;
  uint32_t value = 0;
  if ((ch & 0xe0) == 0xc0) {
    count = 1;
    value = ch & 0x1f;
  } else if ((ch & 0xf0) == 0xe0) {
    count = 2;
    value = ch & 0x0f;
  } else if ((ch & 0xf8) == 0xf0) {
    count = 3;
    value = ch & 0x07;
  } else {
    return '?';
  }
  if (*index + static_cast<size_t>(count) >= len) return '?';
  for (int i = 1; i <= count; i++) {
    const unsigned char next = data[*index + static_cast<size_t>(i)];
    if ((next & 0xc0) != 0x80) return '?';
    value = (value << 6) | (next & 0x3f);
  }
  *index += static_cast<size_t>(count);
  if (value < 32 || value > 126) return '?';
  return value;
}

void feedTerminal(const char* raw, size_t len, bool reset) {
  if (reset) {
    g_scrollback.clear();
    resetStyle();
    clearGrid();
  }
  enum class State { Normal, Escape, Csi };
  State state = State::Normal;
  std::string csi;
  const unsigned char* data = reinterpret_cast<const unsigned char*>(raw);
  for (size_t i = 0; i < len; i++) {
    const unsigned char ch = data[i];
    if (state == State::Escape) {
      if (ch == '[') {
        csi.clear();
        state = State::Csi;
      } else if (ch == 'c') {
        resetStyle();
        clearGrid();
        state = State::Normal;
      } else {
        state = State::Normal;
      }
      continue;
    }
    if (state == State::Csi) {
      if ((ch >= '0' && ch <= '9') || ch == ';' || ch == '?' || ch == ':' || ch == ' ') {
        if (ch != '?' && ch != ':' && ch != ' ') csi.push_back(static_cast<char>(ch));
      } else {
        applyCsi(csi, static_cast<char>(ch));
        state = State::Normal;
      }
      continue;
    }
    if (ch == 0x1b) state = State::Escape;
    else if (ch == '\r') g_cursor_col = 0;
    else if (ch == '\n') newline();
    else if (ch == '\b') g_cursor_col = std::max(0, g_cursor_col - 1);
    else if (ch == '\t') g_cursor_col = std::min(g_cols - 1, ((g_cursor_col / 4) + 1) * 4);
    else putChar(readUtf8(data, len, &i));
  }
}

GLuint compileShader(GLenum type, const char* source) {
  GLuint shader = glCreateShader(type);
  glShaderSource(shader, 1, &source, nullptr);
  glCompileShader(shader);
  GLint ok = GL_FALSE;
  glGetShaderiv(shader, GL_COMPILE_STATUS, &ok);
  if (ok != GL_TRUE) {
    glDeleteShader(shader);
    return 0;
  }
  return shader;
}

bool initProgram() {
  if (g_program != 0) return true;
  const char* vertex = "#version 300 es\n"
    "layout(location=0) in vec2 aPos;\n"
    "layout(location=1) in vec2 aUv;\n"
    "layout(location=2) in vec4 aColor;\n"
    "layout(location=3) in float aMode;\n"
    "uniform vec2 uScreen;\n"
    "out vec2 vUv;\n"
    "out vec4 vColor;\n"
    "out float vMode;\n"
    "void main(){vec2 p=(aPos/uScreen)*2.0-1.0;gl_Position=vec4(p.x,-p.y,0.0,1.0);vUv=aUv;vColor=aColor;vMode=aMode;}";
  const char* fragment = "#version 300 es\n"
    "precision mediump float;\n"
    "in vec2 vUv;\n"
    "in vec4 vColor;\n"
    "in float vMode;\n"
    "uniform sampler2D uAtlas;\n"
    "out vec4 color;\n"
    "void main(){if(vMode<0.5){color=vColor;}else{float a=texture(uAtlas,vUv).a;color=vec4(vColor.rgb,vColor.a*a);}}";
  GLuint vs = compileShader(GL_VERTEX_SHADER, vertex);
  GLuint fs = compileShader(GL_FRAGMENT_SHADER, fragment);
  if (vs == 0 || fs == 0) {
    if (vs != 0) glDeleteShader(vs);
    if (fs != 0) glDeleteShader(fs);
    return false;
  }
  g_program = glCreateProgram();
  glAttachShader(g_program, vs);
  glAttachShader(g_program, fs);
  glLinkProgram(g_program);
  glDeleteShader(vs);
  glDeleteShader(fs);
  GLint ok = GL_FALSE;
  glGetProgramiv(g_program, GL_LINK_STATUS, &ok);
  if (ok != GL_TRUE) {
    glDeleteProgram(g_program);
    g_program = 0;
    return false;
  }
  glGenBuffers(1, &g_vbo);
  g_screen_loc = glGetUniformLocation(g_program, "uScreen");
  return true;
}

int totalLineCount() {
  return std::max(g_rows, g_total_lines);
}

int firstVisibleLine() {
  return g_view_start_line;
}

const Cell* lineAt(int absolute_line) {
  const int row = absolute_line - g_view_start_line;
  if (row < 0 || row >= g_rows) return nullptr;
  return g_grid.data() + static_cast<size_t>(row * g_cols);
}

bool snapshotLines(int start_line, int row_count, std::vector<Cell>& cells) {
  if (row_count <= 0 || !ensureGhosttyVt()) return false;
  std::vector<ghostty_android_vt_cell_s> raw(static_cast<size_t>(g_cols * row_count));
  uint32_t cols = 0;
  uint32_t rows = 0;
  uint32_t total_rows = 0;
  uint32_t cursor_col = 0;
  uint32_t cursor_row = 0;
  if (!ghostty_android_vt_snapshot_range(g_vt, raw.data(), raw.size(), static_cast<uint32_t>(std::max(0, start_line)), static_cast<uint32_t>(row_count), &cols, &rows, &total_rows, &cursor_col, &cursor_row)) return false;
  if (static_cast<int>(cols) != g_cols || static_cast<int>(rows) != row_count) return false;
  g_total_lines = std::max(static_cast<int>(rows), static_cast<int>(total_rows));
  g_cursor_abs_line = std::min(g_total_lines - 1, std::max(0, static_cast<int>(cursor_row)));
  g_cursor_col = std::min(g_cols - 1, std::max(0, static_cast<int>(cursor_col)));
  cells.assign(static_cast<size_t>(g_cols * row_count), blankCell());
  for (size_t i = 0; i < raw.size() && i < cells.size(); i++) {
    cells[i] = ghosttyCell(raw[i]);
  }
  return true;
}

bool colorVisible(Color color) {
  return color.a > 0.01f && (std::fabs(color.r - g_default_bg.r) > 0.01f || std::fabs(color.g - g_default_bg.g) > 0.01f || std::fabs(color.b - g_default_bg.b) > 0.01f);
}

void appendVertex(std::vector<float>& vertices, float x, float y, float u, float v, Color color, float mode) {
  vertices.push_back(x);
  vertices.push_back(y);
  vertices.push_back(u);
  vertices.push_back(v);
  vertices.push_back(color.r);
  vertices.push_back(color.g);
  vertices.push_back(color.b);
  vertices.push_back(color.a);
  vertices.push_back(mode);
}

void appendQuad(std::vector<float>& vertices, float x0, float y0, float x1, float y1, float u0, float v0, float u1, float v1, Color color, float mode) {
  appendVertex(vertices, x0, y0, u0, v0, color, mode);
  appendVertex(vertices, x1, y0, u1, v0, color, mode);
  appendVertex(vertices, x0, y1, u0, v1, color, mode);
  appendVertex(vertices, x1, y0, u1, v0, color, mode);
  appendVertex(vertices, x1, y1, u1, v1, color, mode);
  appendVertex(vertices, x0, y1, u0, v1, color, mode);
}

SelectionPoint normalizedStart() {
  if (g_selection_start.line < g_selection_end.line) return g_selection_start;
  if (g_selection_start.line > g_selection_end.line) return g_selection_end;
  return g_selection_start.col <= g_selection_end.col ? g_selection_start : g_selection_end;
}

SelectionPoint normalizedEnd() {
  if (g_selection_start.line < g_selection_end.line) return g_selection_end;
  if (g_selection_start.line > g_selection_end.line) return g_selection_start;
  return g_selection_start.col <= g_selection_end.col ? g_selection_end : g_selection_start;
}

bool isSelected(int absolute_line, int col) {
  if (!g_has_selection) return false;
  const SelectionPoint start = normalizedStart();
  const SelectionPoint end = normalizedEnd();
  if (absolute_line < start.line || absolute_line > end.line) return false;
  if (start.line == end.line) return col >= start.col && col <= end.col;
  if (absolute_line == start.line) return col >= start.col;
  if (absolute_line == end.line) return col <= end.col;
  return true;
}

void renderGrid() {
  if (g_display == EGL_NO_DISPLAY || g_surface == EGL_NO_SURFACE || g_context == EGL_NO_CONTEXT) return;
  if (eglMakeCurrent(g_display, g_surface, g_surface, g_context) != EGL_TRUE) return;
  if (!initProgram()) return;
  glViewport(0, 0, g_surface_width, g_surface_height);
  glClearColor(g_default_bg.r, g_default_bg.g, g_default_bg.b, 1.0f);
  glClear(GL_COLOR_BUFFER_BIT);
  if (g_atlas == 0 || g_atlas_width <= 0 || g_atlas_height <= 0 || g_atlas_cols <= 0) {
    eglSwapBuffers(g_display, g_surface);
    return;
  }
  std::vector<float> vertices;
  vertices.reserve(static_cast<size_t>(g_cols * g_rows * 108));
  const int start_line = firstVisibleLine();
  const Color selection_bg{0.24f, 0.42f, 0.72f, 1.0f};
  const Color cursor_bg{0.82f, 0.84f, 0.78f, 1.0f};
  for (int row = 0; row < g_rows; row++) {
    const int absolute_line = start_line + row;
    const Cell* line = lineAt(absolute_line);
    if (line == nullptr) continue;
    for (int col = 0; col < g_cols; col++) {
      Cell cell = line[col];
      Color fg = cell.inverse ? cell.bg : cell.fg;
      Color bg = cell.inverse ? cell.fg : cell.bg;
      const bool cursor = g_viewport_offset == 0 && absolute_line == g_cursor_abs_line && col == g_cursor_col;
      const bool selected = isSelected(absolute_line, col);
      if (selected) {
        bg = selection_bg;
        fg = g_default_fg;
      } else if (cursor) {
        bg = cursor_bg;
        fg = g_default_bg;
      }
      const float x0 = static_cast<float>(col * g_cell_width);
      const float y0 = static_cast<float>(row * g_cell_height);
      const float x1 = x0 + static_cast<float>(g_cell_width);
      const float y1 = y0 + static_cast<float>(g_cell_height);
      if (colorVisible(bg) || selected || cursor) appendQuad(vertices, x0, y0, x1, y1, 0.0f, 0.0f, 0.0f, 0.0f, bg, 0.0f);
      uint32_t ch = cell.ch;
      if (ch < static_cast<uint32_t>(g_atlas_first) || ch >= static_cast<uint32_t>(g_atlas_first + 95)) continue;
      const int index = static_cast<int>(ch) - g_atlas_first;
      const int atlas_col = index % g_atlas_cols;
      const int atlas_row = index / g_atlas_cols;
      const float u0 = static_cast<float>(atlas_col * g_cell_width) / static_cast<float>(g_atlas_width);
      const float v0 = static_cast<float>(atlas_row * g_cell_height) / static_cast<float>(g_atlas_height);
      const float u1 = static_cast<float>((atlas_col + 1) * g_cell_width) / static_cast<float>(g_atlas_width);
      const float v1 = static_cast<float>((atlas_row + 1) * g_cell_height) / static_cast<float>(g_atlas_height);
      appendQuad(vertices, x0, y0, x1, y1, u0, v0, u1, v1, fg, 1.0f);
      if (cell.bold) appendQuad(vertices, x0 + 1.0f, y0, x1 + 1.0f, y1, u0, v0, u1, v1, fg, 1.0f);
      if (cell.underline) appendQuad(vertices, x0, y1 - 2.0f, x1, y1 - 1.0f, 0.0f, 0.0f, 0.0f, 0.0f, fg, 0.0f);
    }
  }
  glEnable(GL_BLEND);
  glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
  glUseProgram(g_program);
  glUniform2f(g_screen_loc, static_cast<float>(std::max(1, g_surface_width)), static_cast<float>(std::max(1, g_surface_height)));
  glActiveTexture(GL_TEXTURE0);
  glBindTexture(GL_TEXTURE_2D, g_atlas);
  glBindBuffer(GL_ARRAY_BUFFER, g_vbo);
  glBufferData(GL_ARRAY_BUFFER, static_cast<GLsizeiptr>(vertices.size() * sizeof(float)), vertices.data(), GL_DYNAMIC_DRAW);
  glEnableVertexAttribArray(0);
  glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 9 * sizeof(float), reinterpret_cast<void*>(0));
  glEnableVertexAttribArray(1);
  glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, 9 * sizeof(float), reinterpret_cast<void*>(2 * sizeof(float)));
  glEnableVertexAttribArray(2);
  glVertexAttribPointer(2, 4, GL_FLOAT, GL_FALSE, 9 * sizeof(float), reinterpret_cast<void*>(4 * sizeof(float)));
  glEnableVertexAttribArray(3);
  glVertexAttribPointer(3, 1, GL_FLOAT, GL_FALSE, 9 * sizeof(float), reinterpret_cast<void*>(8 * sizeof(float)));
  glDrawArrays(GL_TRIANGLES, 0, static_cast<GLsizei>(vertices.size() / 9));
  eglSwapBuffers(g_display, g_surface);
}

void clearEgl() {
  if (g_display != EGL_NO_DISPLAY) {
    if (g_atlas != 0) glDeleteTextures(1, &g_atlas);
    if (g_vbo != 0) glDeleteBuffers(1, &g_vbo);
    if (g_program != 0) glDeleteProgram(g_program);
    eglMakeCurrent(g_display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
    if (g_surface != EGL_NO_SURFACE) eglDestroySurface(g_display, g_surface);
    if (g_context != EGL_NO_CONTEXT) eglDestroyContext(g_display, g_context);
    eglTerminate(g_display);
  }
  if (g_window != nullptr) ANativeWindow_release(g_window);
  g_display = EGL_NO_DISPLAY;
  g_context = EGL_NO_CONTEXT;
  g_surface = EGL_NO_SURFACE;
  g_window = nullptr;
  g_atlas = 0;
  g_vbo = 0;
  g_program = 0;
  g_screen_loc = -1;
}

const char* initEgl(ANativeWindow* window) {
  const EGLint config_attribs[] = {
    EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,
    EGL_SURFACE_TYPE, EGL_WINDOW_BIT,
    EGL_RED_SIZE, 8,
    EGL_GREEN_SIZE, 8,
    EGL_BLUE_SIZE, 8,
    EGL_ALPHA_SIZE, 8,
    EGL_DEPTH_SIZE, 0,
    EGL_STENCIL_SIZE, 0,
    EGL_NONE,
  };
  const EGLint context_attribs[] = {
    EGL_CONTEXT_CLIENT_VERSION, 3,
    EGL_NONE,
  };
  EGLDisplay display = eglGetDisplay(EGL_DEFAULT_DISPLAY);
  if (display == EGL_NO_DISPLAY) return "eglGetDisplay failed";
  if (eglInitialize(display, nullptr, nullptr) != EGL_TRUE) return "eglInitialize failed";
  EGLConfig config = nullptr;
  EGLint config_count = 0;
  if (eglChooseConfig(display, config_attribs, &config, 1, &config_count) != EGL_TRUE || config_count <= 0) {
    eglTerminate(display);
    return "eglChooseConfig failed";
  }
  EGLSurface surface = eglCreateWindowSurface(display, config, window, nullptr);
  if (surface == EGL_NO_SURFACE) {
    eglTerminate(display);
    return "eglCreateWindowSurface failed";
  }
  EGLContext context = eglCreateContext(display, config, EGL_NO_CONTEXT, context_attribs);
  if (context == EGL_NO_CONTEXT) {
    eglDestroySurface(display, surface);
    eglTerminate(display);
    return "eglCreateContext failed";
  }
  if (eglMakeCurrent(display, surface, surface, context) != EGL_TRUE) {
    eglDestroyContext(display, context);
    eglDestroySurface(display, surface);
    eglTerminate(display);
    return "eglMakeCurrent failed";
  }
  EGLint width = 0;
  EGLint height = 0;
  eglQuerySurface(display, surface, EGL_WIDTH, &width);
  eglQuerySurface(display, surface, EGL_HEIGHT, &height);
  g_surface_width = std::max(1, width);
  g_surface_height = std::max(1, height);
  g_display = display;
  g_context = context;
  g_surface = surface;
  g_window = window;
  renderGrid();
  return nullptr;
}

SelectionPoint visiblePoint(int col, int row) {
  return SelectionPoint{
    std::max(0, std::min(g_cols - 1, col)),
    firstVisibleLine() + std::max(0, std::min(g_rows - 1, row)),
  };
}

std::string lineText(const Cell* line, int start_col, int end_col) {
  std::string text;
  int end = std::max(start_col, std::min(g_cols - 1, end_col));
  while (end >= start_col && line[end].ch == 32) end--;
  for (int col = start_col; col <= end; col++) {
    const uint32_t ch = line[col].ch;
    text.push_back(static_cast<char>(ch >= 32 && ch < 127 ? ch : '?'));
  }
  return text;
}

std::string readSelectionText(bool all) {
  std::string text;
  SelectionPoint start{0, 0};
  SelectionPoint end{g_cols - 1, totalLineCount() - 1};
  if (!all) {
    if (!g_has_selection) return "";
    start = normalizedStart();
    end = normalizedEnd();
  }
  const int row_count = std::max(0, end.line - start.line + 1);
  std::vector<Cell> range;
  if (!snapshotLines(start.line, row_count, range)) return "";
  for (int line_index = start.line; line_index <= end.line; line_index++) {
    const int row = line_index - start.line;
    const Cell* line = range.data() + static_cast<size_t>(row * g_cols);
    const int start_col = line_index == start.line ? start.col : 0;
    const int end_col = line_index == end.line ? end.col : g_cols - 1;
    if (!text.empty()) text.push_back('\n');
    text += lineText(line, start_col, end_col);
  }
  return text;
}

jbyteArray byteArray(JNIEnv* env, const char* data, size_t len) {
  jbyteArray result = env->NewByteArray(static_cast<jsize>(len));
  if (result == nullptr) return nullptr;
  if (len > 0) env->SetByteArrayRegion(result, 0, static_cast<jsize>(len), reinterpret_cast<const jbyte*>(data));
  return result;
}

std::vector<char> readBytes(JNIEnv* env, jbyteArray data) {
  if (data == nullptr) return {};
  const jsize len = env->GetArrayLength(data);
  std::vector<char> bytes(static_cast<size_t>(len));
  if (len > 0) env->GetByteArrayRegion(data, 0, len, reinterpret_cast<jbyte*>(bytes.data()));
  return bytes;
}

jbyteArray emptyBytes(JNIEnv* env) {
  return byteArray(env, "", 0);
}

jbyteArray encodeTextBytes(JNIEnv* env, const std::vector<char>& data) {
  if (!ensureGhosttyVt()) return emptyBytes(env);
  const size_t cap = std::max<size_t>(64, data.size() * 4 + 64);
  std::vector<char> out(cap);
  uintptr_t written = 0;
  if (!ghostty_android_vt_encode_text(g_vt, data.data(), data.size(), out.data(), out.size(), &written)) return emptyBytes(env);
  return byteArray(env, out.data(), std::min<size_t>(written, out.size()));
}

jbyteArray encodePasteBytes(JNIEnv* env, const std::vector<char>& data) {
  if (!ensureGhosttyVt()) return emptyBytes(env);
  const size_t cap = std::max<size_t>(64, data.size() * 4 + 64);
  std::vector<char> out(cap);
  uintptr_t written = 0;
  if (!ghostty_android_vt_encode_paste(g_vt, data.data(), data.size(), out.data(), out.size(), &written)) return emptyBytes(env);
  return byteArray(env, out.data(), std::min<size_t>(written, out.size()));
}

jbyteArray encodeKeyBytes(JNIEnv* env, uint32_t key, uint32_t mods, const std::vector<char>& data, bool composing, uint32_t action) {
  if (!ensureGhosttyVt()) return emptyBytes(env);
  std::vector<char> out(128);
  uintptr_t written = 0;
  if (!ghostty_android_vt_encode_key(g_vt, key, mods, data.data(), data.size(), composing, action, out.data(), out.size(), &written)) return emptyBytes(env);
  return byteArray(env, out.data(), std::min<size_t>(written, out.size()));
}

jbyteArray encodeMouseBytes(JNIEnv* env, uint32_t action, uint32_t button, uint32_t mods, uint32_t col, uint32_t row) {
  if (!ensureGhosttyVt()) return emptyBytes(env);
  std::vector<char> out(64);
  uintptr_t written = 0;
  if (!ghostty_android_vt_encode_mouse(g_vt, action, button, mods, col, row, out.data(), out.size(), &written)) return emptyBytes(env);
  return byteArray(env, out.data(), std::min<size_t>(written, out.size()));
}
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_linn0x_prospero_ghostty_ProsperoGhosttyNative_nativeAvailable(JNIEnv*, jobject) {
  return JNI_FALSE;
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_linn0x_prospero_ghostty_ProsperoGhosttyNative_nativeUnavailableReason(JNIEnv* env, jobject) {
  return env->NewStringUTF("Android libghostty GLES path is staged behind the feature gate");
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_linn0x_prospero_ghostty_ProsperoGhosttyNative_nativeVersion(JNIEnv* env, jobject) {
  const std::string value = ghosttyVersion() + " android-arm64";
  return env->NewStringUTF(value.c_str());
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_linn0x_prospero_ghostty_ProsperoGhosttyNative_nativeAttachSurface(JNIEnv* env, jobject, jobject surface) {
  std::lock_guard<std::mutex> lock(g_mutex);
  if (surface == nullptr) return env->NewStringUTF("Android Surface is null");
  ANativeWindow* window = ANativeWindow_fromSurface(env, surface);
  if (window == nullptr) return env->NewStringUTF("ANativeWindow_fromSurface failed");
  clearEgl();
  ghostty_surface_config_s config = {};
  config.platform_tag = GHOSTTY_PLATFORM_ANDROID;
  config.platform.android.native_window = window;
  const bool ok = config.platform_tag == GHOSTTY_PLATFORM_ANDROID && config.platform.android.native_window == window;
  if (!ok) {
    ANativeWindow_release(window);
    return env->NewStringUTF("Android platform config failed");
  }
  const char* error = initEgl(window);
  if (error != nullptr) {
    ANativeWindow_release(window);
    return env->NewStringUTF(error);
  }
  return nullptr;
}

extern "C" JNIEXPORT void JNICALL
Java_com_linn0x_prospero_ghostty_ProsperoGhosttyNative_nativeDetachSurface(JNIEnv*, jobject) {
  std::lock_guard<std::mutex> lock(g_mutex);
  clearEgl();
}

extern "C" JNIEXPORT void JNICALL
Java_com_linn0x_prospero_ghostty_ProsperoGhosttyNative_nativeResizeGrid(JNIEnv*, jobject, jint cols, jint rows) {
  std::lock_guard<std::mutex> lock(g_mutex);
  if (cols <= 0 || rows <= 0 || (cols == g_cols && rows == g_rows)) return;
  if (ensureGhosttyVt()) {
    ghostty_android_vt_resize(g_vt, static_cast<uint32_t>(cols), static_cast<uint32_t>(rows));
  }
  resetGrid(cols, rows);
  syncFromGhostty();
  renderGrid();
}

extern "C" JNIEXPORT void JNICALL
Java_com_linn0x_prospero_ghostty_ProsperoGhosttyNative_nativeSetSnapshot(JNIEnv* env, jobject, jbyteArray data, jint cols, jint rows) {
  if (data == nullptr) return;
  std::lock_guard<std::mutex> lock(g_mutex);
  resetGhosttyVt(cols > 0 ? cols : g_cols, rows > 0 ? rows : g_rows);
  const jsize len = env->GetArrayLength(data);
  std::vector<char> bytes(static_cast<size_t>(len));
  env->GetByteArrayRegion(data, 0, len, reinterpret_cast<jbyte*>(bytes.data()));
  if (ensureGhosttyVt()) {
    ghostty_android_vt_feed(g_vt, bytes.data(), bytes.size());
    syncFromGhostty();
  }
  renderGrid();
}

extern "C" JNIEXPORT void JNICALL
Java_com_linn0x_prospero_ghostty_ProsperoGhosttyNative_nativeWrite(JNIEnv* env, jobject, jbyteArray data) {
  if (data == nullptr) return;
  std::lock_guard<std::mutex> lock(g_mutex);
  const jsize len = env->GetArrayLength(data);
  std::vector<char> bytes(static_cast<size_t>(len));
  env->GetByteArrayRegion(data, 0, len, reinterpret_cast<jbyte*>(bytes.data()));
  if (ensureGhosttyVt()) {
    ghostty_android_vt_feed(g_vt, bytes.data(), bytes.size());
    syncFromGhostty();
  }
  renderGrid();
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_linn0x_prospero_ghostty_ProsperoGhosttyNative_nativeEncodeText(JNIEnv* env, jobject, jbyteArray data) {
  std::lock_guard<std::mutex> lock(g_mutex);
  return encodeTextBytes(env, readBytes(env, data));
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_linn0x_prospero_ghostty_ProsperoGhosttyNative_nativeEncodeKey(JNIEnv* env, jobject, jint key, jint mods, jbyteArray data, jboolean composing, jint action) {
  std::lock_guard<std::mutex> lock(g_mutex);
  return encodeKeyBytes(
    env,
    static_cast<uint32_t>(std::max(0, static_cast<int>(key))),
    static_cast<uint32_t>(std::max(0, static_cast<int>(mods))),
    readBytes(env, data),
    composing == JNI_TRUE,
    static_cast<uint32_t>(std::max(0, static_cast<int>(action)))
  );
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_linn0x_prospero_ghostty_ProsperoGhosttyNative_nativeEncodePaste(JNIEnv* env, jobject, jbyteArray data) {
  std::lock_guard<std::mutex> lock(g_mutex);
  return encodePasteBytes(env, readBytes(env, data));
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_linn0x_prospero_ghostty_ProsperoGhosttyNative_nativeEncodeMouse(JNIEnv* env, jobject, jint action, jint button, jint mods, jint col, jint row) {
  std::lock_guard<std::mutex> lock(g_mutex);
  return encodeMouseBytes(
    env,
    static_cast<uint32_t>(std::max(0, static_cast<int>(action))),
    static_cast<uint32_t>(std::max(0, static_cast<int>(button))),
    static_cast<uint32_t>(std::max(0, static_cast<int>(mods))),
    static_cast<uint32_t>(std::max(0, static_cast<int>(col))),
    static_cast<uint32_t>(std::max(0, static_cast<int>(row)))
  );
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_linn0x_prospero_ghostty_ProsperoGhosttyNative_nativeBracketedPaste(JNIEnv*, jobject) {
  std::lock_guard<std::mutex> lock(g_mutex);
  if (!ensureGhosttyVt()) return JNI_FALSE;
  return ghostty_android_vt_bracketed_paste(g_vt) ? JNI_TRUE : JNI_FALSE;
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_linn0x_prospero_ghostty_ProsperoGhosttyNative_nativeMouseReporting(JNIEnv*, jobject) {
  std::lock_guard<std::mutex> lock(g_mutex);
  if (!ensureGhosttyVt()) return JNI_FALSE;
  return ghostty_android_vt_mouse_reporting(g_vt) ? JNI_TRUE : JNI_FALSE;
}

extern "C" JNIEXPORT void JNICALL
Java_com_linn0x_prospero_ghostty_ProsperoGhosttyNative_nativeScrollLines(JNIEnv*, jobject, jint lines) {
  std::lock_guard<std::mutex> lock(g_mutex);
  g_viewport_offset += static_cast<int>(lines);
  clampViewport();
  syncFromGhostty();
  renderGrid();
}

extern "C" JNIEXPORT void JNICALL
Java_com_linn0x_prospero_ghostty_ProsperoGhosttyNative_nativeScrollToBottom(JNIEnv*, jobject) {
  std::lock_guard<std::mutex> lock(g_mutex);
  g_viewport_offset = 0;
  syncFromGhostty();
  renderGrid();
}

extern "C" JNIEXPORT void JNICALL
Java_com_linn0x_prospero_ghostty_ProsperoGhosttyNative_nativeSetSelection(JNIEnv*, jobject, jint startCol, jint startRow, jint endCol, jint endRow) {
  std::lock_guard<std::mutex> lock(g_mutex);
  g_selection_start = visiblePoint(static_cast<int>(startCol), static_cast<int>(startRow));
  g_selection_end = visiblePoint(static_cast<int>(endCol), static_cast<int>(endRow));
  g_has_selection = true;
  renderGrid();
}

extern "C" JNIEXPORT void JNICALL
Java_com_linn0x_prospero_ghostty_ProsperoGhosttyNative_nativeClearSelection(JNIEnv*, jobject) {
  std::lock_guard<std::mutex> lock(g_mutex);
  g_has_selection = false;
  renderGrid();
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_linn0x_prospero_ghostty_ProsperoGhosttyNative_nativeReadSelection(JNIEnv* env, jobject, jboolean all) {
  std::lock_guard<std::mutex> lock(g_mutex);
  const std::string value = readSelectionText(all == JNI_TRUE);
  return env->NewStringUTF(value.c_str());
}

extern "C" JNIEXPORT void JNICALL
Java_com_linn0x_prospero_ghostty_ProsperoGhosttyNative_nativeSetFontAtlas(
  JNIEnv* env,
  jobject,
  jobject bitmap,
  jint atlasCols,
  jint firstChar,
  jint cellWidth,
  jint cellHeight
) {
  if (bitmap == nullptr) return;
  std::lock_guard<std::mutex> lock(g_mutex);
  if (g_display == EGL_NO_DISPLAY || g_surface == EGL_NO_SURFACE || g_context == EGL_NO_CONTEXT) return;
  if (eglMakeCurrent(g_display, g_surface, g_surface, g_context) != EGL_TRUE) return;
  AndroidBitmapInfo info;
  if (AndroidBitmap_getInfo(env, bitmap, &info) != ANDROID_BITMAP_RESULT_SUCCESS) return;
  if (info.format != ANDROID_BITMAP_FORMAT_RGBA_8888) return;
  void* pixels = nullptr;
  if (AndroidBitmap_lockPixels(env, bitmap, &pixels) != ANDROID_BITMAP_RESULT_SUCCESS) return;
  if (g_atlas == 0) glGenTextures(1, &g_atlas);
  glBindTexture(GL_TEXTURE_2D, g_atlas);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
  glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, static_cast<GLsizei>(info.width), static_cast<GLsizei>(info.height), 0, GL_RGBA, GL_UNSIGNED_BYTE, pixels);
  AndroidBitmap_unlockPixels(env, bitmap);
  g_atlas_width = static_cast<int>(info.width);
  g_atlas_height = static_cast<int>(info.height);
  g_atlas_cols = std::max(1, static_cast<int>(atlasCols));
  g_atlas_first = static_cast<int>(firstChar);
  g_cell_width = std::max(1, static_cast<int>(cellWidth));
  g_cell_height = std::max(1, static_cast<int>(cellHeight));
  renderGrid();
}
