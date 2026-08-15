#include "prospero_windows_native.h"

#if defined(_WIN32)

#include <windows.h>

namespace {

prospero_status StatusFromLastError(DWORD error) {
  switch (error) {
    case ERROR_ACCESS_DENIED:
      return PROSPERO_STATUS_ACCESS_DENIED;
    case ERROR_INVALID_PARAMETER:
      // OpenProcess returns INVALID_PARAMETER for a non-existent PID. Treating
      // a stale manifest as malformed input would hide PID reuse/recovery bugs.
      return PROSPERO_STATUS_NOT_FOUND;
    case ERROR_INVALID_HANDLE:
    case ERROR_NOT_FOUND:
      return PROSPERO_STATUS_NOT_FOUND;
    default:
      return PROSPERO_STATUS_SYSTEM_ERROR;
  }
}

uint64_t FileTimeToUint64(const FILETIME& value) {
  ULARGE_INTEGER ticks{};
  ticks.LowPart = value.dwLowDateTime;
  ticks.HighPart = value.dwHighDateTime;
  return ticks.QuadPart;
}

prospero_status GetIdentityForOpenedProcess(HANDLE process,
                                            uint32_t expected_pid,
                                            prospero_process_identity* out_identity) {
  const DWORD wait = WaitForSingleObject(process, 0);
  if (wait == WAIT_OBJECT_0) return PROSPERO_STATUS_NOT_FOUND;
  if (wait == WAIT_FAILED) return StatusFromLastError(GetLastError());
  if (wait != WAIT_TIMEOUT) return PROSPERO_STATUS_SYSTEM_ERROR;
  FILETIME creation{};
  FILETIME exit{};
  FILETIME kernel{};
  FILETIME user{};
  if (!GetProcessTimes(process, &creation, &exit, &kernel, &user)) {
    return StatusFromLastError(GetLastError());
  }

  const DWORD observed_pid = GetProcessId(process);
  if (observed_pid == 0 || observed_pid != expected_pid) {
    // A handle that does not report the PID just opened cannot prove the
    // identity requested by the caller. Never return a PID-only identity.
    return PROSPERO_STATUS_NOT_FOUND;
  }
  const uint64_t creation_time = FileTimeToUint64(creation);
  if (creation_time == 0) return PROSPERO_STATUS_SYSTEM_ERROR;
  // A process can exit after GetProcessTimes returns. Recheck immediately
  // before publishing PID+FILETIME, mirroring the job-assignment identity
  // boundary and preventing an exited handle from validating recovery state.
  const DWORD final_wait = WaitForSingleObject(process, 0);
  if (final_wait == WAIT_OBJECT_0) return PROSPERO_STATUS_NOT_FOUND;
  if (final_wait == WAIT_FAILED) return StatusFromLastError(GetLastError());
  if (final_wait != WAIT_TIMEOUT) return PROSPERO_STATUS_SYSTEM_ERROR;
  out_identity->pid = observed_pid;
  out_identity->creation_time_100ns = creation_time;
  return PROSPERO_STATUS_OK;
}

prospero_status GetProcessIdentityInternal(uint32_t pid,
                                           prospero_process_identity* out_identity) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
                               FALSE, pid);
  if (process == nullptr) return StatusFromLastError(GetLastError());
  const prospero_status status = GetIdentityForOpenedProcess(process, pid, out_identity);
  CloseHandle(process);
  return status;
}

