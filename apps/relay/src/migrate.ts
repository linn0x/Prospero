import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createPool, type RowDataPacket } from "mysql2/promise";
import { readConfig } from "./config.js";

export async function runMigrations(mysqlUrl: string, migrationDir: string): Promise<void> {
  const pool = createPool({ uri: mysqlUrl, connectionLimit: 1, timezone: "Z" });
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
      applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB`);
    const files = (await readdir(migrationDir)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
    for (const file of files) {
      const [existing] = await pool.execute<(RowDataPacket & { version: string })[]>("SELECT version FROM schema_migrations WHERE version = ?", [file]);
      if (existing.length > 0) continue;
      const sql = await readFile(join(migrationDir, file), "utf8");
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        for (const statement of sql.split(/;\s*(?:\r?\n|$)/).map((part) => part.trim()).filter(Boolean)) {
          await connection.query(statement);
        }
        await connection.execute("INSERT INTO schema_migrations (version) VALUES (?)", [file]);
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    }
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const config = readConfig();
  await runMigrations(config.mysqlUrl, config.migrationDir);
  process.stdout.write("migrations complete\n");
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`migration failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
