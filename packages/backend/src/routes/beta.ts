// Tally webhook receiver for the private beta gate.
// Tally posts JSON to POST /api/v1/beta/apply and signs the body with
// HMAC-SHA256(TALLY_WEBHOOK_SECRET), sending the BASE64 digest in the
// `tally-signature` header (case-insensitive). Tally's signing input is
// the JSON-serialized payload that it then sends on the wire, so verifying
// against `request.body` as a raw Buffer matches what Tally signed.
// We verify before parsing, persist the applicant idempotently on
// `tally_submission_id`, and fire-and-forget a Telegram notification.

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getOne, query } from "../db.js";

type TallyField = {
  key?: string;
  label?: string;
  type?: string;
  value?: unknown;
};

type TallyPayload = {
  eventId?: string;
  eventType?: string;
  data?: {
    submissionId?: string;
    formId?: string;
    fields?: TallyField[];
  };
};

// Maps a Tally field label/key to a beta_applicants column. The match is
// case-insensitive and ignores whitespace/punctuation so a question like
// "What are you building?" still matches whether Tally hands us
// `what_are_you_building`, `whatBuilding`, or the raw label.
//
// Patterns match the published form at tally.so/r/9qRXzQ. The labels in
// the form's TITLE.safeHTMLSchema were inspected to derive the regex
// (see schema.sql comment above the beta_applicants ALTERs).
//
// Order matters: more specific patterns first. The loop in extractFields
// stops at the first match. The display_name pattern is intentionally
// placed before email/x/telegram so "How can we call you?" doesn't get
// swallowed by a generic name-shaped regex if we ever add one.
const FIELD_MAP: Array<{ test: RegExp; column: keyof Applicant }> = [
  { test: /(what.*building|whatbuilding|building)/i, column: "what_building" },
  { test: /(how.*can.*we.*call|call.*you|display.*name|your.*name)/i, column: "display_name" },
  { test: /(urgency|when.*integrate|timeline|timing)/i, column: "urgency" },
  { test: /(email|e-mail)/i, column: "email" },
  { test: /(x.?handle|twitter|x.com)/i, column: "x_handle" },
  { test: /(telegram|t\.me)/i, column: "telegram_handle" },
  { test: /(wallet|solana.*address|sol.*pubkey)/i, column: "wallet_pubkey" },
  { test: /(which.*of.*these|are.*you.*an?\b|persona|role)/i, column: "persona" },
  { test: /(apis.*pay|currently.*pay|paying.*for|which.*apis)/i, column: "apis_currently_paying" },
  { test: /(why.*pact|why.*considering|why.*try)/i, column: "why_pact" },
  { test: /(feedback|early.*tester|provide.*feedback)/i, column: "willing_to_feedback" },
];

type Applicant = {
  email: string | null;
  x_handle: string | null;
  telegram_handle: string | null;
  wallet_pubkey: string | null;
  what_building: string | null;
  display_name: string | null;
  urgency: string | null;
  persona: string | null;
  apis_currently_paying: string | null;
  why_pact: string | null;
  willing_to_feedback: string | null;
};

function extractFields(payload: TallyPayload): Applicant {
  const out: Applicant = {
    email: null,
    x_handle: null,
    telegram_handle: null,
    wallet_pubkey: null,
    what_building: null,
    display_name: null,
    urgency: null,
    persona: null,
    apis_currently_paying: null,
    why_pact: null,
    willing_to_feedback: null,
  };
  const fields = payload.data?.fields ?? [];
  for (const f of fields) {
    const probe = [f.key, f.label].filter(Boolean).join(" ");
    const value = stringifyValue(f.value);
    if (value === null) continue;
    for (const { test, column } of FIELD_MAP) {
      if (test.test(probe)) {
        out[column] ??= value;
        break;
      }
    }
  }
  return out;
}

function stringifyValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    const joined = v.map(stringifyValue).filter(Boolean).join(", ");
    return joined || null;
  }
  return null;
}

