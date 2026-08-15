#include "prospero_windows_native.h"

extern "C" prospero_status prospero_conpty_spawn(
    const prospero_conpty_spawn_options* options,
    prospero_conpty_handle* out_terminal) {
  if (options == nullptr || out_terminal == nullptr || options->executable_path == nullptr ||
      options->columns == 0 || options->rows == 0) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  *out_terminal = 0;
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_conpty_resize(
    prospero_conpty_handle terminal,
    uint16_t columns,
    uint16_t rows) {
  if (terminal == 0 || columns == 0 || rows == 0) return PROSPERO_STATUS_INVALID_ARGUMENT;
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_conpty_read(
    prospero_conpty_handle terminal,
    uint8_t* buffer,
    uint32_t capacity,
    uint32_t* out_read) {
  if (terminal == 0 || buffer == nullptr || capacity == 0 || out_read == nullptr) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  *out_read = 0;
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_conpty_write(
    prospero_conpty_handle terminal,
    const uint8_t* buffer,
    uint32_t length,
    uint32_t* out_written) {
  if (terminal == 0 || buffer == nullptr || length == 0 || out_written == nullptr) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  *out_written = 0;
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_conpty_kill(
    prospero_conpty_handle terminal,
    uint32_t exit_code) {
  (void)exit_code;
  if (terminal == 0) return PROSPERO_STATUS_INVALID_ARGUMENT;
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_conpty_close(prospero_conpty_handle terminal) {
  if (terminal == 0) return PROSPERO_STATUS_INVALID_ARGUMENT;
  return PROSPERO_STATUS_NOT_AVAILABLE;
}