// This intentionally shares neither a PID-only shortcut nor a best-effort
// shell fallback with callers.  The creation FILETIME is checked immediately
// before TerminateProcess, and the process handle is then waited before this
// operation reports success to its caller.
prospero_status TerminateExactProcess(prospero_process_identity expected,
                                      uint32_t exit_code,
                                      uint32_t timeout_ms,
                                      uint8_t* out_terminated) {
  if (expected.pid == 0 || expected.creation_time_100ns == 0 ||
      timeout_ms == 0 || out_terminated == nullptr) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  *out_terminated = 0;
  HANDLE process = OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION |
                                   SYNCHRONIZE,
                               FALSE,
                               expected.pid);
  if (process == nullptr) {
    const prospero_status status = StatusFromLastError(GetLastError());
    // A missing process is explicitly not a termination target. Access denial
    // is deliberately propagated so a caller cannot claim rollback succeeded.
    return status == PROSPERO_STATUS_NOT_FOUND ? PROSPERO_STATUS_OK : status;
  }

  prospero_process_identity actual{};
  const prospero_status identity_status =
      GetIdentityForOpenedProcess(process, expected.pid, &actual);
  if (identity_status != PROSPERO_STATUS_OK ||
      actual.creation_time_100ns != expected.creation_time_100ns) {
    CloseHandle(process);
    return identity_status == PROSPERO_STATUS_NOT_FOUND ||
                   identity_status == PROSPERO_STATUS_OK
               ? PROSPERO_STATUS_OK
               : identity_status;
  }

  // GetIdentityForOpenedProcess performs a final liveness check.  The process
  // is this exact kernel handle, so no PID reuse can be introduced between
  // this point and TerminateProcess.
  if (!TerminateProcess(process, exit_code)) {
    const prospero_status status = StatusFromLastError(GetLastError());
    CloseHandle(process);
    return status == PROSPERO_STATUS_NOT_FOUND ? PROSPERO_STATUS_OK : status;
  }
  const DWORD waited = WaitForSingleObject(process, timeout_ms);
  if (waited == WAIT_OBJECT_0) {
    *out_terminated = 1;
    CloseHandle(process);
    return PROSPERO_STATUS_OK;
  }
  const prospero_status status = waited == WAIT_FAILED
                                     ? StatusFromLastError(GetLastError())
                                     : PROSPERO_STATUS_SYSTEM_ERROR;
  CloseHandle(process);
  return status;
}

}  // namespace

extern "C" prospero_status prospero_get_current_process_identity(
    prospero_process_identity* out_identity) {
  if (out_identity == nullptr) return PROSPERO_STATUS_INVALID_ARGUMENT;
  out_identity->pid = 0;
  out_identity->creation_time_100ns = 0;
  return GetProcessIdentityInternal(GetCurrentProcessId(), out_identity);
}

extern "C" prospero_status prospero_get_process_identity(
    uint32_t pid,
    prospero_process_identity* out_identity) {
  if (pid == 0 || out_identity == nullptr) return PROSPERO_STATUS_INVALID_ARGUMENT;
  out_identity->pid = 0;
  out_identity->creation_time_100ns = 0;
  return GetProcessIdentityInternal(pid, out_identity);
}

extern "C" prospero_status prospero_process_identity_matches(
    prospero_process_identity expected,
    uint8_t* out_matches) {
  if (expected.pid == 0 || expected.creation_time_100ns == 0 || out_matches == nullptr) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  *out_matches = 0;
  prospero_process_identity actual{};
  const prospero_status status = prospero_get_process_identity(expected.pid, &actual);
  if (status == PROSPERO_STATUS_NOT_FOUND) return PROSPERO_STATUS_OK;
  // An access-denied revalidation cannot establish either absence or a
  // FILETIME mismatch. Propagate it so a caller cannot treat an inaccessible
  // owner as safely gone and perform a PID-only recovery action.
  if (status != PROSPERO_STATUS_OK) return status;
  *out_matches = actual.creation_time_100ns == expected.creation_time_100ns ? 1 : 0;
  return PROSPERO_STATUS_OK;
}

extern "C" prospero_status prospero_terminate_process_if_identity(
    prospero_process_identity expected,
    uint32_t exit_code,
    uint32_t timeout_ms,
    uint8_t* out_terminated) {
  return TerminateExactProcess(expected, exit_code, timeout_ms, out_terminated);
}

#else

extern "C" prospero_status prospero_get_current_process_identity(
    prospero_process_identity* out_identity) {
  if (out_identity == nullptr) return PROSPERO_STATUS_INVALID_ARGUMENT;
  out_identity->pid = 0;
  out_identity->creation_time_100ns = 0;
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_get_process_identity(
    uint32_t pid,
    prospero_process_identity* out_identity) {
  if (pid == 0 || out_identity == nullptr) return PROSPERO_STATUS_INVALID_ARGUMENT;
  out_identity->pid = 0;
  out_identity->creation_time_100ns = 0;
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_process_identity_matches(
    prospero_process_identity expected,
    uint8_t* out_matches) {
  if (expected.pid == 0 || expected.creation_time_100ns == 0 || out_matches == nullptr) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  *out_matches = 0;
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_terminate_process_if_identity(
    prospero_process_identity expected,
    uint32_t exit_code,
    uint32_t timeout_ms,
    uint8_t* out_terminated) {
  (void)exit_code;
  if (expected.pid == 0 || expected.creation_time_100ns == 0 ||
      timeout_ms == 0 || out_terminated == nullptr) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  *out_terminated = 0;
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

#endif
