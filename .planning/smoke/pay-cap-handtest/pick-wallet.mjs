// Pick the agent wallet to use for the hand-test: walk the candidate wallets in
// order and return the first whose devnet USDC ATA is provisioned with both a
// balance AND a delegated allowance >= the per-call premium (so the live
// facilitator's allowance check will pass and the refund/cap becomes
// observable). Dependency-free (built-in fetch + crypto). Prints the chosen
// wallet path on stdout; diagnostics on stderr. NEVER prints any secret key.
import { readFileSync } from "node:fs";

const ALPH = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(s){let b=[0];for(const c of s){let carry=ALPH.indexOf(c);if(carry<0)throw new Error("bad b58");for(let j=0;j<b.length;j++){carry+=b[j]*58;b[j]=carry&0xff;carry>>=8;}while(carry){b.push(carry&0xff);carry>>=8;}}for(let k=0;k<s.length&&s[k]==="1";k++)b.push(0);return Uint8Array.from(b.reverse());}
function b58encode(buf){let d=[0];for(const x of buf){let carry=x;for(let j=0;j<d.length;j++){carry+=d[j]<<8;d[j]=carry%58;carry=(carry/58)|0;}while(carry){d.push(carry%58);carry=(carry/58)|0;}}let s="";for(const x of buf){if(x===0)s+="1";else break;}for(let k=d.length-1;k>=0;k--)s+=ALPH[d[k]];return s;}

async function rpc(url, method, params){const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method,params})});return r.json();}

// ATA derivation (SPL associated-token-account) without @solana/spl-token.
// We instead just READ the wallet's token accounts for the mint via RPC
// (getTokenAccountsByOwner), which avoids re-implementing the PDA derivation.
async function probe(rpcUrl, owner, mint, premium){
  const res = await rpc(rpcUrl, "getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }]);
  const accts = res?.result?.value ?? [];
  if (accts.length === 0) return { ok:false, reason:"no_ata" };
  const info = accts[0].account.data.parsed.info;
  const bal = BigInt(info.tokenAmount?.amount ?? "0");
  const deleg = BigInt(info.delegatedAmount?.amount ?? "0");
  if (bal < premium) return { ok:false, reason:`balance ${bal} < premium ${premium}`, bal, deleg };
  if (deleg < premium) return { ok:false, reason:`delegatedAmount ${deleg} < premium ${premium}`, bal, deleg };
  return { ok:true, ata: accts[0].pubkey, bal, deleg, delegate: info.delegate };
}

const rpcUrl = process.env.RPC_URL || "https://api.devnet.solana.com";
const mint = process.env.USDC_MINT;
const premium = BigInt(process.env.PAY_DEFAULT_FLAT_PREMIUM_LAMPORTS || "1000");
const candidates = process.argv.slice(2);

for (const w of candidates) {
  let pub;
  try { const sk = JSON.parse(readFileSync(w, "utf8")).secretKey; pub = b58encode(b58decode(sk).slice(32,64)); }
  catch (e) { console.error(`[pick-wallet] ${w}: unreadable (${e.message})`); continue; }
  const p = await probe(rpcUrl, pub, mint, premium);
  if (p.ok) {
    console.error(`[pick-wallet] CHOSEN ${w} pubkey=${pub} ata=${p.ata} balance=${p.bal} delegatedAmount=${p.deleg} delegate=${p.delegate}`);
    console.log(w);
    process.exit(0);
  }
  console.error(`[pick-wallet] skip ${w} pubkey=${pub}: ${p.reason}`);
}
console.error("[pick-wallet] NO provisioned wallet found (need USDC ATA balance + delegation >= premium on devnet)");
process.exit(1);
