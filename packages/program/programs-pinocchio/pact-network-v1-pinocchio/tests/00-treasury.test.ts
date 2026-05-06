import { test, expect } from "bun:test";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import { Keypair, Transaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  loadProgram,
  generateKeypair,
  setupUsdcMint,
  deriveProtocolConfig,
  deriveTreasury,
  buildInitializeProtocolConfig,
  buildInitializeTreasury,
  FEE_KIND_TREASURY,
  getAccountData,
  preallocateTokenAccount,
} from "./helpers";

function setup() {
  const svm = new LiteSVM();
  loadProgram(svm);
  const authority = generateKeypair(svm);
  const mintAuth = generateKeypair(svm);
  const mint = setupUsdcMint(svm, mintAuth);

  const [pcPda] = deriveProtocolConfig();
  const [treasuryPda] = deriveTreasury();

  const initPc = buildInitializeProtocolConfig(authority.publicKey, pcPda, mint, {
    defaultRecipients: [
      { kind: FEE_KIND_TREASURY, destination: treasuryPda, bps: 1000 },
    ],
  });
  const tx = new Transaction();
  tx.add(initPc);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = authority.publicKey;
  tx.sign(authority);
  svm.sendTransaction(tx);

  return { svm, authority, mint, pcPda, treasuryPda };
}

test("initialize_treasury creates singleton with vault owned by treasury PDA", () => {
  const { svm, authority, mint, pcPda, treasuryPda } = setup();
  const treasuryVault = Keypair.generate().publicKey;

  const ix = buildInitializeTreasury(authority.publicKey, pcPda, treasuryPda, treasuryVault, mint, svm);
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = authority.publicKey;
  tx.sign(authority);
  const result = svm.sendTransaction(tx);
  if ("err" in result) console.log("INIT TREASURY ERR:", JSON.stringify(result), "logs:", (result as any).meta?.logs);
  expect(result instanceof FailedTransactionMetadata).toBe(false);

  // Treasury PDA exists, has correct authority + vault.
  const data = getAccountData(svm, treasuryPda);
  expect(data).not.toBeNull();
  // bump (1) + pad (7) + authority (32 @ 8) + usdc_vault (32 @ 40)
  expect(Buffer.from(data!.slice(8, 40)).toString("hex")).toBe(
    authority.publicKey.toBuffer().toString("hex"),
  );
  expect(Buffer.from(data!.slice(40, 72)).toString("hex")).toBe(
    treasuryVault.toBuffer().toString("hex"),
  );

  // Vault is initialized as an SPL token account owned by Treasury PDA.
  const vaultAcct = svm.getAccount(treasuryVault);
  expect(vaultAcct).not.toBeNull();
  expect(vaultAcct!.owner.equals(TOKEN_PROGRAM_ID)).toBe(true);
  // owner field at offset 32 of the 165-byte token account should equal the
  // Treasury PDA.
  expect(Buffer.from(vaultAcct!.data.slice(32, 64)).toString("hex")).toBe(
    treasuryPda.toBuffer().toString("hex"),
  );
});

test("initialize_treasury double-init rejected", () => {
  const { svm, authority, mint, pcPda, treasuryPda } = setup();
  const treasuryVault = Keypair.generate().publicKey;

  const ix = buildInitializeTreasury(authority.publicKey, pcPda, treasuryPda, treasuryVault, mint, svm);
  const tx1 = new Transaction();
  tx1.add(ix);
  tx1.recentBlockhash = svm.latestBlockhash();
  tx1.feePayer = authority.publicKey;
  tx1.sign(authority);
  expect(svm.sendTransaction(tx1) instanceof FailedTransactionMetadata).toBe(false);

  // Second attempt with new vault must still fail.
  const treasuryVault2 = Keypair.generate().publicKey;
  preallocateTokenAccount(svm, treasuryVault2);
  const ix2 = buildInitializeTreasury(authority.publicKey, pcPda, treasuryPda, treasuryVault2, mint, svm);
  const tx2 = new Transaction();
  tx2.add(ix2);
  tx2.recentBlockhash = svm.latestBlockhash();
  tx2.feePayer = authority.publicKey;
  tx2.sign(authority);
  expect(svm.sendTransaction(tx2) instanceof FailedTransactionMetadata).toBe(true);
});

test("initialize_treasury rejects non-protocol-authority caller", () => {
  const { svm, authority: _authority, mint, pcPda, treasuryPda } = setup();
  const attacker = generateKeypair(svm);
  const treasuryVault = Keypair.generate().publicKey;

  const ix = buildInitializeTreasury(attacker.publicKey, pcPda, treasuryPda, treasuryVault, mint, svm);
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = attacker.publicKey;
  tx.sign(attacker);
  expect(svm.sendTransaction(tx) instanceof FailedTransactionMetadata).toBe(true);
});
