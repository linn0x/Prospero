#ifndef PROSPERO_WINDOWS_NATIVE_H_
#define PROSPERO_WINDOWS_NATIVE_H_

// This header is the unique C ABI for @prospero/windows-native. It deliberately
// contains no C++ types, Node/V8 types, or implementation-owned handles.

#include <stdint.h>
#include <wchar.h>

#ifdef __cplusplus
extern "C" {
#endif

#define PROSPERO_WINDOWS_NATIVE_ABI_VERSION 3u
#define PROSPERO_WINDOWS_NATIVE_NAPI_VERSION 8u

typedef enum prospero_status {
  PROSPERO_STATUS_OK = 0,
  PROSPERO_STATUS_INVALID_ARGUMENT = 1,
  PROSPERO_STATUS_NOT_AVAILABLE = 2,
  PROSPERO_STATUS_ACCESS_DENIED = 3,
  PROSPERO_STATUS_NOT_FOUND = 4,
  PROSPERO_STATUS_SYSTEM_ERROR = 5,
} prospero_status;

typedef enum prospero_capability {
  PROSPERO_CAPABILITY_PROCESS_IDENTITY = 1u << 0,
  PROSPERO_CAPABILITY_SECURE_NAMED_PIPE = 1u << 1,
  PROSPERO_CAPABILITY_JOB_OBJECT = 1u << 2,
  PROSPERO_CAPABILITY_PARENT_JOB_COMPATIBILITY = 1u << 3,
  PROSPERO_CAPABILITY_DETACHED_HOST = 1u << 4,
  PROSPERO_CAPABILITY_CONPTY = 1u << 5,
  PROSPERO_CAPABILITY_DPAPI_CURRENT_USER = 1u << 6,
  PROSPERO_CAPABILITY_SECURE_STATE_DIRECTORY = 1u << 7,
} prospero_capability;

#define PROSPERO_CAPABILITY_ALL \
  (PROSPERO_CAPABILITY_PROCESS_IDENTITY | PROSPERO_CAPABILITY_SECURE_NAMED_PIPE | \
   PROSPERO_CAPABILITY_JOB_OBJECT | PROSPERO_CAPABILITY_PARENT_JOB_COMPATIBILITY | \
   PROSPERO_CAPABILITY_DETACHED_HOST | PROSPERO_CAPABILITY_CONPTY | \
   PROSPERO_CAPABILITY_DPAPI_CURRENT_USER | PROSPERO_CAPABILITY_SECURE_STATE_DIRECTORY)

typedef struct prospero_capability_report {
  uint32_t abi_version;
  uint32_t napi_version;
  uint32_t capability_mask;
  // There is intentionally no signature/hash field. Only the JS loader may
  // attest to Authenticode, SHA-256, and manifest verification.
} prospero_capability_report;

/** PID plus immutable process creation FILETIME (100 ns ticks since 1601 UTC). */
typedef struct prospero_process_identity {
  uint32_t pid;
  uint64_t creation_time_100ns;
} prospero_process_identity;

typedef uint64_t prospero_secure_pipe_server_handle;
typedef uint64_t prospero_secure_pipe_connection_handle;
typedef uint64_t prospero_job_object_handle;
typedef uint64_t prospero_conpty_handle;
typedef uint64_t prospero_secure_state_directory_handle;

typedef struct prospero_owned_buffer {
  uint8_t* data;
  uint32_t length;
} prospero_owned_buffer;

/** A list of direct filenames returned from a validated state directory. */
typedef struct prospero_secure_state_entry_list {
  wchar_t** entries;
  uint32_t count;
} prospero_secure_state_entry_list;

/**
 * The server must use this explicit security descriptor. Passing NULL or zero
 * bytes is invalid. Implementations must not rely on a default DACL and must
 * pass PIPE_REJECT_REMOTE_CLIENTS to CreateNamedPipeW. TokenUser is always
 * derived by native code from the current process token; no caller-selected
 * SID may be trusted from a manifest.
 */
typedef struct prospero_secure_pipe_security {
  const void* self_relative_security_descriptor;
  uint32_t security_descriptor_bytes;
  /**
   * ABI-v2 layout reservation. It replaced no storage and must be NULL;
   * callers may not select a user SID. Native code derives TokenUser from its
   * own process token and validates the descriptor against its logon SID.
   */
  const wchar_t* reserved_legacy_allowed_user_sid;
} prospero_secure_pipe_security;

typedef struct prospero_secure_pipe_server_options {
  const wchar_t* pipe_name;
  prospero_secure_pipe_security security;
  uint32_t max_instances;
  uint32_t inbound_buffer_bytes;
  uint32_t outbound_buffer_bytes;
} prospero_secure_pipe_server_options;

typedef struct prospero_pipe_peer_identity {
  prospero_process_identity process;
  const wchar_t* user_sid;
  uint32_t session_id;
} prospero_pipe_peer_identity;

typedef struct prospero_job_object_options {
  uint8_t kill_on_close;
  uint32_t active_process_limit;
  uint8_t has_active_process_limit;
} prospero_job_object_options;

typedef struct prospero_parent_job_compatibility {
  uint8_t parent_job_detected;
  uint8_t breakaway_allowed;
  uint8_t detached_launch_allowed;
} prospero_parent_job_compatibility;

typedef struct prospero_detached_host_launch_options {
  const wchar_t* executable_path;
  /** argv entries after the boundary-generated executable-path argv[0]. */
  const wchar_t* const* arguments;
  uint32_t argument_count;
  const wchar_t* working_directory;
  const wchar_t* environment_block;
  prospero_job_object_handle job;
  uint8_t has_job;
} prospero_detached_host_launch_options;

typedef enum prospero_detached_host_launch_outcome {
  PROSPERO_DETACHED_HOST_LAUNCHED = 0,
  PROSPERO_DETACHED_HOST_PARENT_JOB_PREVENTS_DETACH = 1,
} prospero_detached_host_launch_outcome;

typedef struct prospero_detached_host_launch_result {
  prospero_detached_host_launch_outcome outcome;
  prospero_process_identity process;
  prospero_parent_job_compatibility parent_job;
} prospero_detached_host_launch_result;

typedef struct prospero_conpty_spawn_options {
  const wchar_t* executable_path;
  /** argv entries after the boundary-generated executable-path argv[0]. */
  const wchar_t* const* arguments;
  uint32_t argument_count;
  uint16_t columns;
  uint16_t rows;
  const wchar_t* working_directory;
  const wchar_t* environment_block;
  prospero_job_object_handle job;
  uint8_t has_job;
} prospero_conpty_spawn_options;

typedef struct prospero_secure_state_directory_options {
  const wchar_t* absolute_path;
} prospero_secure_state_directory_options;

/** Native-only diagnostic stage for the most recent atomic state write on the calling thread. */
typedef enum prospero_secure_state_write_stage {
  PROSPERO_SECURE_STATE_WRITE_STAGE_NONE = 0,
  PROSPERO_SECURE_STATE_WRITE_STAGE_VALIDATE = 1,
  PROSPERO_SECURE_STATE_WRITE_STAGE_DIRECTORY = 2,
  PROSPERO_SECURE_STATE_WRITE_STAGE_TARGET = 3,
  PROSPERO_SECURE_STATE_WRITE_STAGE_CREATE_TEMPORARY = 4,
  PROSPERO_SECURE_STATE_WRITE_STAGE_VERIFY_TEMPORARY = 5,
  PROSPERO_SECURE_STATE_WRITE_STAGE_WRITE = 6,
  PROSPERO_SECURE_STATE_WRITE_STAGE_FLUSH = 7,
  PROSPERO_SECURE_STATE_WRITE_STAGE_RENAME = 8,
  PROSPERO_SECURE_STATE_WRITE_STAGE_CLEANUP = 9,
} prospero_secure_state_write_stage;

/**
 * A path/content-free category for the last native atomic-write OS failure.
 * It is useful for diagnostics without exposing a state location, filename,
 * bytes, or a raw Win32/NT status value.
 */
typedef enum prospero_secure_state_write_error_category {
  PROSPERO_SECURE_STATE_WRITE_ERROR_NONE = 0,
  PROSPERO_SECURE_STATE_WRITE_ERROR_ACCESS_DENIED = 1,
  PROSPERO_SECURE_STATE_WRITE_ERROR_INVALID_PARAMETER = 2,
  PROSPERO_SECURE_STATE_WRITE_ERROR_NOT_FOUND = 3,
  PROSPERO_SECURE_STATE_WRITE_ERROR_SHARING_VIOLATION = 4,
  PROSPERO_SECURE_STATE_WRITE_ERROR_OTHER = 5,
  PROSPERO_SECURE_STATE_WRITE_ERROR_NOT_SAME_DEVICE = 6,
  PROSPERO_SECURE_STATE_WRITE_ERROR_NOT_SUPPORTED = 7,
} prospero_secure_state_write_error_category;

prospero_status prospero_query_capability_report(prospero_capability_report* out_report);

prospero_status prospero_get_current_process_identity(prospero_process_identity* out_identity);
prospero_status prospero_get_process_identity(uint32_t pid, prospero_process_identity* out_identity);
/** True only when a freshly opened process has both the requested PID and FILETIME. */
prospero_status prospero_process_identity_matches(
    prospero_process_identity expected,
    uint8_t* out_matches);
/**
 * Terminates and waits for precisely `expected`; a missing or
 * FILETIME-mismatched process reports `out_terminated = 0`, while access
 * denial remains an error rather than a false rollback claim. It never falls
 * back to a PID-only operation.
 */
prospero_status prospero_terminate_process_if_identity(
    prospero_process_identity expected,
    uint32_t exit_code,
    uint32_t timeout_ms,
    uint8_t* out_terminated);

prospero_status prospero_secure_pipe_server_create(
    const prospero_secure_pipe_server_options* options,
    prospero_secure_pipe_server_handle* out_server);
/** Blocks until a local client is accepted and returns a separate connection handle. */
prospero_status prospero_secure_pipe_server_accept(
    prospero_secure_pipe_server_handle server,
    prospero_secure_pipe_connection_handle* out_connection);
prospero_status prospero_secure_pipe_server_close(prospero_secure_pipe_server_handle server);
prospero_status prospero_secure_pipe_connection_read(
    prospero_secure_pipe_connection_handle connection,
    uint8_t* buffer,
    uint32_t capacity,
    uint32_t* out_read);
prospero_status prospero_secure_pipe_connection_write(
    prospero_secure_pipe_connection_handle connection,
    const uint8_t* buffer,
    uint32_t length,
    uint32_t* out_written);
prospero_status prospero_secure_pipe_connection_peer_identity(
    prospero_secure_pipe_connection_handle connection,
    prospero_pipe_peer_identity* out_peer);
prospero_status prospero_secure_pipe_connection_disconnect(
    prospero_secure_pipe_connection_handle connection);
prospero_status prospero_secure_pipe_connection_close(prospero_secure_pipe_connection_handle connection);

prospero_status prospero_job_object_create(
    const prospero_job_object_options* options,
    prospero_job_object_handle* out_job);
prospero_status prospero_job_object_assign_process(
    prospero_job_object_handle job,
    prospero_process_identity process);
/** Revalidates PID+FILETIME, then audits membership in this exact Job. */
prospero_status prospero_job_object_contains_process(
    prospero_job_object_handle job,
    prospero_process_identity process,
    uint8_t* out_contains);
prospero_status prospero_job_object_terminate(prospero_job_object_handle job, uint32_t exit_code);
prospero_status prospero_job_object_close(prospero_job_object_handle job);
/**
 * Queries whether the caller is in any Job and the immediate Job's breakaway
 * limit flags. Nested ancestor policy is verified on the suspended child by
 * the detached launcher before it reports success.
 */
prospero_status prospero_query_parent_job_compatibility(
    prospero_parent_job_compatibility* out_compatibility);

prospero_status prospero_detached_host_launch(
    const prospero_detached_host_launch_options* options,
    prospero_detached_host_launch_result* out_result);

prospero_status prospero_conpty_spawn(
    const prospero_conpty_spawn_options* options,
    prospero_conpty_handle* out_terminal);
prospero_status prospero_conpty_resize(prospero_conpty_handle terminal, uint16_t columns, uint16_t rows);
prospero_status prospero_conpty_read(
    prospero_conpty_handle terminal,
    uint8_t* buffer,
    uint32_t capacity,
    uint32_t* out_read);
/**
 * Writes the caller's raw terminal bytes to ConPTY without character encoding
 * or newline translation. A product-facing cross-platform facade owns any
 * mapping such as terminal Enter (normally '\r' on Windows).
 */
prospero_status prospero_conpty_write(
    prospero_conpty_handle terminal,
    const uint8_t* buffer,
    uint32_t length,
    uint32_t* out_written);
prospero_status prospero_conpty_kill(prospero_conpty_handle terminal, uint32_t exit_code);
prospero_status prospero_conpty_close(prospero_conpty_handle terminal);

/** CryptProtectData / CryptUnprotectData in CRYPTPROTECT_UI_FORBIDDEN current-user scope. */
prospero_status prospero_dpapi_current_user_protect(
    const uint8_t* plaintext,
    uint32_t plaintext_length,
    const uint8_t* optional_entropy,
    uint32_t optional_entropy_length,
    prospero_owned_buffer* out_ciphertext);
prospero_status prospero_dpapi_current_user_unprotect(
    const uint8_t* ciphertext,
    uint32_t ciphertext_length,
    const uint8_t* optional_entropy,
    uint32_t optional_entropy_length,
    prospero_owned_buffer* out_plaintext);
/** Releases a buffer allocated by this ABI (for example, with LocalFree). */
prospero_status prospero_owned_buffer_release(prospero_owned_buffer* buffer);

/**
 * Opens/creates a current-user-only state directory by walking components with
 * FILE_FLAG_OPEN_REPARSE_POINT and rejecting any reparse point. Its DACL must
 * contain an explicit current-user ACE; inherited/default ACLs are forbidden.
 */
prospero_status prospero_secure_state_directory_open(
    const prospero_secure_state_directory_options* options,
    prospero_secure_state_directory_handle* out_directory);
/**
 * Atomically replaces a single relative filename in the validated directory.
 * The implementation must create the temporary file in that same directory,
 * reject reparse points, flush it, and use a write-through replacement.
 */
prospero_status prospero_secure_state_directory_write_atomic(
    prospero_secure_state_directory_handle directory,
    const wchar_t* file_name,
    const uint8_t* data,
    uint32_t length);
/**
 * Returns a stage label only; it intentionally exposes no filesystem path,
 * filename, data, or OS error details. It is valid immediately after a write
 * on the same thread.
 */
prospero_secure_state_write_stage prospero_secure_state_directory_last_write_stage(void);
/**
 * Returns only a coarse Win32 error category for the last write on this
 * thread. It intentionally exposes no state path, filename, bytes, or raw OS
 * error value.
 */
prospero_secure_state_write_error_category
prospero_secure_state_directory_last_write_error_category(void);
/**
 * Reads one direct state-file name. `file_name` must be a non-empty single
 * segment: no dot segment, separator, ADS colon, DOS device name, or reparse
 * point is permitted. The caller releases `out_data` with
 * prospero_owned_buffer_release().
 */
prospero_status prospero_secure_state_directory_read(
    prospero_secure_state_directory_handle directory,
    const wchar_t* file_name,
    prospero_owned_buffer* out_data);
/**
 * Enumerates only direct, non-reparse state files. The caller releases
 * `out_entries` with prospero_secure_state_entry_list_release().
 */
prospero_status prospero_secure_state_directory_list(
    prospero_secure_state_directory_handle directory,
    prospero_secure_state_entry_list* out_entries);
/** Removes one direct state-file name after the same strict name/reparse checks. */
prospero_status prospero_secure_state_directory_remove(
    prospero_secure_state_directory_handle directory,
    const wchar_t* file_name);
void prospero_secure_state_entry_list_release(
    prospero_secure_state_entry_list* entries);
prospero_status prospero_secure_state_directory_close(
    prospero_secure_state_directory_handle directory);

#ifdef __cplusplus
}  // extern "C"
#endif

#endif  // PROSPERO_WINDOWS_NATIVE_H_
