#include "prospero_windows_native.h"

extern "C" prospero_status prospero_detached_host_launch(
    const prospero_detached_host_launch_options* options,
    prospero_detached_host_launch_result* out_result) {
  if (options == nullptr || out_result == nullptr || options->executable_path == nullptr) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  // The future implementation checks parent Job breakaway compatibility before
  // CreateProcessW. If blocked, it returns
  // PROSPERO_DETACHED_HOST_PARENT_JOB_PREVENTS_DETACH rather than pretending a
  // child inherited by the parent Job is detached. It never invokes a shell.
  out_result->outcome = PROSPERO_DETACHED_HOST_PARENT_JOB_PREVENTS_DETACH;
  out_result->process.pid = 0;
  out_result->process.creation_time_100ns = 0;
  out_result->parent_job.parent_job_detected = 0;
  out_result->parent_job.breakaway_allowed = 0;
  out_result->parent_job.detached_launch_allowed = 0;
  return PROSPERO_STATUS_NOT_AVAILABLE;
}
