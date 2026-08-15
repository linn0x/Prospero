#include "prospero_windows_native.h"
#include "prospero_create_process_command_line.h"

#if defined(_WIN32)

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#include <algorithm>
#include <cwctype>
#include <new>
#include <string>
#include <utility>
#include <vector>

#ifndef PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE
#define PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE 0x00020016
#endif

namespace {

// ConPTY first shipped in Windows 10 version 1809. Resolve it dynamically so
// older Windows releases fail closed instead of loading an addon with a missing
// import table entry.
using CreatePseudoConsoleFunction = HRESULT (WINAPI*)(
    COORD, HANDLE, HANDLE, DWORD, HANDLE*);
using ResizePseudoConsoleFunction = HRESULT (WINAPI*)(HANDLE, COORD);
using ClosePseudoConsoleFunction = void (WINAPI*)(HANDLE);

struct PseudoConsoleFunctions {
  CreatePseudoConsoleFunction create = nullptr;
  ResizePseudoConsoleFunction resize = nullptr;
  ClosePseudoConsoleFunction close = nullptr;
};

PseudoConsoleFunctions GetPseudoConsoleFunctions() {
  HMODULE kernel32 = GetModuleHandleW(L"kernel32.dll");
  if (kernel32 == nullptr) return {};
  PseudoConsoleFunctions functions;
  functions.create = reinterpret_cast<CreatePseudoConsoleFunction>(
      GetProcAddress(kernel32, "CreatePseudoConsole"));
  functions.resize = reinterpret_cast<ResizePseudoConsoleFunction>(
      GetProcAddress(kernel32, "ResizePseudoConsole"));
  functions.close = reinterpret_cast<ClosePseudoConsoleFunction>(
      GetProcAddress(kernel32, "ClosePseudoConsole"));
  return functions;
}

struct ConPtySession {
  HANDLE pseudo_console = nullptr;
  HANDLE input_write = nullptr;
  HANDLE output_read = nullptr;
  HANDLE process = nullptr;
  HANDLE job = nullptr;
  bool owns_job = false;
  PseudoConsoleFunctions functions;
};

HANDLE ToHandle(prospero_job_object_handle handle) {
  return reinterpret_cast<HANDLE>(static_cast<uintptr_t>(handle));
}

ConPtySession* ToSession(prospero_conpty_handle handle) {
  return reinterpret_cast<ConPtySession*>(static_cast<uintptr_t>(handle));
}

prospero_status StatusFromWin32Error(DWORD error) {
  switch (error) {
    case ERROR_ACCESS_DENIED:
      return PROSPERO_STATUS_ACCESS_DENIED;
    case ERROR_FILE_NOT_FOUND:
    case ERROR_PATH_NOT_FOUND:
    case ERROR_INVALID_HANDLE:
    case ERROR_NOT_FOUND:
      return PROSPERO_STATUS_NOT_FOUND;
    case ERROR_CALL_NOT_IMPLEMENTED:
    case ERROR_NOT_SUPPORTED:
      return PROSPERO_STATUS_NOT_AVAILABLE;
    default:
      return PROSPERO_STATUS_SYSTEM_ERROR;
  }
}

prospero_status StatusFromHresult(HRESULT result) {
  if (result == E_NOTIMPL || result == HRESULT_FROM_WIN32(ERROR_CALL_NOT_IMPLEMENTED) ||
      result == HRESULT_FROM_WIN32(ERROR_NOT_SUPPORTED)) {
    return PROSPERO_STATUS_NOT_AVAILABLE;
  }
  if (result == E_ACCESSDENIED || result == HRESULT_FROM_WIN32(ERROR_ACCESS_DENIED)) {
    return PROSPERO_STATUS_ACCESS_DENIED;
  }
  if (result == HRESULT_FROM_WIN32(ERROR_INVALID_HANDLE) ||
      result == HRESULT_FROM_WIN32(ERROR_NOT_FOUND)) {
    return PROSPERO_STATUS_NOT_FOUND;
  }
  return PROSPERO_STATUS_SYSTEM_ERROR;
}

bool IsAbsoluteApplicationPath(const wchar_t* path) {
  if (path == nullptr || path[0] == L'\0') return false;
  if (iswalpha(path[0]) && path[1] == L':' && path[2] == L'\\') return true;
  return path[0] == L'\\' && path[1] == L'\\' &&
         path[2] != L'?' && path[2] != L'.' && path[2] != L'\0';
}

bool IsSafeEnvironmentBlock(const wchar_t* environment_block) {
  if (environment_block == nullptr) return true;
  const wchar_t* entry = environment_block;
  while (*entry != L'\0') {
    if (wcschr(entry, L'=') == nullptr || wcschr(entry, L'\n') != nullptr ||
        wcschr(entry, L'\r') != nullptr) {
      return false;
    }
    entry += wcslen(entry) + 1;
  }
  return true;
}

prospero_status ValidateProviderJob(HANDLE job) {
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {};
  if (!QueryInformationJobObject(job,
                                 JobObjectExtendedLimitInformation,
                                 &limits,
                                 sizeof(limits),
                                 nullptr)) {
    return StatusFromWin32Error(GetLastError());
  }
  const DWORD flags = limits.BasicLimitInformation.LimitFlags;
  if ((flags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) == 0 ||
      (flags & (JOB_OBJECT_LIMIT_BREAKAWAY_OK |
                JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK)) != 0) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  return PROSPERO_STATUS_OK;
}

HANDLE CreateHostedProviderJob() {
  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (job == nullptr) return nullptr;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  // Do not set either breakaway flag. Any provider is therefore held by this
  // Job until explicit kill or host teardown.
  if (!SetInformationJobObject(job,
                               JobObjectExtendedLimitInformation,
                               &limits,
                               sizeof(limits))) {
    CloseHandle(job);
    return nullptr;
  }
  return job;
}

void CloseIfValid(HANDLE handle) {
  if (handle != nullptr && handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
}

void DrainAndCloseOutput(HANDLE* output_read) {
  if (output_read == nullptr || *output_read == nullptr ||
      *output_read == INVALID_HANDLE_VALUE) {
    return;
  }

  // Do not call ClosePseudoConsole while the host-side output pipe remains
  // open. On older Windows builds that can synchronously wait on the pipe.
  // PeekNamedPipe keeps this bounded to already-buffered data and therefore
  // cannot block teardown if the provider is unresponsive.
  uint8_t buffer[8192];
  for (;;) {
    DWORD available = 0;
    if (!PeekNamedPipe(*output_read, nullptr, 0, nullptr, &available, nullptr) ||
        available == 0) {
      break;
    }
    const DWORD to_read = std::min<DWORD>(available, static_cast<DWORD>(sizeof(buffer)));
    DWORD ignored_read = 0;
    if (!ReadFile(*output_read, buffer, to_read, &ignored_read, nullptr) ||
        ignored_read == 0) {
      break;
    }
  }
  CloseIfValid(*output_read);
  *output_read = nullptr;
}

void CloseSession(ConPtySession* session) {
  if (session == nullptr) return;
  // Stop accepting input first, terminate the hosted tree, then drain and
  // close output before ClosePseudoConsole. This ordering avoids old-system
  // synchronous ConPTY close deadlocks while preserving the final buffered
  // bytes for the duration of teardown.
  CloseIfValid(session->input_write);
  session->input_write = nullptr;
  if (session->job != nullptr) TerminateJobObject(session->job, ERROR_PROCESS_ABORTED);
  DrainAndCloseOutput(&session->output_read);
  if (session->pseudo_console != nullptr && session->functions.close != nullptr) {
    session->functions.close(session->pseudo_console);
  }
  session->pseudo_console = nullptr;
  CloseIfValid(session->process);
  session->process = nullptr;
  if (session->owns_job) CloseIfValid(session->job);
  session->job = nullptr;
  delete session;
}

void RollBackSpawn(
    const PROCESS_INFORMATION& process,
    HANDLE input_write,
    HANDLE* output_read,
    HANDLE pseudo_console,
    const PseudoConsoleFunctions& functions,
    HANDLE owned_job) {
  // The initial thread has not been resumed when this helper is called. A
  // direct TerminateProcess is therefore transaction rollback only, never a
  // claimed process-tree cleanup primitive. In particular, do not terminate a
  // caller-supplied Job: it might contain unrelated providers.
  if (process.hProcess != nullptr) {
    TerminateProcess(process.hProcess, ERROR_PROCESS_ABORTED);
  }
  CloseIfValid(process.hThread);
  CloseIfValid(process.hProcess);
  CloseIfValid(input_write);
  DrainAndCloseOutput(output_read);
  if (pseudo_console != nullptr && functions.close != nullptr) {
    functions.close(pseudo_console);
  }
  CloseIfValid(owned_job);
}

}  // namespace

extern "C" prospero_status prospero_conpty_spawn(
    const prospero_conpty_spawn_options* options,
    prospero_conpty_handle* out_terminal) {
  if (options == nullptr || out_terminal == nullptr ||
      !IsAbsoluteApplicationPath(options->executable_path) ||
      options->columns == 0 || options->rows == 0 ||
      options->columns > 32767 || options->rows > 32767 ||
      (options->working_directory != nullptr &&
       !IsAbsoluteApplicationPath(options->working_directory)) ||
      (options->has_job != 0 && options->job == 0) ||
      !IsSafeEnvironmentBlock(options->environment_block)) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  *out_terminal = 0;

  const PseudoConsoleFunctions functions = GetPseudoConsoleFunctions();
  if (functions.create == nullptr || functions.resize == nullptr || functions.close == nullptr) {
    return PROSPERO_STATUS_NOT_AVAILABLE;
  }

  HANDLE job = nullptr;
  bool owns_job = false;
  if (options->has_job != 0) {
    job = ToHandle(options->job);
    const prospero_status job_status = ValidateProviderJob(job);
    if (job_status != PROSPERO_STATUS_OK) return job_status;
  } else {
    job = CreateHostedProviderJob();
    if (job == nullptr) return StatusFromWin32Error(GetLastError());
    owns_job = true;
  }

  std::wstring command_line;
  if (!prospero_create_process::BuildCommandLine(options->executable_path,
                                                  options->arguments,
                                                  options->argument_count,
                                                  &command_line)) {
    if (owns_job) CloseIfValid(job);
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }

  SECURITY_ATTRIBUTES inheritable = {};
  inheritable.nLength = sizeof(inheritable);
  inheritable.bInheritHandle = TRUE;
  HANDLE input_read = nullptr;
  HANDLE input_write = nullptr;
  HANDLE output_read = nullptr;
  HANDLE output_write = nullptr;
  if (!CreatePipe(&input_read, &input_write, &inheritable, 0) ||
      !CreatePipe(&output_read, &output_write, &inheritable, 0)) {
    const prospero_status status = StatusFromWin32Error(GetLastError());
    CloseIfValid(input_read);
    CloseIfValid(input_write);
    CloseIfValid(output_read);
    CloseIfValid(output_write);
    if (owns_job) CloseIfValid(job);
    return status;
  }
  if (!SetHandleInformation(input_write, HANDLE_FLAG_INHERIT, 0) ||
      !SetHandleInformation(output_read, HANDLE_FLAG_INHERIT, 0)) {
    const prospero_status status = StatusFromWin32Error(GetLastError());
    CloseIfValid(input_read);
    CloseIfValid(input_write);
    CloseIfValid(output_read);
    CloseIfValid(output_write);
    if (owns_job) CloseIfValid(job);
    return status;
  }

  HANDLE pseudo_console = nullptr;
  const COORD size = {static_cast<SHORT>(options->columns), static_cast<SHORT>(options->rows)};
  const HRESULT create_result = functions.create(
      size, input_read, output_write, 0, &pseudo_console);
  if (FAILED(create_result)) {
    CloseIfValid(input_read);
    CloseIfValid(input_write);
    CloseIfValid(output_read);
    CloseIfValid(output_write);
    if (pseudo_console != nullptr) functions.close(pseudo_console);
    if (owns_job) CloseIfValid(job);
    return StatusFromHresult(create_result);
  }
  // Keep these two pseudoconsole ends open until CreateProcessW has consumed
  // the attribute. They are the ConPTY-side endpoints; the host retains only
  // input_write and output_read for its synchronous UTF-8 VT streams. Closing
  // either host-side endpoint early would turn this into a pipe-lifecycle bug,
  // not an argv or terminal-rendering failure.

  SIZE_T attribute_list_bytes = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &attribute_list_bytes);
  if (attribute_list_bytes == 0) {
    const prospero_status status = StatusFromWin32Error(GetLastError());
    CloseIfValid(input_read);
    CloseIfValid(output_write);
    CloseIfValid(input_write);
    CloseIfValid(output_read);
    functions.close(pseudo_console);
    if (owns_job) CloseIfValid(job);
    return status;
  }
  LPPROC_THREAD_ATTRIBUTE_LIST attribute_list =
      static_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(
          HeapAlloc(GetProcessHeap(), 0, attribute_list_bytes));
  if (attribute_list == nullptr) {
    CloseIfValid(input_read);
    CloseIfValid(output_write);
    CloseIfValid(input_write);
    CloseIfValid(output_read);
    functions.close(pseudo_console);
    if (owns_job) CloseIfValid(job);
    return PROSPERO_STATUS_SYSTEM_ERROR;
  }
  if (!InitializeProcThreadAttributeList(attribute_list, 1, 0, &attribute_list_bytes)) {
    const prospero_status status = StatusFromWin32Error(GetLastError());
    HeapFree(GetProcessHeap(), 0, attribute_list);
    CloseIfValid(input_read);
    CloseIfValid(output_write);
    CloseIfValid(input_write);
    CloseIfValid(output_read);
    functions.close(pseudo_console);
    if (owns_job) CloseIfValid(job);
    return status;
  }
  if (!UpdateProcThreadAttribute(attribute_list,
                                 0,
                                 PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
                                 pseudo_console,
                                 sizeof(pseudo_console),
                                 nullptr,
                                 nullptr)) {
    const prospero_status status = StatusFromWin32Error(GetLastError());
    DeleteProcThreadAttributeList(attribute_list);
    HeapFree(GetProcessHeap(), 0, attribute_list);
    CloseIfValid(input_read);
    CloseIfValid(output_write);
    CloseIfValid(input_write);
    CloseIfValid(output_read);
    functions.close(pseudo_console);
    if (owns_job) CloseIfValid(job);
    return status;
  }

