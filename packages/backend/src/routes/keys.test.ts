import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import Fastify from "fastify";
import { initDb, query } from "../db.js";
import {
  __resetNetworkCacheForTests,
  __setNetworkCacheForTests,
} from "../utils/network.js";
import { keysRoutes } from "./keys.js";

async function buildApp() {
  const app = Fastify();
  await app.register(keysRoutes);
  return app;
}

// Mirror of buildChallengeMessage() in keys.ts. Kept inline so a breaking
// change to the message format causes this test to fail loudly instead of
// silently following along.
function sign(kp: Keypair, nonce: string, agentPubkey: string): string {
  const message = [
    "Pact Network self-serve API key issuance",
    `Agent: ${agentPubkey}`,
    `Nonce: ${nonce}`,
  ].join("\n");
  const sigBytes = nacl.sign.detached(
    new TextEncoder().encode(message),
    kp.secretKey,
  );
  return Buffer.from(sigBytes).toString("base64");
}

describe("self-serve API key issuance with signed challenge (PR 50 codex)", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const SUITE_TAG = `keys-test-${randomUUID().slice(0, 8)}`;

  before(async () => {
    await initDb();
    app = await buildApp();
  });

  after(async () => {
    await query(
      "DELETE FROM api_keys WHERE label LIKE $1",
      [`self-serve-%`],
    );
    await query("DELETE FROM api_key_challenges WHERE expires_at < NOW()");
    await app.close();
    // No pool.end() — module-scoped pool is shared with sibling test files.
  });

  beforeEach(() => {
    __resetNetworkCacheForTests();
    __setNetworkCacheForTests("devnet");
  });

  describe("network gate", () => {
    it("issuance returns 410 on mainnet", async () => {
      __setNetworkCacheForTests("mainnet-beta");
      const kp = Keypair.generate();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/keys/self-serve",
        payload: { agent_pubkey: kp.publicKey.toBase58(), nonce: "x", signature: "x" },
      });
      assert.equal(res.statusCode, 410);
    });

    it("challenge returns 410 on mainnet", async () => {
      __setNetworkCacheForTests("mainnet-beta");
      const kp = Keypair.generate();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/keys/self-serve/challenge",
        payload: { agent_pubkey: kp.publicKey.toBase58() },
      });
      assert.equal(res.statusCode, 410);
    });

    it("returns 410 on unknown network (fail-closed)", async () => {
      __setNetworkCacheForTests("unknown");
      const kp = Keypair.generate();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/keys/self-serve/challenge",
        payload: { agent_pubkey: kp.publicKey.toBase58() },
      });
      assert.equal(res.statusCode, 410);
    });
  });

  describe("input validation", () => {
    it("challenge rejects malformed pubkey", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/keys/self-serve/challenge",
        payload: { agent_pubkey: "not-a-pubkey" },
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error, "InvalidAgentPubkey");
    });

    it("issuance rejects missing nonce", async () => {
      const kp = Keypair.generate();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/keys/self-serve",
        payload: { agent_pubkey: kp.publicKey.toBase58(), signature: "x" },
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error, "MissingNonce");
    });

    it("issuance rejects missing signature", async () => {
      const kp = Keypair.generate();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/keys/self-serve",
        payload: { agent_pubkey: kp.publicKey.toBase58(), nonce: "x" },
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error, "MissingSignature");
    });

    it("issuance rejects malformed signature length", async () => {
      const kp = Keypair.generate();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/keys/self-serve",
        payload: {
          agent_pubkey: kp.publicKey.toBase58(),
          nonce: "x",
          signature: Buffer.from("too-short").toString("base64"),
        },
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error, "MalformedSignature");
    });
  });

  describe("happy path", () => {
    it("challenge -> sign -> issue returns a fresh key bound to the pubkey", async () => {
      const freshApp = await buildApp();
      try {
        const kp = Keypair.generate();
        const pubkey = kp.publicKey.toBase58();

        const challRes = await freshApp.inject({
          method: "POST",
          url: "/api/v1/keys/self-serve/challenge",
          payload: { agent_pubkey: pubkey },
        });
        assert.equal(challRes.statusCode, 201);
        const { nonce, message, expiresAt } = challRes.json();
        assert.ok(typeof nonce === "string" && nonce.length === 64); // 32 bytes hex
        assert.match(message, /Pact Network self-serve API key issuance/);
        assert.match(message, new RegExp(`Agent: ${pubkey}`));
        assert.match(message, new RegExp(`Nonce: ${nonce}`));
        assert.ok(new Date(expiresAt).getTime() > Date.now());

        const sig = sign(kp, nonce, pubkey);
        const issueRes = await freshApp.inject({
          method: "POST",
          url: "/api/v1/keys/self-serve",
          payload: { agent_pubkey: pubkey, nonce, signature: sig },
        });
        assert.equal(issueRes.statusCode, 201);
        const body = issueRes.json();
        assert.match(body.apiKey, /^pact_[0-9a-f]{48}$/);
        assert.equal(body.agentPubkey, pubkey);

        await query("DELETE FROM api_keys WHERE label = $1", [body.label]);
      } finally {
        await freshApp.close();
      }
    });
  });

  describe("ownership proof (PR 50 codex High)", () => {
    it("rejects signature from a DIFFERENT keypair than the claimed pubkey", async () => {
      const claimed = Keypair.generate();
      const attacker = Keypair.generate();
      const claimedPubkey = claimed.publicKey.toBase58();

      const challRes = await app.inject({
        method: "POST",
        url: "/api/v1/keys/self-serve/challenge",
        payload: { agent_pubkey: claimedPubkey },
      });
      assert.equal(challRes.statusCode, 201);
      const { nonce } = challRes.json();

      // Attacker signs with their OWN keypair but submits under the
      // claimed pubkey. Pre-PR-50-fix this would have minted a key bound
      // to claimedPubkey for free; post-fix, signature verification fails.
      const sig = sign(attacker, nonce, claimedPubkey);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/keys/self-serve",
        payload: { agent_pubkey: claimedPubkey, nonce, signature: sig },
      });
      assert.equal(res.statusCode, 401);
      assert.equal(res.json().error, "InvalidSignature");
    });

    it("rejects signature over the WRONG message (replay/wrong-nonce)", async () => {
      const kp = Keypair.generate();
      const pubkey = kp.publicKey.toBase58();

      const challRes = await app.inject({
        method: "POST",
        url: "/api/v1/keys/self-serve/challenge",
        payload: { agent_pubkey: pubkey },
      });
      const { nonce: realNonce } = challRes.json();

      // Sign a different nonce than the one we claim to be redeeming.
      const sig = sign(kp, "decoy-nonce", pubkey);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/keys/self-serve",
        payload: { agent_pubkey: pubkey, nonce: realNonce, signature: sig },
      });
      assert.equal(res.statusCode, 401);
      assert.equal(res.json().error, "InvalidSignature");
    });

    it("rejects unknown / fabricated nonces", async () => {
      const kp = Keypair.generate();
      const pubkey = kp.publicKey.toBase58();

      // Skip the challenge step entirely. Sig will pass over the
      // fabricated message, but the nonce DB lookup catches it.
      const sig = sign(kp, "fabricated-nonce", pubkey);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/keys/self-serve",
        payload: { agent_pubkey: pubkey, nonce: "fabricated-nonce", signature: sig },
      });
      assert.equal(res.statusCode, 401);
      assert.equal(res.json().error, "UnknownOrConsumedNonce");
    });

    it("rejects challenge re-use after first redeem (single-use)", async () => {
      const freshApp = await buildApp();
      try {
        const kp = Keypair.generate();
        const pubkey = kp.publicKey.toBase58();

        const ch = (
          await freshApp.inject({
            method: "POST",
            url: "/api/v1/keys/self-serve/challenge",
            payload: { agent_pubkey: pubkey },
          })
        ).json();
        const sig = sign(kp, ch.nonce, pubkey);

        const r1 = await freshApp.inject({
          method: "POST",
          url: "/api/v1/keys/self-serve",
          payload: { agent_pubkey: pubkey, nonce: ch.nonce, signature: sig },
        });
        assert.equal(r1.statusCode, 201, "first redeem should succeed");
        await query("DELETE FROM api_keys WHERE label = $1", [r1.json().label]);

        // Use a fresh app to dodge the per-pubkey fastify-rate-limit window.
        const freshApp2 = await buildApp();
        try {
          const r2 = await freshApp2.inject({
            method: "POST",
            url: "/api/v1/keys/self-serve",
            payload: { agent_pubkey: pubkey, nonce: ch.nonce, signature: sig },
          });
          assert.equal(r2.statusCode, 401);
          assert.equal(r2.json().error, "UnknownOrConsumedNonce");
        } finally {
          await freshApp2.close();
        }
      } finally {
        await freshApp.close();
      }
    });
  });

  describe("atomic 5-key cap (PR 50 codex Medium — race-free)", () => {
    it("concurrent issuances for one pubkey never exceed the cap", async () => {
      const kp = Keypair.generate();
      const pubkey = kp.publicKey.toBase58();

      // Pre-seed 4 active self-serve keys for this pubkey. The next
      // concurrent batch of THREE issuance attempts must result in
      // EXACTLY one success (bringing total to 5) and the others rejected
      // with TooManyKeysForPubkey — never exceeding the cap.
      for (let i = 0; i < 4; i++) {
        await query(
          "INSERT INTO api_keys (key_hash, label, agent_pubkey, status) VALUES ($1, $2, $3, 'active')",
          [
            `hash-race-${SUITE_TAG}-${i}`,
            `self-serve-race-${SUITE_TAG}-${i}`,
            pubkey,
          ],
        );
      }

      // Each concurrent attempt needs its own nonce + signature. Separate
      // app instances dodge the per-pubkey fastify-rate-limit window
      // (which is a different concern from the DB-level cap).
      const issueOnce = async () => {
        const a = await buildApp();
        try {
          const ch = (
            await a.inject({
              method: "POST",
              url: "/api/v1/keys/self-serve/challenge",
              payload: { agent_pubkey: pubkey },
            })
          ).json();
          const sig = sign(kp, ch.nonce, pubkey);
          return a.inject({
            method: "POST",
            url: "/api/v1/keys/self-serve",
            payload: { agent_pubkey: pubkey, nonce: ch.nonce, signature: sig },
          });
        } finally {
          await a.close();
        }
      };

      const results = await Promise.all([issueOnce(), issueOnce(), issueOnce()]);
      const statuses = results.map((r) => r.statusCode);
      const successes = statuses.filter((s) => s === 201).length;
      const tooMany = statuses.filter((s) => s === 429).length;

      assert.equal(
        successes,
        1,
        `exactly one issuance should succeed under the cap, got statuses ${statuses}`,
      );
      assert.equal(
        tooMany,
        2,
        `the other two must be rejected with 429 TooManyKeysForPubkey, got statuses ${statuses}`,
      );

      // Cleanup.
      await query(
        "DELETE FROM api_keys WHERE agent_pubkey = $1 AND label LIKE 'self-serve-%'",
        [pubkey],
      );
    });
  });
});
