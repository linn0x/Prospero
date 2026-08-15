#include "prospero_windows_native.h"

#if defined(_WIN32)

#include <windows.h>
#include <wincrypt.h>

namespace {

prospero_status StatusFromLastError(DWORD error) {
  switch (error) {
    case ERROR_ACCESS_DENIED:
      return PROSPERO_STATUS_ACCESS_DENIED;
    case ERROR_INVALID_PARAMETER:
      return PROSPERO_STATUS_INVALID_ARGUMENT;
    case ERROR_FILE_NOT_FOUND:
      return PROSPERO_STATUS_NOT_FOUND;
    default:
      return PROSPERO_STATUS_SYSTEM_ERROR;
  }
}

bool IsValidInput(const uint8_t* data,
                  uint32_t length,
                  const uint8_t* entropy,
                  uint32_t entropy_length,
                  prospero_owned_buffer* output) {
  return data != nullptr && length != 0 &&
         (entropy != nullptr || entropy_length == 0) && output != nullptr;
}

void ClearOwnedBuffer(prospero_owned_buffer* buffer) {
  if (buffer == nullptr) return;
  buffer->data = nullptr;
  buffer->length = 0;
}

DATA_BLOB BlobFrom(const uint8_t* data, uint32_t length) {
  DATA_BLOB blob{};
  blob.cbData = length;
  blob.pbData = const_cast<BYTE*>(reinterpret_cast<const BYTE*>(data));
  return blob;
}

}  // namespace

extern "C" prospero_status prospero_dpapi_current_user_protect(
    const uint8_t* plaintext,
    uint32_t plaintext_length,
    const uint8_t* optional_entropy,
    uint32_t optional_entropy_length,
    prospero_owned_buffer* out_ciphertext) {
  ClearOwnedBuffer(out_ciphertext);
  if (!IsValidInput(plaintext, plaintext_length, optional_entropy,
                    optional_entropy_length, out_ciphertext)) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }

  DATA_BLOB input = BlobFrom(plaintext, plaintext_length);
  DATA_BLOB entropy = BlobFrom(optional_entropy, optional_entropy_length);
  DATA_BLOB output{};
  // CRYPTPROTECT_LOCAL_MACHINE is deliberately absent: this is strictly the
  // current-user DPAPI scope. The N-API bridge requires a non-empty
  // session/epoch entropy value so a ciphertext cannot be replayed elsewhere.
  if (!CryptProtectData(&input, nullptr,
                        optional_entropy_length == 0 ? nullptr : &entropy,
                        nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &output)) {
    const prospero_status status = StatusFromLastError(GetLastError());
    if (output.pbData != nullptr) {
      SecureZeroMemory(output.pbData, output.cbData);
      LocalFree(output.pbData);
    }
    ClearOwnedBuffer(out_ciphertext);
    return status;
  }
  if (output.pbData == nullptr || output.cbData == 0) {
    if (output.pbData != nullptr) {
      SecureZeroMemory(output.pbData, output.cbData);
      LocalFree(output.pbData);
    }
    return PROSPERO_STATUS_SYSTEM_ERROR;
  }
  out_ciphertext->data = reinterpret_cast<uint8_t*>(output.pbData);
  out_ciphertext->length = output.cbData;
  return PROSPERO_STATUS_OK;
}

extern "C" prospero_status prospero_dpapi_current_user_unprotect(
    const uint8_t* ciphertext,
    uint32_t ciphertext_length,
    const uint8_t* optional_entropy,
    uint32_t optional_entropy_length,
    prospero_owned_buffer* out_plaintext) {
  ClearOwnedBuffer(out_plaintext);
  if (!IsValidInput(ciphertext, ciphertext_length, optional_entropy,
                    optional_entropy_length, out_plaintext)) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }

  DATA_BLOB input = BlobFrom(ciphertext, ciphertext_length);
  DATA_BLOB entropy = BlobFrom(optional_entropy, optional_entropy_length);
  DATA_BLOB output{};
  if (!CryptUnprotectData(&input, nullptr,
                          optional_entropy_length == 0 ? nullptr : &entropy,
                          nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &output)) {
    const prospero_status status = StatusFromLastError(GetLastError());
    if (output.pbData != nullptr) {
      SecureZeroMemory(output.pbData, output.cbData);
      LocalFree(output.pbData);
    }
    ClearOwnedBuffer(out_plaintext);
    return status;
  }
  if (output.pbData == nullptr || output.cbData == 0) {
    if (output.pbData != nullptr) {
      SecureZeroMemory(output.pbData, output.cbData);
      LocalFree(output.pbData);
    }
    return PROSPERO_STATUS_SYSTEM_ERROR;
  }
  out_plaintext->data = reinterpret_cast<uint8_t*>(output.pbData);
  out_plaintext->length = output.cbData;
  return PROSPERO_STATUS_OK;
}

extern "C" prospero_status prospero_owned_buffer_release(prospero_owned_buffer* buffer) {
  if (buffer == nullptr) return PROSPERO_STATUS_INVALID_ARGUMENT;
  if (buffer->data != nullptr) {
    SecureZeroMemory(buffer->data, buffer->length);
  }
  const HLOCAL release = buffer->data == nullptr ? nullptr : LocalFree(buffer->data);
  const prospero_status status = release == nullptr ? PROSPERO_STATUS_OK : PROSPERO_STATUS_SYSTEM_ERROR;
  ClearOwnedBuffer(buffer);
  return status;
}

#else

extern "C" prospero_status prospero_dpapi_current_user_protect(
    const uint8_t* plaintext,
    uint32_t plaintext_length,
    const uint8_t* optional_entropy,
    uint32_t optional_entropy_length,
    prospero_owned_buffer* out_ciphertext) {
  if (out_ciphertext != nullptr) {
    out_ciphertext->data = nullptr;
    out_ciphertext->length = 0;
  }
  if (plaintext == nullptr || plaintext_length == 0 ||
      (optional_entropy == nullptr && optional_entropy_length != 0) ||
      out_ciphertext == nullptr) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_dpapi_current_user_unprotect(
    const uint8_t* ciphertext,
    uint32_t ciphertext_length,
    const uint8_t* optional_entropy,
    uint32_t optional_entropy_length,
    prospero_owned_buffer* out_plaintext) {
  if (out_plaintext != nullptr) {
    out_plaintext->data = nullptr;
    out_plaintext->length = 0;
  }
  if (ciphertext == nullptr || ciphertext_length == 0 ||
      (optional_entropy == nullptr && optional_entropy_length != 0) ||
      out_plaintext == nullptr) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_owned_buffer_release(prospero_owned_buffer* buffer) {
  if (buffer == nullptr) return PROSPERO_STATUS_INVALID_ARGUMENT;
  buffer->data = nullptr;
  buffer->length = 0;
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

#endif
