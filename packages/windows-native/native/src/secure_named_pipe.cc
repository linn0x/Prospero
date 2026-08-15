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
  // Do not call CreateNamedPipeW with a NULL SECURITY_ATTRIBUTES/default DACL.
  // A production implementation also passes PIPE_REJECT_REMOTE_CLIENTS and
  // stores only a server object here; accepted clients get separate handles.
  *out_server = 0;
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_secure_pipe_server_accept(
    prospero_secure_pipe_server_handle server,
    prospero_secure_pipe_connection_handle* out_connection) {
  if (server == 0 || out_connection == nullptr) return PROSPERO_STATUS_INVALID_ARGUMENT;
  *out_connection = 0;
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_secure_pipe_server_close(
    prospero_secure_pipe_server_handle server) {
  if (server == 0) return PROSPERO_STATUS_INVALID_ARGUMENT;
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_secure_pipe_connection_read(
    prospero_secure_pipe_connection_handle connection,
    uint8_t* buffer,
    uint32_t capacity,
    uint32_t* out_read) {
  if (connection == 0 || buffer == nullptr || capacity == 0 || out_read == nullptr) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  *out_read = 0;
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_secure_pipe_connection_write(
    prospero_secure_pipe_connection_handle connection,
    const uint8_t* buffer,
    uint32_t length,
    uint32_t* out_written) {
  if (connection == 0 || buffer == nullptr || length == 0 || out_written == nullptr) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  *out_written = 0;
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_secure_pipe_connection_peer_identity(
    prospero_secure_pipe_connection_handle connection,
    prospero_pipe_peer_identity* out_peer) {
  if (connection == 0 || out_peer == nullptr) return PROSPERO_STATUS_INVALID_ARGUMENT;
  // The future implementation must impersonate the named-pipe client and query
  // its token SID plus PID+creation FILETIME; PID alone is never sufficient.
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_secure_pipe_connection_disconnect(
    prospero_secure_pipe_connection_handle connection) {
  if (connection == 0) return PROSPERO_STATUS_INVALID_ARGUMENT;
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_secure_pipe_connection_close(
    prospero_secure_pipe_connection_handle connection) {
  if (connection == 0) return PROSPERO_STATUS_INVALID_ARGUMENT;
  return PROSPERO_STATUS_NOT_AVAILABLE;
}