function verifyTallySignature(rawBody: Buffer, signatureB64: string, secret: string): boolean {
  if (!signatureB64 || !secret) return false;
  // Pre-filter on the base64 alphabet so malformed input is rejected before
  // it ever touches the HMAC compare. `Buffer.from(s, "base64")` silently
  // skips invalid characters instead of throwing, so without this guard a
  // signature like "deadbe??" would parse to a short buffer and only get
  // rejected later by the length check.
  if (!/^[A-Za-z0-9+/]+=*$/.test(signatureB64)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const provided = Buffer.from(signatureB64, "base64");
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

// Fires the Telegram message without awaiting. Caller MUST NOT await the
// return — Telegram outages must not 500 the webhook.
function notifyTelegram(summary: string): void {
  const token = process.env.BETA_TELEGRAM_BOT_TOKEN;
  const chatId = process.env.BETA_TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: summary }),
  }).catch((err) => {
    // Surface Telegram outages in logs so the ops team can spot a dead
    // notification channel; never re-throw — this path is telemetry-only
    // and must not affect the webhook response.
    console.warn("[beta] telegram notify failed", err instanceof Error ? err.message : err);
  });
}

export async function betaRoutes(app: FastifyInstance): Promise<void> {
  // Scope a raw-body parser to this plugin so the rest of the backend keeps
  // its parsed-JSON behavior. Fastify encapsulates `addContentTypeParser`
  // when the plugin is registered via `app.register` WITHOUT a
  // `fastify-plugin` wrapper. **DO NOT** wrap `betaRoutes` in `fp(...)` —
  // doing so would lift the buffer parser into the parent context and
  // every other JSON route in the app would start receiving `Buffer`
  // request bodies instead of objects.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_req, body, done) => {
      done(null, body);
    },
  );

  app.post("/api/v1/beta/apply", async (request, reply) => {
    const secret = process.env.TALLY_WEBHOOK_SECRET ?? "";
    if (!secret) {
      // Refuse to operate without a configured secret. Returning 503 makes
      // the misconfiguration visible to Tally's retry queue + monitoring.
      return reply.code(503).send({ error: "Tally webhook not configured" });
    }

    const rawBody = request.body as Buffer | undefined;
    if (!rawBody || rawBody.length === 0) {
      return reply.code(400).send({ error: "Empty body" });
    }

    const signature = (request.headers["tally-signature"] as string | undefined) ?? "";
    if (!verifyTallySignature(rawBody, signature, secret)) {
      return reply.code(401).send({ error: "Invalid signature" });
    }

    let payload: TallyPayload;
    try {
      payload = JSON.parse(rawBody.toString("utf8")) as TallyPayload;
    } catch {
      return reply.code(400).send({ error: "Malformed JSON" });
    }

    const submissionId = payload.data?.submissionId;
    if (!submissionId || typeof submissionId !== "string") {
      return reply.code(400).send({ error: "Missing submissionId" });
    }

    // Idempotent: same submission id → same row, no double-insert, no
    // double Telegram notify.
    const existing = await getOne<{ id: string }>(
      "SELECT id FROM beta_applicants WHERE tally_submission_id = $1",
      [submissionId],
    );
    if (existing) {
      return reply.send({ id: existing.id, status: "duplicate" });
    }

    const applicant = extractFields(payload);
    const id = randomUUID();
    await query(
      `INSERT INTO beta_applicants (
        id, email, x_handle, telegram_handle, wallet_pubkey,
        what_building, display_name, urgency, persona,
        apis_currently_paying, why_pact, willing_to_feedback,
        tally_submission_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        id,
        applicant.email,
        applicant.x_handle,
        applicant.telegram_handle,
        applicant.wallet_pubkey,
        applicant.what_building,
        applicant.display_name,
        applicant.urgency,
        applicant.persona,
        applicant.apis_currently_paying,
        applicant.why_pact,
        applicant.willing_to_feedback,
        submissionId,
      ],
    );

    const contact =
      applicant.email || applicant.x_handle || applicant.telegram_handle || "(no contact)";
    const lines = [
      "New Pact beta application",
      `id: ${id}`,
      `name: ${applicant.display_name ?? "(unspecified)"}`,
      `persona: ${applicant.persona ?? "(unspecified)"}`,
      `building: ${applicant.what_building ?? "(unspecified)"}`,
      `contact: ${contact}`,
    ];
    if (applicant.apis_currently_paying) {
      lines.push(`current APIs: ${applicant.apis_currently_paying}`);
    }
    if (applicant.why_pact) lines.push(`why pact: ${applicant.why_pact}`);
    if (applicant.willing_to_feedback) {
      lines.push(`early-tester opt-in: ${applicant.willing_to_feedback}`);
    }
    notifyTelegram(lines.join("\n"));

    return reply.code(201).send({ id, status: "received" });
  });
}
