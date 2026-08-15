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

extern "C" prospero_status prospero_get_process_identity(
    uint32_t pid,
    prospero_process_identity* out_identity) {
  if (pid == 0 || out_identity == nullptr) return PROSPERO_STATUS_INVALID_ARGUMENT;
  // A production implementation opens this exact PID, reads GetProcessTimes,
  // and never returns an identity based on PID alone.
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
  // Production must reopen expected.pid and compare GetProcessTimes exactly;
  // accepting a PID whose FILETIME differs would permit PID-reuse confusion.
  *out_matches = 0;
  return PROSPERO_STATUS_NOT_AVAILABLE;
}