  STARTUPINFOEXW startup_info = {};
  startup_info.StartupInfo.cb = sizeof(startup_info);
  // GitHub Actions/Vitest starts this host with stdout and stderr redirected
  // to capture pipes. Windows copies those standard-handle slots into a
  // console child even when bInheritHandles is FALSE. ConPTY replaces console
  // handles, but intentionally does not replace a pre-existing pipe, so the
  // provider's output leaked to the runner while output_read contained only
  // conhost's VT/title sequences. Request explicit standard handles with
  // NULL slots: this prevents the capture pipes from crossing the boundary
  // and lets the pseudoconsole initialize the child's console handles.
  //
  // Do not replace this with inherited pipe handles or bInheritHandles=TRUE.
  // The zero slots carry no host handle, so the Job, journal, IPC, and parent
  // stdio handles remain outside the provider boundary.
  startup_info.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup_info.StartupInfo.hStdInput = nullptr;
  startup_info.StartupInfo.hStdOutput = nullptr;
  startup_info.StartupInfo.hStdError = nullptr;
  startup_info.lpAttributeList = attribute_list;
  PROCESS_INFORMATION process = {};
  // This is deliberately not the detached-host flag set. HPCON supplies the
  // terminal, the Job owns the process tree, and no Ctrl-event process group
  // is used. CREATE_NEW_PROCESS_GROUP would additionally disable Ctrl+C in
  // the child; DETACHED_PROCESS would sever the very console ConPTY provides.
  const DWORD creation_flags = CREATE_UNICODE_ENVIRONMENT |
      CREATE_SUSPENDED |
      EXTENDED_STARTUPINFO_PRESENT;
  const BOOL created = CreateProcessW(options->executable_path,
                                      &command_line[0],
                                      nullptr,
                                      nullptr,
                                      FALSE,  // Only the pseudoconsole attribute crosses.
                                      creation_flags,
                                      const_cast<wchar_t*>(options->environment_block),
                                      options->working_directory,
                                      &startup_info.StartupInfo,
                                      &process);
  const DWORD create_error = created ? ERROR_SUCCESS : GetLastError();
  DeleteProcThreadAttributeList(attribute_list);
  HeapFree(GetProcessHeap(), 0, attribute_list);
  // CreatePseudoConsole owns the child-side relationship from here; retaining
  // these local pipe handles would keep its streams artificially alive and
  // prevent output EOF after the hosted process exits.
  CloseIfValid(input_read);
  CloseIfValid(output_write);
  input_read = nullptr;
  output_write = nullptr;
  if (!created) {
    CloseIfValid(input_write);
    CloseIfValid(output_read);
    functions.close(pseudo_console);
    if (owns_job) CloseIfValid(job);
    return StatusFromWin32Error(create_error);
  }

