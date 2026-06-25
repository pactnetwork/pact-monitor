/**
 * Shared provider lookup/creation. Extracted from routes/records.ts so the
 * merchant observations route (routes/observations.ts) can use the same
 * UPSERT path without duplicating the canonical-hostname → providers.id
 * resolution.
 *
 * Callers must pass an already-canonicalized hostname; this function does
 * not normalize so the transform stays explicit at the ingest boundary.
 */
import { getOne } from "../db.js";

export async function findOrCreateProvider(hostname: string): Promise<string> {
  const existing = await getOne<{ id: string }>(
    "SELECT id FROM providers WHERE base_url = $1",
    [hostname],
  );
  if (existing) return existing.id;

  const created = await getOne<{ id: string }>(
    "INSERT INTO providers (name, base_url) VALUES ($1, $2) ON CONFLICT (base_url) DO UPDATE SET base_url = EXCLUDED.base_url RETURNING id",
    [hostname, hostname],
  );
  return created!.id;
}
