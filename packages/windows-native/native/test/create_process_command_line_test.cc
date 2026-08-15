#include <iostream>
#include <string>

#include "prospero_create_process_command_line.h"

namespace {

bool ExpectEqual(const char* name,
                 const std::wstring& actual,
                 const std::wstring& expected) {
  if (actual == expected) return true;
  std::cerr << name << " did not produce the expected command line" << std::endl;
  return false;
}

bool ExpectQuotedArgument(const char* name,
                          const wchar_t* argument,
                          const std::wstring& expected) {
  std::wstring actual;
  if (!prospero_create_process::AppendQuotedArgument(argument, &actual)) {
    std::cerr << name << " failed to quote its argument" << std::endl;
    return false;
  }
  return ExpectEqual(name, actual, expected);
}

}  // namespace

int main() {
  // A repeated backslash run before an ordinary character used to append from
  // L"\\" with a dynamic length. Two backslashes deterministically copied the
  // literal's terminating NUL; longer runs could read beyond that literal.
  // Keep the exact command-line text assertion so either regression fails.
  if (!ExpectQuotedArgument(
          "multiple backslashes before an ordinary character",
          LR"(multiple\\\ordinary text)",
          LR"expected("multiple\\\ordinary text")expected")) {
    return 1;
  }

  if (!ExpectQuotedArgument("empty argument", L"", L"\"\"")) return 1;

  if (!ExpectQuotedArgument(
          "backslashes before a quote",
          LR"(slashes before \\"quote" after)",
          LR"expected("slashes before \\\\\"quote\" after")expected")) {
    return 1;
  }

  if (!ExpectQuotedArgument(
          "trailing backslashes",
          LR"(trailing backslashes \\\)",
          LR"expected("trailing backslashes \\\\\\")expected")) {
    return 1;
  }

  if (!ExpectQuotedArgument(
          "Unicode argument",
          L"你好🙂 with spaces",
          L"\"你好🙂 with spaces\"")) {
    return 1;
  }

  const wchar_t* arguments[] = {
      LR"(multiple\\\ordinary text)",
      L"",
      LR"(slashes before \\"quote" after)",
      LR"(trailing backslashes \\\)",
      L"你好🙂 with spaces",
  };
  std::wstring command_line;
  if (!prospero_create_process::BuildCommandLine(
          LR"(C:\Program Files\Prospero\runner.exe)", arguments,
          sizeof(arguments) / sizeof(arguments[0]), &command_line)) {
    std::cerr << "BuildCommandLine failed" << std::endl;
    return 1;
  }

  return ExpectEqual(
             "full command line",
             command_line,
             LR"expected("C:\Program Files\Prospero\runner.exe" "multiple\\\ordinary text" "" "slashes before \\\\\"quote\" after" "trailing backslashes \\\\\\" "你好🙂 with spaces")expected")
         ? 0
         : 1;
}