  if (!AssignProcessToJobObject(job, process.hProcess)) {
    const prospero_status status = StatusFromWin32Error(GetLastError());
    RollBackSpawn(process,
                  input_write,
                  &output_read,
                  pseudo_console,
                  functions,
                  owns_job ? job : nullptr);
    return status;
  }

  // Prepare all session ownership before releasing the primary thread. There
  // must be no allocation or initialization failure after ResumeThread: an
  // unresumed rollback may terminate only this child, while a running session
  // is cleaned up via its dedicated/explicit Job lifecycle.
  ConPtySession* session = new (std::nothrow) ConPtySession();
  if (session == nullptr) {
    RollBackSpawn(process,
                  input_write,
                  &output_read,
                  pseudo_console,
                  functions,
                  owns_job ? job : nullptr);
    return PROSPERO_STATUS_SYSTEM_ERROR;
  }
  session->pseudo_console = pseudo_console;
  session->input_write = input_write;
  session->output_read = output_read;
  session->process = process.hProcess;
  session->job = job;
  session->owns_job = owns_job;
  session->functions = functions;

  if (ResumeThread(process.hThread) == static_cast<DWORD>(-1)) {
    const prospero_status status = StatusFromWin32Error(GetLastError());
    RollBackSpawn(process,
                  input_write,
                  &output_read,
                  pseudo_console,
                  functions,
                  owns_job ? job : nullptr);
    delete session;
    return status;
  }
  CloseIfValid(process.hThread);
  *out_terminal = static_cast<prospero_conpty_handle>(
      reinterpret_cast<uintptr_t>(session));
  return PROSPERO_STATUS_OK;
}

