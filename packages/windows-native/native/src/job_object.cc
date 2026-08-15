#include "prospero_windows_native.h"

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
  // Before AssignProcessToJobObject, production must reopen process.pid and
  // compare GetProcessTimes to process.creation_time_100ns exactly.
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_job_object_terminate(
    prospero_job_object_handle job,
    uint32_t exit_code) {
  (void)exit_code;
  if (job == 0) return PROSPERO_STATUS_INVALID_ARGUMENT;
  // Job-object termination is required; taskkill is intentionally never used.
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_job_object_close(prospero_job_object_handle job) {
  if (job == 0) return PROSPERO_STATUS_INVALID_ARGUMENT;
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_query_parent_job_compatibility(
    prospero_parent_job_compatibility* out_compatibility) {
  if (out_compatibility == nullptr) return PROSPERO_STATUS_INVALID_ARGUMENT;
  // A production implementation calls IsProcessInJob and, if enclosed, reads
  // JOB_OBJECT_LIMIT_BREAKAWAY_OK / JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK.
  out_compatibility->parent_job_detected = 0;
  out_compatibility->breakaway_allowed = 0;
  out_compatibility->detached_launch_allowed = 0;
  return PROSPERO_STATUS_NOT_AVAILABLE;
}
