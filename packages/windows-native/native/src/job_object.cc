#include "prospero_windows_native.h"

#if defined(_WIN32)

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

namespace {

HANDLE ToHandle(prospero_job_object_handle handle) {
  return reinterpret_cast<HANDLE>(static_cast<uintptr_t>(handle));
}

prospero_status StatusFromWin32Error(DWORD error) {
  switch (error) {
    case ERROR_ACCESS_DENIED:
      return PROSPERO_STATUS_ACCESS_DENIED;
    case ERROR_FILE_NOT_FOUND:
    case ERROR_INVALID_HANDLE:
    // OpenProcess reports a nonzero PID that no longer exists as
    // ERROR_INVALID_PARAMETER. Treat it as the same recoverable stale-PID
    // condition as a FILETIME mismatch, matching identity-match semantics.
    case ERROR_INVALID_PARAMETER:
    case ERROR_NOT_FOUND:
      return PROSPERO_STATUS_NOT_FOUND;
    case ERROR_CALL_NOT_IMPLEMENTED:
    case ERROR_NOT_SUPPORTED:
      return PROSPERO_STATUS_NOT_AVAILABLE;
    default:
      return PROSPERO_STATUS_SYSTEM_ERROR;
  }
}

uint64_t FileTimeToUint64(const FILETIME& value) {
  ULARGE_INTEGER result;
  result.LowPart = value.dwLowDateTime;
  result.HighPart = value.dwHighDateTime;
  return result.QuadPart;
}

prospero_status VerifyProcessIsLive(HANDLE process) {
  const DWORD wait_result = WaitForSingleObject(process, 0);
  if (wait_result == WAIT_TIMEOUT) return PROSPERO_STATUS_OK;
  if (wait_result == WAIT_OBJECT_0) return PROSPERO_STATUS_NOT_FOUND;
  if (wait_result == WAIT_FAILED) return StatusFromWin32Error(GetLastError());
  return PROSPERO_STATUS_SYSTEM_ERROR;
}

// Reopen the numeric PID and compare its creation time before performing an
// operation on it. A job assignment based on a PID alone would be vulnerable
// to PID reuse between the daemon's observation and this native call.
prospero_status OpenVerifiedProcess(
    prospero_process_identity expected,
    HANDLE* out_process) {
  if (out_process == nullptr || expected.pid == 0 ||
      expected.creation_time_100ns == 0) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  *out_process = nullptr;

  HANDLE process = OpenProcess(
      PROCESS_SET_QUOTA |
          PROCESS_TERMINATE |
          PROCESS_QUERY_LIMITED_INFORMATION |
          SYNCHRONIZE,
      FALSE,
      expected.pid);
  if (process == nullptr) return StatusFromWin32Error(GetLastError());

  prospero_status live_status = VerifyProcessIsLive(process);
  if (live_status != PROSPERO_STATUS_OK) {
    CloseHandle(process);
    return live_status;
  }

  FILETIME creation_time;
  FILETIME ignored_exit_time;
  FILETIME ignored_kernel_time;
  FILETIME ignored_user_time;
  if (!GetProcessTimes(process,
                       &creation_time,
                       &ignored_exit_time,
                       &ignored_kernel_time,
                       &ignored_user_time)) {
    const prospero_status status = StatusFromWin32Error(GetLastError());
    CloseHandle(process);
    return status;
  }
  if (FileTimeToUint64(creation_time) != expected.creation_time_100ns) {
    CloseHandle(process);
    return PROSPERO_STATUS_NOT_FOUND;
  }
  // A process can legally exit with code 259 (STILL_ACTIVE), so process
  // liveness is determined from the signaled state, not GetExitCodeProcess.
  // Recheck after FILETIME comparison to reject an exited PID at the second
  // assignment-critical point.
  live_status = VerifyProcessIsLive(process);
  if (live_status != PROSPERO_STATUS_OK) {
    CloseHandle(process);
    return live_status;
  }

  *out_process = process;
  return PROSPERO_STATUS_OK;
}

}  // namespace

extern "C" prospero_status prospero_job_object_create(
    const prospero_job_object_options* options,
    prospero_job_object_handle* out_job) {
  if (options == nullptr || out_job == nullptr ||
      (options->has_active_process_limit != 0 &&
       options->active_process_limit == 0)) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  *out_job = 0;

  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (job == nullptr) return StatusFromWin32Error(GetLastError());

  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {};
  if (options->kill_on_close != 0) {
    limits.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  }
  if (options->has_active_process_limit != 0) {
    limits.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
    limits.BasicLimitInformation.ActiveProcessLimit = options->active_process_limit;
  }
  // Deliberately do not set BREAKAWAY_OK or SILENT_BREAKAWAY_OK: the job is
  // the process-tree authority for a hosted provider and must remain so.
  if (!SetInformationJobObject(
          job,
          JobObjectExtendedLimitInformation,
          &limits,
          sizeof(limits))) {
    const prospero_status status = StatusFromWin32Error(GetLastError());
    CloseHandle(job);
    return status;
  }

  *out_job = static_cast<prospero_job_object_handle>(
      reinterpret_cast<uintptr_t>(job));
  return PROSPERO_STATUS_OK;
}