extern "C" prospero_status prospero_conpty_resize(
    prospero_conpty_handle terminal,
    uint16_t columns,
    uint16_t rows) {
  ConPtySession* session = ToSession(terminal);
  if (session == nullptr || columns == 0 || rows == 0) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  if (columns > 32767 || rows > 32767) return PROSPERO_STATUS_INVALID_ARGUMENT;
  if (session->pseudo_console == nullptr || session->functions.resize == nullptr) {
    return PROSPERO_STATUS_NOT_FOUND;
  }
  const COORD size = {static_cast<SHORT>(columns), static_cast<SHORT>(rows)};
  const HRESULT result = session->functions.resize(session->pseudo_console, size);
  return SUCCEEDED(result) ? PROSPERO_STATUS_OK : StatusFromHresult(result);
}

extern "C" prospero_status prospero_conpty_read(
    prospero_conpty_handle terminal,
    uint8_t* buffer,
    uint32_t capacity,
    uint32_t* out_read) {
  ConPtySession* session = ToSession(terminal);
  if (session == nullptr || buffer == nullptr || capacity == 0 || out_read == nullptr) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  *out_read = 0;
  if (session->output_read == nullptr) return PROSPERO_STATUS_NOT_FOUND;

  DWORD available = 0;
  if (!PeekNamedPipe(session->output_read, nullptr, 0, nullptr, &available, nullptr)) {
    const DWORD error = GetLastError();
    // EOF is a normal terminal state after the Job exits; it is represented as
    // an empty read so callers can drain already-buffered output without a
    // spurious fatal transport error.
    if (error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED) {
      return PROSPERO_STATUS_OK;
    }
    return StatusFromWin32Error(error);
  }
  if (available == 0) return PROSPERO_STATUS_OK;

  const DWORD bytes_to_read = std::min<DWORD>(available, capacity);
  DWORD bytes_read = 0;
  if (!ReadFile(session->output_read, buffer, bytes_to_read, &bytes_read, nullptr)) {
    const DWORD error = GetLastError();
    if (error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED) {
      return PROSPERO_STATUS_OK;
    }
    return StatusFromWin32Error(error);
  }
  *out_read = bytes_read;
  return PROSPERO_STATUS_OK;
}

