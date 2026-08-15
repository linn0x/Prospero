#ifndef PROSPERO_CREATE_PROCESS_COMMAND_LINE_H_
#define PROSPERO_CREATE_PROCESS_COMMAND_LINE_H_

#include <cstdint>
#include <cwchar>
#include <string>
#include <utility>

namespace prospero_create_process {

// CreateProcessW accepts at most 32,767 UTF-16 code units, including its
// required trailing NUL. Keep construction bounded rather than first building
// an arbitrarily large command line and rejecting it afterwards.
constexpr size_t kMaxCommandLineCodeUnits = 32767;
constexpr size_t kMaxCommandLineTextCodeUnits = kMaxCommandLineCodeUnits - 1;

inline bool AppendCodeUnits(std::wstring* command_line,
                            const wchar_t* value,
                            size_t length) {
  if (command_line == nullptr || value == nullptr ||
      command_line->size() > kMaxCommandLineTextCodeUnits ||
      length > kMaxCommandLineTextCodeUnits - command_line->size()) {
    return false;
  }
  command_line->append(value, length);
  return true;
}

inline bool AppendCodeUnit(std::wstring* command_line, wchar_t value) {
  return AppendCodeUnits(command_line, &value, 1);
}

inline bool AppendRepeatedCodeUnit(std::wstring* command_line,
                                   wchar_t value,
                                   size_t count) {
  if (command_line == nullptr ||
      command_line->size() > kMaxCommandLineTextCodeUnits ||
      count > kMaxCommandLineTextCodeUnits - command_line->size()) {
    return false;
  }
  command_line->append(count, value);
  return true;
}

// Quote one argv element according to the Microsoft C runtime parsing rules.
// This produces command-line text only; it never invokes a command shell.
inline bool AppendQuotedArgument(const wchar_t* argument, std::wstring* command_line) {
  if (argument == nullptr || command_line == nullptr) return false;

  const bool quote = argument[0] == L'\0' ||
      wcspbrk(argument, L" \t\n\v\"") != nullptr;
  if (!quote) return AppendCodeUnits(command_line, argument, wcslen(argument));

  if (!AppendCodeUnit(command_line, L'"')) return false;
  size_t slashes = 0;
  for (const wchar_t* cursor = argument; *cursor != L'\0'; ++cursor) {
    if (*cursor == L'\\') {
      ++slashes;
      continue;
    }
    if (*cursor == L'"') {
      if (!AppendRepeatedCodeUnit(command_line, L'\\', slashes) ||
          !AppendRepeatedCodeUnit(command_line, L'\\', slashes) ||
          !AppendCodeUnit(command_line, L'\\') ||
          !AppendCodeUnit(command_line, L'"')) {
        return false;
      }
      slashes = 0;
      continue;
    }
    if (!AppendCodeUnits(command_line, L"\\", slashes) ||
        !AppendCodeUnit(command_line, *cursor)) {
      return false;
    }
    slashes = 0;
  }
  if (!AppendRepeatedCodeUnit(command_line, L'\\', slashes) ||
      !AppendRepeatedCodeUnit(command_line, L'\\', slashes) ||
      !AppendCodeUnit(command_line, L'"')) {
    return false;
  }
  return true;
}

// lpApplicationName selects the executable without PATH searching. The same
// trusted absolute path is also argv[0], followed by the caller's structured
// argument vector. Some programs, including Node, parse their startup flags
// relative to argv[0], so omitting it silently changes their behavior.
inline bool BuildCommandLine(const wchar_t* executable_path,
                             const wchar_t* const* arguments,
                             uint32_t argument_count,
                             std::wstring* out_command_line) {
  if (out_command_line == nullptr || executable_path == nullptr ||
      executable_path[0] == L'\0' ||
      (argument_count != 0 && arguments == nullptr)) {
    return false;
  }

  std::wstring command_line;
  if (!AppendQuotedArgument(executable_path, &command_line)) return false;
  for (uint32_t index = 0; index < argument_count; ++index) {
    if (arguments[index] == nullptr ||
        !AppendCodeUnit(&command_line, L' ') ||
        !AppendQuotedArgument(arguments[index], &command_line)) {
      return false;
    }
  }
  *out_command_line = std::move(command_line);
  return true;
}

}  // namespace prospero_create_process

#endif  // PROSPERO_CREATE_PROCESS_COMMAND_LINE_H_
