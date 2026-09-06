import { randomUUID } from "expo-crypto";
import * as SQLite from "expo-sqlite";

import {
  decodeOrchestrationTemplatePayload,
  ORCHESTRATION_TEMPLATE_SCHEMA_VERSION,
  type OrchestrationTemplate,
  type OrchestrationTemplatePayloadV1,
} from "@/lib/orchestration-template";

export const ORCHESTRATION_DATABASE_NAME = "prospero.db";
export const ORCHESTRATION_TEMPLATE_TABLE = "orchestration_templates";
export const ORCHESTRATION_TEMPLATE_STORAGE_VERSION = 1;

interface TemplateRow {
  id: string;
  name: string;
  schema_version: number;
  payload_json: string;
  created_at_ms: number;
  updated_at_ms: number;
}

let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;

async function openDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (databasePromise === null) {
    databasePromise = SQLite.openDatabaseAsync(ORCHESTRATION_DATABASE_NAME)
      .then(async (database) => {
        await database.execAsync(`
          PRAGMA journal_mode = WAL;
          CREATE TABLE IF NOT EXISTS app_schema_migrations (
            feature TEXT PRIMARY KEY NOT NULL,
            version INTEGER NOT NULL,
            applied_at_ms INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS ${ORCHESTRATION_TEMPLATE_TABLE} (
            id TEXT PRIMARY KEY NOT NULL,
            name TEXT NOT NULL COLLATE NOCASE,
            schema_version INTEGER NOT NULL,
            payload_json TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL
          );
          CREATE UNIQUE INDEX IF NOT EXISTS orchestration_templates_name
            ON ${ORCHESTRATION_TEMPLATE_TABLE}(name COLLATE NOCASE);
          CREATE INDEX IF NOT EXISTS orchestration_templates_updated_at
            ON ${ORCHESTRATION_TEMPLATE_TABLE}(updated_at_ms DESC);
          INSERT INTO app_schema_migrations(feature, version, applied_at_ms)
            VALUES (
              'orchestration_templates',
              ${String(ORCHESTRATION_TEMPLATE_STORAGE_VERSION)},
              CAST(strftime('%s', 'now') AS INTEGER) * 1000
            )
            ON CONFLICT(feature) DO NOTHING;
        `);
        return database;
      })
      .catch((error: unknown) => {
        databasePromise = null;
        throw error;
      });
  }
  return databasePromise;
}

function rowToTemplate(row: TemplateRow): OrchestrationTemplate | null {
  if (row.schema_version !== ORCHESTRATION_TEMPLATE_SCHEMA_VERSION) return null;
  const payload = decodeOrchestrationTemplatePayload(row.payload_json);
  if (payload === null) return null;
  return {
    id: row.id,
    name: row.name,
    payload,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

export async function listOrchestrationTemplates(): Promise<OrchestrationTemplate[]> {
  const database = await openDatabase();
  const rows = await database.getAllAsync<TemplateRow>(
    `SELECT id, name, schema_version, payload_json, created_at_ms, updated_at_ms
       FROM ${ORCHESTRATION_TEMPLATE_TABLE}
      ORDER BY updated_at_ms DESC, name COLLATE NOCASE ASC`,
  );
  return rows.flatMap((row) => {
    const template = rowToTemplate(row);
    return template === null ? [] : [template];
  });
}

export async function saveOrchestrationTemplate(
  name: string,
  payload: OrchestrationTemplatePayloadV1,
): Promise<OrchestrationTemplate> {
  const database = await openDatabase();
  const normalizedName = name.trim();
  const now = Date.now();
  const existing = await database.getFirstAsync<Pick<TemplateRow, "id" | "created_at_ms">>(
    `SELECT id, created_at_ms
       FROM ${ORCHESTRATION_TEMPLATE_TABLE}
      WHERE name = ? COLLATE NOCASE`,
    normalizedName,
  );
  const id = existing?.id ?? randomUUID();
  const createdAtMs = existing?.created_at_ms ?? now;
  await database.runAsync(
    `INSERT INTO ${ORCHESTRATION_TEMPLATE_TABLE}
       (id, name, schema_version, payload_json, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       schema_version = excluded.schema_version,
       payload_json = excluded.payload_json,
       updated_at_ms = excluded.updated_at_ms`,
    id,
    normalizedName,
    ORCHESTRATION_TEMPLATE_SCHEMA_VERSION,
    JSON.stringify(payload),
    createdAtMs,
    now,
  );
  return { id, name: normalizedName, payload, createdAtMs, updatedAtMs: now };
}

export async function deleteOrchestrationTemplate(id: string): Promise<void> {
  const database = await openDatabase();
  await database.runAsync(
    `DELETE FROM ${ORCHESTRATION_TEMPLATE_TABLE} WHERE id = ?`,
    id,
  );
}