extern "C" prospero_status prospero_conpty_write(
    prospero_conpty_handle terminal,
    const uint8_t* buffer,
    uint32_t length,
    uint32_t* out_written) {
  ConPtySession* session = ToSession(terminal);
  if (session == nullptr || buffer == nullptr || length == 0 || out_written == nullptr) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  *out_written = 0;
  if (session->input_write == nullptr) return PROSPERO_STATUS_NOT_FOUND;
  DWORD written = 0;
  if (!WriteFile(session->input_write, buffer, length, &written, nullptr)) {
    const DWORD error = GetLastError();
    if (error == ERROR_BROKEN_PIPE || error == ERROR_NO_DATA) return PROSPERO_STATUS_NOT_FOUND;
    return StatusFromWin32Error(error);
  }
  *out_written = written;
  return PROSPERO_STATUS_OK;
}

extern "C" prospero_status prospero_conpty_kill(
    prospero_conpty_handle terminal,
    uint32_t exit_code) {
  ConPtySession* session = ToSession(terminal);
  if (session == nullptr || session->job == nullptr) return PROSPERO_STATUS_INVALID_ARGUMENT;
  // Explicit terminal kill always has Job Object tree semantics; never fall
  // back to a single PID kill or taskkill.
  if (!TerminateJobObject(session->job, exit_code)) {
    return StatusFromWin32Error(GetLastError());
  }
  return PROSPERO_STATUS_OK;
}

