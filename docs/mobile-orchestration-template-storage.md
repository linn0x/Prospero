# Mobile orchestration template storage

The mobile client stores orchestration templates in the standard SQLite database
`prospero.db`. The Android and Expo iOS builds use `expo-sqlite`; a future native Swift
client can use `SQLite3`, GRDB, or another SQLite-compatible wrapper without changing
the on-disk model.

## Schema contract

`orchestration_templates` uses only portable SQLite storage classes:

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `TEXT` | UUID primary key |
| `name` | `TEXT` | Case-insensitive user-facing name |
| `schema_version` | `INTEGER` | Version of `payload_json` |
| `payload_json` | `TEXT` | UTF-8 JSON task graph |
| `created_at_ms` | `INTEGER` | Unix epoch milliseconds |
| `updated_at_ms` | `INTEGER` | Unix epoch milliseconds |

Database migrations are namespaced in `app_schema_migrations`; the feature key is
`orchestration_templates`. Payload version 1 contains `objective` and an ordered
`nodes` array. Nodes use stable template-local keys, not daemon task IDs. Loading a
template creates fresh UUIDs and remaps dependency keys, so the same template can be
used repeatedly without colliding with an existing Run.

Future schema changes should be additive where possible. For a breaking JSON change,
increment both `schema_version` and the payload's `schemaVersion`, add a decoder for
the previous version, migrate inside a transaction, then update the feature version
in `app_schema_migrations`.
