#include "prospero_windows_native.h"

extern "C" prospero_status prospero_get_current_process_identity(
    prospero_process_identity* out_identity) {
  if (out_identity == nullptr) return PROSPERO_STATUS_INVALID_ARGUMENT;
  // Deliberately fail closed until the Windows implementation obtains both the
  // PID and GetProcessTimes FILETIME from a real process handle.
  out_identity->pid = 0;
  out_identity->creation_time_100ns = 0;
  return PROSPERO_STATUS_NOT_AVAILABLE;
}