extern "C" prospero_status prospero_conpty_close(prospero_conpty_handle terminal) {
  ConPtySession* session = ToSession(terminal);
  if (session == nullptr) return PROSPERO_STATUS_INVALID_ARGUMENT;
  CloseSession(session);
  return PROSPERO_STATUS_OK;
}

#else

extern "C" prospero_status prospero_conpty_spawn(
    const prospero_conpty_spawn_options* options,
    prospero_conpty_handle* out_terminal) {
  if (options == nullptr || out_terminal == nullptr || options->executable_path == nullptr ||
      options->columns == 0 || options->rows == 0) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  *out_terminal = 0;
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_conpty_resize(
    prospero_conpty_handle terminal,
    uint16_t columns,
    uint16_t rows) {
  return terminal == 0 || columns == 0 || rows == 0
      ? PROSPERO_STATUS_INVALID_ARGUMENT
      : PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_conpty_read(
    prospero_conpty_handle terminal,
    uint8_t* buffer,
    uint32_t capacity,
    uint32_t* out_read) {
  if (terminal == 0 || buffer == nullptr || capacity == 0 || out_read == nullptr) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  *out_read = 0;
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_conpty_write(
    prospero_conpty_handle terminal,
    const uint8_t* buffer,
    uint32_t length,
    uint32_t* out_written) {
  if (terminal == 0 || buffer == nullptr || length == 0 || out_written == nullptr) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  *out_written = 0;
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_conpty_kill(
    prospero_conpty_handle terminal,
    uint32_t exit_code) {
  (void)exit_code;
  return terminal == 0 ? PROSPERO_STATUS_INVALID_ARGUMENT : PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_conpty_close(prospero_conpty_handle terminal) {
  return terminal == 0 ? PROSPERO_STATUS_INVALID_ARGUMENT : PROSPERO_STATUS_NOT_AVAILABLE;
}

#endif
