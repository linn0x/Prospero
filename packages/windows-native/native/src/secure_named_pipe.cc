#include "prospero_windows_native.h"

extern "C" prospero_status prospero_secure_pipe_server_create(
    const prospero_secure_pipe_server_options* options,
    prospero_secure_pipe_server_handle* out_server) {
  if (options == nullptr || out_server == nullptr || options->pipe_name == nullptr ||
      options->security.allowed_user_sid == nullptr ||
      options->security.self_relative_security_descriptor == nullptr ||
      options->security.security_descriptor_bytes == 0) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  // Do not call CreateNamedPipe with a NULL SECURITY_ATTRIBUTES/default DACL.
  *out_server = 0;
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_secure_pipe_server_close(
    prospero_secure_pipe_server_handle server) {
  if (server == 0) return PROSPERO_STATUS_INVALID_ARGUMENT;
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_secure_pipe_server_peer_identity(
    prospero_secure_pipe_server_handle server,
    prospero_pipe_peer_identity* out_peer) {
  if (server == 0 || out_peer == nullptr) return PROSPERO_STATUS_INVALID_ARGUMENT;
  // The future implementation must impersonate the named-pipe client and query
  // its token SID plus PID+creation FILETIME; PID alone is never sufficient.
  return PROSPERO_STATUS_NOT_AVAILABLE;
}
