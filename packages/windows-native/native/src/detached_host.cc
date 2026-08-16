#include "prospero_windows_native.h"
#include "prospero_create_process_command_line.h"

#if defined(_WIN32)

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#include <cwctype>
#include <string>

namespace {

HANDLE ToHandle(prospero_job_object_handle handle) {
  return reinterpret_cast<HANDLE>(static_cast<uintptr_t>(handle));
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

bool IsAbsoluteApplicationPath(const wchar_t* path) {
  if (path == nullptr || path[0] == L'\0') return false;
  // Accept drive-rooted and UNC paths only. In particular, reject a current
  // directory-relative executable name so CreateProcessW cannot perform PATH
  // searching or pick up an attacker-controlled sibling executable.
  if (iswalpha(path[0]) && path[1] == L':' && path[2] == L'\\') return true;
  return path[0] == L'\\' && path[1] == L'\\' &&
         path[2] != L'?' && path[2] != L'.' && path[2] != L'\0';
}

bool IsSafeEnvironmentBlock(const wchar_t* environment_block) {
  if (environment_block == nullptr) return true;
  // The caller supplies a standard double-NUL-terminated CreateProcessW
  // block. We cannot know its allocated length from the frozen C ABI, but we
  // can reject malformed entries and avoid treating it as a single string.
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

enum class ImmediateJobBreakawayMode {
  kNone,
  kExplicit,
  kSilent,
};

// QueryInformationJobObject(NULL, ...) exposes the calling process's
// immediate job only. This deliberately selects creation flags for that one
// job; it is not evidence that every ancestor will release the child.
prospero_status GetImmediateJobBreakawayMode(
    ImmediateJobBreakawayMode* out_mode) {
  if (out_mode == nullptr) return PROSPERO_STATUS_INVALID_ARGUMENT;
  *out_mode = ImmediateJobBreakawayMode::kNone;

  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {};
  if (!QueryInformationJobObject(nullptr,
                                 JobObjectExtendedLimitInformation,
                                 &limits,
                                 sizeof(limits),
                                 nullptr)) {
    return StatusFromWin32Error(GetLastError());
  }

  const DWORD flags = limits.BasicLimitInformation.LimitFlags;
  // SILENT_BREAKAWAY_OK makes the direct child leave this Job automatically.
  // CREATE_BREAKAWAY_FROM_JOB is required only for BREAKAWAY_OK. Prefer the
  // silent behavior if a caller has configured both flags.
  if ((flags & JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK) != 0) {
    *out_mode = ImmediateJobBreakawayMode::kSilent;
  } else if ((flags & JOB_OBJECT_LIMIT_BREAKAWAY_OK) != 0) {
    *out_mode = ImmediateJobBreakawayMode::kExplicit;
  }
  return PROSPERO_STATUS_OK;
}

uint64_t FileTimeToUint64(const FILETIME& value) {
  ULARGE_INTEGER result;
  result.LowPart = value.dwLowDateTime;
  result.HighPart = value.dwHighDateTime;
  return result.QuadPart;
}

bool GetProcessIdentity(HANDLE process, DWORD pid, prospero_process_identity* out_identity) {
  if (out_identity == nullptr) return false;
  FILETIME creation_time;
  FILETIME ignored_exit_time;
  FILETIME ignored_kernel_time;
  FILETIME ignored_user_time;
  if (!GetProcessTimes(process,
                       &creation_time,
                       &ignored_exit_time,
                       &ignored_kernel_time,
                       &ignored_user_time)) {
    return false;
  }
  out_identity->pid = pid;
  out_identity->creation_time_100ns = FileTimeToUint64(creation_time);
  return out_identity->creation_time_100ns != 0;
}

void RollBackUnresumedLaunch(const PROCESS_INFORMATION& process) {
  // A failed transaction has not resumed the initial thread, so no provider
  // child tree can exist yet. Direct termination is therefore limited to this
  // never-resumed rollback and never stands in for normal tree termination;
  // this also avoids accidentally killing unrelated members of a supplied Job.
  if (process.hProcess != nullptr) {
    TerminateProcess(process.hProcess, ERROR_PROCESS_ABORTED);
    CloseHandle(process.hProcess);
  }
  if (process.hThread != nullptr) CloseHandle(process.hThread);
}

}  // namespace

extern "C" prospero_status prospero_detached_host_launch(
    const prospero_detached_host_launch_options* options,
    prospero_detached_host_launch_result* out_result) {
  if (options == nullptr || out_result == nullptr ||
      !IsAbsoluteApplicationPath(options->executable_path) ||
      (options->working_directory != nullptr &&
       !IsAbsoluteApplicationPath(options->working_directory)) ||
      (options->has_job != 0 && options->job == 0) ||
      !IsSafeEnvironmentBlock(options->environment_block)) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }

  *out_result = {};
  const prospero_status parent_status =
      prospero_query_parent_job_compatibility(&out_result->parent_job);
  if (parent_status != PROSPERO_STATUS_OK) return parent_status;
  if (out_result->parent_job.detached_launch_allowed == 0) {
    out_result->outcome = PROSPERO_DETACHED_HOST_PARENT_JOB_PREVENTS_DETACH;
    return PROSPERO_STATUS_OK;
  }

  ImmediateJobBreakawayMode breakaway_mode = ImmediateJobBreakawayMode::kNone;
  if (out_result->parent_job.parent_job_detected != 0) {
    const prospero_status breakaway_status =
        GetImmediateJobBreakawayMode(&breakaway_mode);
    if (breakaway_status != PROSPERO_STATUS_OK) return breakaway_status;
    // A parent can change its limit flags between the compatibility query and
    // process creation. Treat that race as a normal, explicit non-launch.
    if (breakaway_mode == ImmediateJobBreakawayMode::kNone) {
      out_result->parent_job.breakaway_allowed = 0;
      out_result->parent_job.detached_launch_allowed = 0;
      out_result->outcome = PROSPERO_DETACHED_HOST_PARENT_JOB_PREVENTS_DETACH;
      return PROSPERO_STATUS_OK;
    }
  }

  HANDLE job = nullptr;
  if (options->has_job != 0) {
    job = ToHandle(options->job);
    // A supplied provider Job must retain KILL_ON_JOB_CLOSE ownership and
    // may not permit provider breakaway. Unknown Job policy fails closed.
    const prospero_status job_status = ValidateProviderJob(job);
    if (job_status != PROSPERO_STATUS_OK) return job_status;
  }

  std::wstring command_line;
  if (!prospero_create_process::BuildCommandLine(options->executable_path,
                                                  options->arguments,
                                                  options->argument_count,
                                                  &command_line)) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }

