// Tally webhook receiver for the private beta gate.
// Tally posts JSON to POST /api/v1/beta/apply and signs the raw body with
// HMAC-SHA256(TALLY_WEBHOOK_SECRET), sending the hex digest in the
// `tally-signature` header. We verify the signature against the raw bytes
// before parsing, persist the applicant idempotently on `tally_submission_id`,
// and fire-and-forget a Telegram notification to the Pact Ops chat.

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
const FIELD_MAP: Array<{ test: RegExp; column: keyof Applicant }> = [
  { test: /(what.*building|whatbuilding|building)/i, column: "what_building" },
  { test: /(urgency|when.*integrate|timeline|timing)/i, column: "urgency" },
  { test: /(email|e-mail)/i, column: "email" },
  { test: /(x.?handle|twitter|x.com)/i, column: "x_handle" },
  { test: /(telegram|t\.me)/i, column: "telegram_handle" },
  { test: /(wallet|solana.*address|sol.*pubkey)/i, column: "wallet_pubkey" },
  { test: /(apis|paying|currently)/i, column: "apis_currently_paying" },
];

type Applicant = {
  email: string | null;
  x_handle: string | null;
  telegram_handle: string | null;
  wallet_pubkey: string | null;
  what_building: string | null;
  urgency: string | null;
  apis_currently_paying: string | null;
};

function extractFields(payload: TallyPayload): Applicant {
  const out: Applicant = {
    email: null,
    x_handle: null,
    telegram_handle: null,
    wallet_pubkey: null,
    what_building: null,
    urgency: null,
    apis_currently_paying: null,
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

function verifyTallySignature(rawBody: Buffer, signatureHex: string, secret: string): boolean {
  if (!signatureHex || !secret) return false;
  // Pre-filter on the hex alphabet so malformed input is rejected before
  // it ever touches the HMAC compare. `Buffer.from(hex)` silently truncates
  // on the first non-hex byte instead of throwing, so without this guard a
  // signature like "deadbe??" would parse to 3 valid bytes and only get
  // rejected later by the length compare.
  if (!/^[0-9a-fA-F]+$/.test(signatureHex)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const provided = Buffer.from(signatureHex, "hex");
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
        what_building, urgency, apis_currently_paying, tally_submission_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        applicant.email,
        applicant.x_handle,
        applicant.telegram_handle,
        applicant.wallet_pubkey,
        applicant.what_building,
        applicant.urgency,
        applicant.apis_currently_paying,
        submissionId,
      ],
    );

    const contact =
      applicant.email || applicant.x_handle || applicant.telegram_handle || "(no contact)";
    notifyTelegram(
      [
        "New Pact beta application",
        `id: ${id}`,
        `building: ${applicant.what_building ?? "(unspecified)"}`,
        `urgency: ${applicant.urgency ?? "(unspecified)"}`,
        `contact: ${contact}`,
      ].join("\n"),
    );

    return reply.code(201).send({ id, status: "received" });
  });
}
