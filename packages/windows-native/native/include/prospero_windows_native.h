#ifndef PROSPERO_WINDOWS_NATIVE_H_
#define PROSPERO_WINDOWS_NATIVE_H_

// This header is the unique C ABI for @prospero/windows-native.  It deliberately
// contains no C++ types, Node/V8 types, or implementation-owned handles.

#include <stdint.h>
#include <wchar.h>

#ifdef __cplusplus
extern "C" {
#endif

#define PROSPERO_WINDOWS_NATIVE_ABI_VERSION 1u
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
  PROSPERO_CAPABILITY_DETACHED_HOST = 1u << 3,
  PROSPERO_CAPABILITY_CONPTY = 1u << 4,
} prospero_capability;

#define PROSPERO_CAPABILITY_ALL \
  (PROSPERO_CAPABILITY_PROCESS_IDENTITY | PROSPERO_CAPABILITY_SECURE_NAMED_PIPE | \
   PROSPERO_CAPABILITY_JOB_OBJECT | PROSPERO_CAPABILITY_DETACHED_HOST | PROSPERO_CAPABILITY_CONPTY)

typedef struct prospero_capability_report {
  uint32_t abi_version;
  uint32_t napi_version;
  uint32_t capability_mask;
  uint8_t signature_verified;
} prospero_capability_report;

/** PID plus immutable process creation FILETIME (100 ns ticks since 1601 UTC). */
typedef struct prospero_process_identity {
  uint32_t pid;
  uint64_t creation_time_100ns;
} prospero_process_identity;

typedef uint64_t prospero_secure_pipe_server_handle;
typedef uint64_t prospero_job_object_handle;
typedef uint64_t prospero_conpty_handle;

/**
 * The server must use this explicit security descriptor.  Passing NULL or
 * zero bytes is invalid: implementations must never rely on a default DACL.
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

typedef struct prospero_detached_host_launch_options {
  const wchar_t* executable_path;
  const wchar_t* const* arguments;
  uint32_t argument_count;
  const wchar_t* working_directory;
  const wchar_t* environment_block;
  prospero_job_object_handle job;
  uint8_t has_job;
} prospero_detached_host_launch_options;

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

prospero_status prospero_query_capability_report(prospero_capability_report* out_report);

prospero_status prospero_get_current_process_identity(prospero_process_identity* out_identity);
prospero_status prospero_secure_pipe_server_create(
    const prospero_secure_pipe_server_options* options,
    prospero_secure_pipe_server_handle* out_server);
prospero_status prospero_secure_pipe_server_close(prospero_secure_pipe_server_handle server);
prospero_status prospero_secure_pipe_server_peer_identity(
    prospero_secure_pipe_server_handle server,
    prospero_pipe_peer_identity* out_peer);

prospero_status prospero_job_object_create(
    const prospero_job_object_options* options,
    prospero_job_object_handle* out_job);
prospero_status prospero_job_object_assign_process(
    prospero_job_object_handle job,
    prospero_process_identity process);
prospero_status prospero_job_object_terminate(prospero_job_object_handle job, uint32_t exit_code);
prospero_status prospero_job_object_close(prospero_job_object_handle job);

prospero_status prospero_detached_host_launch(
    const prospero_detached_host_launch_options* options,
    prospero_process_identity* out_process);

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

#ifdef __cplusplus
}  // extern "C"
#endif

#endif  // PROSPERO_WINDOWS_NATIVE_H_