  STARTUPINFOW startup_info = {};
  startup_info.cb = sizeof(startup_info);
  // A durable background owner must not retain the launcher's capture pipes,
  // but it still needs to be able to create children with working stdio of
  // their own (the Authenticode verifier does exactly that). DETACHED_PROCESS
  // leaves console-process stream state unusable for that nested spawn on the
  // hosted Windows runners. CREATE_NO_WINDOW preserves the no-console policy,
  // while explicit NULL standard slots prevent parent stdio from crossing.
  startup_info.dwFlags = STARTF_USESTDHANDLES;
  startup_info.hStdInput = nullptr;
  startup_info.hStdOutput = nullptr;
  startup_info.hStdError = nullptr;
  PROCESS_INFORMATION process = {};
  DWORD creation_flags = CREATE_UNICODE_ENVIRONMENT |
      CREATE_NEW_PROCESS_GROUP |
      CREATE_NO_WINDOW |
      CREATE_SUSPENDED;
  if (breakaway_mode == ImmediateJobBreakawayMode::kExplicit) {
    creation_flags |= CREATE_BREAKAWAY_FROM_JOB;
  }

  if (!CreateProcessW(options->executable_path,
                      &command_line[0],
                      nullptr,
                      nullptr,
                      FALSE,  // No inherited daemon handles or stdio.
                      creation_flags,
                      const_cast<wchar_t*>(options->environment_block),
                      options->working_directory,
                      &startup_info,
                      &process)) {
    return StatusFromWin32Error(GetLastError());
  }

  // NULL asks whether the child remains in *any* Job. This must happen while
  // it is still suspended, before assigning the intended provider Job: a
  // successful immediate-job breakaway is insufficient if an ancestor held
  // the child. Rollback is intentionally only this child, never the caller's
  // supplied Job.
  BOOL child_in_any_job = FALSE;
  if (!IsProcessInJob(process.hProcess, nullptr, &child_in_any_job)) {
    const prospero_status status = StatusFromWin32Error(GetLastError());
    RollBackUnresumedLaunch(process);
    return status;
  }
  if (child_in_any_job) {
    RollBackUnresumedLaunch(process);
    out_result->parent_job.detached_launch_allowed = 0;
    out_result->outcome = PROSPERO_DETACHED_HOST_PARENT_JOB_PREVENTS_DETACH;
    return PROSPERO_STATUS_OK;
  }

  if (job != nullptr) {
    if (!AssignProcessToJobObject(job, process.hProcess)) {
      const prospero_status status = StatusFromWin32Error(GetLastError());
      RollBackUnresumedLaunch(process);
      return status;
    }
  }
  if (!GetProcessIdentity(process.hProcess, process.dwProcessId, &out_result->process)) {
    const prospero_status status = StatusFromWin32Error(GetLastError());
    RollBackUnresumedLaunch(process);
    return status;
  }
  if (ResumeThread(process.hThread) == static_cast<DWORD>(-1)) {
    const prospero_status status = StatusFromWin32Error(GetLastError());
    RollBackUnresumedLaunch(process);
    return status;
  }

  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  out_result->outcome = PROSPERO_DETACHED_HOST_LAUNCHED;
  return PROSPERO_STATUS_OK;
}

#else

extern "C" prospero_status prospero_detached_host_launch(
    const prospero_detached_host_launch_options* options,
    prospero_detached_host_launch_result* out_result) {
  if (options == nullptr || out_result == nullptr || options->executable_path == nullptr) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  *out_result = {};
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

#endif
