#ifndef PROSPERO_WINDOWS_NATIVE_H_
#define PROSPERO_WINDOWS_NATIVE_H_

// This header is the unique C ABI for @prospero/windows-native. It deliberately
// contains no C++ types, Node/V8 types, or implementation-owned handles.

#include <stdint.h>
#include <wchar.h>

#ifdef __cplusplus
extern "C" {
#endif

#define PROSPERO_WINDOWS_NATIVE_ABI_VERSION 2u
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
 * pass PIPE_REJECT_REMOTE_CLIENTS to CreateNamedPipeW.
 */
typedef struct prospero_secure_pipe_security {
  const void* self_relative_security_descriptor;
  uint32_t security_descriptor_bytes;
  const wchar_t* allowed_user_sid;
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

prospero_status prospero_query_capability_report(prospero_capability_report* out_report);

prospero_status prospero_get_current_process_identity(prospero_process_identity* out_identity);
prospero_status prospero_get_process_identity(uint32_t pid, prospero_process_identity* out_identity);
/** True only when a freshly opened process has both the requested PID and FILETIME. */
prospero_status prospero_process_identity_matches(
    prospero_process_identity expected,
    uint8_t* out_matches);

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
prospero_status prospero_job_object_terminate(prospero_job_object_handle job, uint32_t exit_code);
prospero_status prospero_job_object_close(prospero_job_object_handle job);
/** Queries IsProcessInJob and the parent Job's breakaway limit flags. */
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