extern "C" prospero_status prospero_job_object_assign_process(
    prospero_job_object_handle job,
    prospero_process_identity process_identity) {
  if (job == 0 || process_identity.pid == 0 ||
      process_identity.creation_time_100ns == 0) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }

  HANDLE process = nullptr;
  const prospero_status verify_status =
      OpenVerifiedProcess(process_identity, &process);
  if (verify_status != PROSPERO_STATUS_OK) return verify_status;

  const BOOL assigned = AssignProcessToJobObject(ToHandle(job), process);
  const prospero_status status = assigned
      ? PROSPERO_STATUS_OK
      : StatusFromWin32Error(GetLastError());
  CloseHandle(process);
  return status;
}

extern "C" prospero_status prospero_job_object_terminate(
    prospero_job_object_handle job,
    uint32_t exit_code) {
  if (job == 0) return PROSPERO_STATUS_INVALID_ARGUMENT;
  // This is the only process-tree termination primitive exposed by this
  // boundary. taskkill, process enumeration, and PID-only termination are
  // intentionally never used as substitutes for Job Object ownership.
  if (!TerminateJobObject(ToHandle(job), exit_code)) {
    return StatusFromWin32Error(GetLastError());
  }
  return PROSPERO_STATUS_OK;
}

extern "C" prospero_status prospero_job_object_close(
    prospero_job_object_handle job) {
  if (job == 0) return PROSPERO_STATUS_INVALID_ARGUMENT;
  if (!CloseHandle(ToHandle(job))) return StatusFromWin32Error(GetLastError());
  return PROSPERO_STATUS_OK;
}

extern "C" prospero_status prospero_query_parent_job_compatibility(
    prospero_parent_job_compatibility* out_compatibility) {
  if (out_compatibility == nullptr) return PROSPERO_STATUS_INVALID_ARGUMENT;
  *out_compatibility = {};

  BOOL in_parent_job = FALSE;
  if (!IsProcessInJob(GetCurrentProcess(), nullptr, &in_parent_job)) {
    return StatusFromWin32Error(GetLastError());
  }
  if (!in_parent_job) {
    // No enclosing job means a child has no Job inheritance to escape.
    out_compatibility->breakaway_allowed = 1;
    out_compatibility->detached_launch_allowed = 1;
    return PROSPERO_STATUS_OK;
  }

  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {};
  // With a NULL job handle this query describes only the immediate job of
  // the calling process. It is useful as a preflight check, but it cannot
  // establish that all ancestor jobs will let a child escape. The detached
  // launcher therefore rechecks the suspended child with IsProcessInJob
  // before it ever resumes it.
  if (!QueryInformationJobObject(nullptr,
                                 JobObjectExtendedLimitInformation,
                                 &limits,
                                 sizeof(limits),
                                 nullptr)) {
    // An unknown parent policy must never be treated as detachable.
    return StatusFromWin32Error(GetLastError());
  }
  const DWORD limit_flags = limits.BasicLimitInformation.LimitFlags;
  const bool breakaway_allowed =
      (limit_flags & JOB_OBJECT_LIMIT_BREAKAWAY_OK) != 0 ||
      (limit_flags & JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK) != 0;
  out_compatibility->parent_job_detected = 1;
  out_compatibility->breakaway_allowed = breakaway_allowed ? 1 : 0;
  out_compatibility->detached_launch_allowed = breakaway_allowed ? 1 : 0;
  return PROSPERO_STATUS_OK;
}

#else

// The package never builds a non-Windows production addon. Keep direct C ABI
// callers fail-closed as an additional guard for accidental cross-platform
// compilation.
extern "C" prospero_status prospero_job_object_create(
    const prospero_job_object_options* options,
    prospero_job_object_handle* out_job) {
  if (options == nullptr || out_job == nullptr) return PROSPERO_STATUS_INVALID_ARGUMENT;
  *out_job = 0;
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_job_object_assign_process(
    prospero_job_object_handle job,
    prospero_process_identity process) {
  if (job == 0 || process.pid == 0 || process.creation_time_100ns == 0) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_job_object_terminate(
    prospero_job_object_handle job,
    uint32_t exit_code) {
  (void)exit_code;
  return job == 0 ? PROSPERO_STATUS_INVALID_ARGUMENT : PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_job_object_close(
    prospero_job_object_handle job) {
  return job == 0 ? PROSPERO_STATUS_INVALID_ARGUMENT : PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_query_parent_job_compatibility(
    prospero_parent_job_compatibility* out_compatibility) {
  if (out_compatibility == nullptr) return PROSPERO_STATUS_INVALID_ARGUMENT;
  *out_compatibility = {};
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

#endif
