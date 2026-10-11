// Tech Stack Scout — "Ask the ledger": answer questions about the watchlist using only stored evidence. Every sentence must cite ledger ids (A#.F#, A#.radar, A#.brief); code drops anything that does not verify.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
const SB = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const J = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
let KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const MODELS = [Deno.env.get("GEMINI_MODEL"), "gemini-flash-latest", "gemini-2.5-flash", "gemini-2.0-flash"].filter(Boolean) as string[];

async function gemini(system: string, user: string, schema: any) {
  if (!KEY) { const { data } = await SB.from("app_config").select("value").eq("key", "gemini_api_key").maybeSingle(); KEY = data?.value ?? ""; }
  const key = KEY.replace(/\s+/g, ""); if (!key) throw new Error("GEMINI_API_KEY secret is not set");
  const body = JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: user }] }], generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: schema } });
  const eps = (m: string) => [{ url: `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, h: { "x-goog-api-key": key } }, { url: `https://aiplatform.googleapis.com/v1/publishers/google/models/${m}:generateContent?key=${encodeURIComponent(key)}`, h: {} }];
  const errs: string[] = [];
  for (const m of MODELS) for (const ep of eps(m)) {
    try {
      const r = await fetch(ep.url, { method: "POST", headers: { "Content-Type": "application/json", ...ep.h }, body });
      if (!r.ok) { errs.push(`${m}: ${r.status}`); continue; }
      const j = await r.json(); return { model: m, out: JSON.parse(j.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("") ?? "{}") };
    } catch { errs.push(`${m}: network`); }
  }
  throw new Error("Gemini failed: " + errs.slice(-3).join(" | "));
}

const SYSTEM = `You answer an enterprise account executive's questions about their watchlist. You are given LEDGER, one block per account, each line tagged with an id like A3.F5.
Rules:
- Use ONLY facts in LEDGER. If the ledger does not contain the answer, say so plainly in one sentence and cite nothing.
- Every sentence that states a fact must list the ids it relies on in "cites". Ids must appear in LEDGER exactly.
- Never invent companies, technologies, numbers, dates or outcomes. Never compute anything not directly shown.
- Be short: at most 5 sentences, plain words, no hype. If the question asks to rank or choose, name the accounts and say why using the ledger lines.
- Evidence tier C accounts have little public signal; say so rather than guessing.`;
const SCHEMA = { type: "OBJECT", properties: { answer: { type: "ARRAY", items: { type: "OBJECT", properties: { text: { type: "STRING" }, cites: { type: "ARRAY", items: { type: "STRING" } } }, required: ["text", "cites"] } } }, required: ["answer"] };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const { question, workspace = "live" } = await req.json();
    const q = String(question ?? "").trim().slice(0, 500); if (q.length < 3) return J({ error: "ask a question" }, 400);
    const { data: wl } = await SB.from("watchlist").select("id,name,domain,segment,stage,persona,owner").eq("active", true).eq("is_demo", workspace === "demo").order("created_at").limit(30);
    const accs = wl || []; if (!accs.length) return J({ answer: [{ text: "The watchlist is empty.", cites: [] }], dropped: 0 });
    const ids = accs.map((a) => a.id);
    const [{ data: snaps }, { data: sigs }, { data: radar }, { data: briefs }] = await Promise.all([
      SB.from("snapshots").select("id,account_id,taken_at,evidence_tier,icp_fit,why_now,diff,ci_median_min,eng_roles,platform_roles").in("account_id", ids).order("taken_at", { ascending: false }),
      SB.from("signals").select("account_id,snapshot_id,fid,tech,category,state,confidence,source,quote").in("account_id", ids),
      SB.from("radar").select("account_id,phase,weeks_in_phase,gap,window_score,play").in("account_id", ids),
      SB.from("briefs").select("account_id,opener,hook_type,created_at").in("account_id", ids).order("created_at", { ascending: false }),
    ]);
    const valid = new Set<string>(); const blocks: string[] = []; const label = new Map<string, string>();
    accs.forEach((a, i) => {
      const A = `A${i + 1}`; label.set(A, a.name);
      const s = (snaps || []).find((x) => x.account_id === a.id);
      const lines = [`## ${A} ${a.name} (${a.domain}) | segment ${a.segment ?? "?"} | stage ${a.stage ?? "none"} | persona ${a.persona ?? "?"}`];
      if (s) { valid.add(`${A}.snap`); lines.push(`[${A}.snap] latest snapshot ${String(s.taken_at).slice(0, 10)} | tier ${s.evidence_tier} | icp ${s.icp_fit} | why-now ${s.why_now} | CI median ${s.ci_median_min ?? "n/a"} min | eng roles ${s.eng_roles ?? "n/a"} | platform roles ${s.platform_roles ?? "n/a"} | changes: ${(s.diff || []).join("; ") || "none"}`); }
      const r = (radar || []).find((x) => x.account_id === a.id);
      if (r) { valid.add(`${A}.radar`); lines.push(`[${A}.radar] phase ${r.phase}, week ${r.weeks_in_phase} | gap ${r.gap} | window score ${r.window_score} | play: ${r.play ?? ""}`); }
      const b = (briefs || []).find((x) => x.account_id === a.id);
      if (b?.opener) { valid.add(`${A}.brief`); lines.push(`[${A}.brief] opener (${b.hook_type}): ${b.opener}`); }
      for (const g of (sigs || []).filter((x) => x.account_id === a.id && x.snapshot_id === s?.id && x.state !== "noise").slice(0, 16)) { const id = `${A}.${g.fid}`; valid.add(id); lines.push(`[${id}] ${g.tech} | ${g.category} | ${g.state} | conf ${g.confidence} | ${g.source} | "${String(g.quote ?? "").slice(0, 120)}"`); }
      blocks.push(lines.join("\n"));
    });
    const user = `LEDGER (workspace ${workspace}, today ${new Date().toISOString().slice(0, 10)}):\n${blocks.join("\n\n")}\n\nQUESTION: ${q}`;
    const check = (out: any) => {
      const bad: string[] = []; const kept: any[] = [];
      for (const s of out.answer || []) {
        const cites = (s.cites || []).filter((c: string) => valid.has(c)); const unknown = (s.cites || []).filter((c: string) => !valid.has(c));
        if (unknown.length) bad.push(`unknown ids ${unknown.join(", ")}`);
        if (!cites.length && /\d|[A-Z][a-z]+ /.test(s.text) && !/ledger does not|not in the ledger|no evidence|not enough/i.test(s.text)) bad.push(`uncited: ${String(s.text).slice(0, 40)}`);
        else kept.push({ text: s.text, cites });
      }
      return { bad, kept };
    };
    let { model, out } = await gemini(SYSTEM, user, SCHEMA); let c = check(out); let retried = false;
    if (c.bad.length) { retried = true; const r2 = await gemini(SYSTEM, `${user}\n\nYOUR PREVIOUS ANSWER:\n${JSON.stringify(out)}\nIt failed: ${c.bad.join("; ")}. Return the JSON again using only ids that appear in LEDGER.`, SCHEMA); out = r2.out; const c2 = check(out); c = c2; }
    return J({ answer: c.kept, dropped: c.bad.length, retried, model, accounts: Object.fromEntries(label) });
  } catch (e) { return J({ error: String((e as Error).message ?? e) }, 500); }
});
