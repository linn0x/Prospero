#include "prospero_windows_native.h"

extern "C" prospero_status prospero_dpapi_current_user_protect(
    const uint8_t* plaintext,
    uint32_t plaintext_length,
    const uint8_t* optional_entropy,
    uint32_t optional_entropy_length,
    prospero_owned_buffer* out_ciphertext) {
  (void)optional_entropy;
  if (plaintext == nullptr || plaintext_length == 0 ||
      (optional_entropy == nullptr && optional_entropy_length != 0) ||
      out_ciphertext == nullptr) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  // Production uses CryptProtectData with CRYPTPROTECT_UI_FORBIDDEN and does
  // not set CRYPTPROTECT_LOCAL_MACHINE, keeping ciphertext current-user scoped.
  out_ciphertext->data = nullptr;
  out_ciphertext->length = 0;
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_dpapi_current_user_unprotect(
    const uint8_t* ciphertext,
    uint32_t ciphertext_length,
    const uint8_t* optional_entropy,
    uint32_t optional_entropy_length,
    prospero_owned_buffer* out_plaintext) {
  (void)optional_entropy;
  if (ciphertext == nullptr || ciphertext_length == 0 ||
      (optional_entropy == nullptr && optional_entropy_length != 0) ||
      out_plaintext == nullptr) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  out_plaintext->data = nullptr;
  out_plaintext->length = 0;
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_owned_buffer_release(prospero_owned_buffer* buffer) {
  if (buffer == nullptr) return PROSPERO_STATUS_INVALID_ARGUMENT;
  // Production frees only ABI-owned LocalAlloc buffers and clears both fields.
  if (buffer->data != nullptr || buffer->length != 0) return PROSPERO_STATUS_NOT_AVAILABLE;
  return PROSPERO_STATUS_OK;
}
