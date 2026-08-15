#include "prospero_windows_native.h"

extern "C" prospero_status prospero_detached_host_launch(
    const prospero_detached_host_launch_options* options,
    prospero_process_identity* out_process) {
  if (options == nullptr || out_process == nullptr || options->executable_path == nullptr) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  // The future implementation uses CreateProcessW with explicit handles and an
  // optional Job Object.  It never invokes a command shell.
  out_process->pid = 0;
  out_process->creation_time_100ns = 0;
  return PROSPERO_STATUS_NOT_AVAILABLE;
}
