import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL env var.");
  process.exit(1);
}

const { Client } = await import("pg");

const schemaSql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf-8");

const client = new Client({ connectionString: DATABASE_URL });
await client.connect();
try {
  await client.query("begin");
  await client.query(schemaSql);
  await client.query("commit");
  console.log("DB migration OK.");
} catch (e) {
  await client.query("rollback");
  console.error("DB migration failed:", e?.message || e);
  process.exit(1);
} finally {
  await client.end();
}
