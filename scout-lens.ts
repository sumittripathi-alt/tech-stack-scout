// Tech Stack Scout — solution lens: score one account against a (hypothetical) product and write a product-specific opener.
// Fit and "why it fits" are computed by code from stored evidence (no AI). Only the opener uses Gemini Flash, and it passes the same kind of verifier as the main brief:
// known fact ids only, every sentence cited, numbers must appear in the cited facts, no unknown technologies, no banned phrases, 30 words max. One repair, then a template.
// Only signed-in team members can call it. Results are stored in `lens_openers`.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
const SB = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const J = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
let KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const MODELS = [Deno.env.get("GEMINI_MODEL"), "gemini-flash-latest", "gemini-2.5-flash", "gemini-2.0-flash"].filter(Boolean) as string[];
const BANNED = ["i noticed", "hope this finds you", "leverage", "synergy", "cutting-edge", "in today's", "streamline", "game-changer", "revolutionize", "seamless"];

async function member(req: Request) {
  const tok = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data, error } = await SB.auth.getUser(tok);
  const email = data?.user?.email?.toLowerCase();
  if (error || !email) return null;
  const { data: m } = await SB.from("team_members").select("email,active").eq("email", email).maybeSingle();
  return m?.active ? m : null;
}

async function gemini(system: string, user: string, schema: any) {
  if (!KEY) { const { data } = await SB.from("app_config").select("value").eq("key", "gemini_api_key").maybeSingle(); KEY = data?.value ?? ""; }
  const key = KEY.replace(/\s+/g, ""); if (!key) throw new Error("GEMINI_API_KEY secret is not set");
  const body = JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: user }] }], generationConfig: { temperature: 0.2, responseMimeType: "application/json", responseSchema: schema } });
  const errs: string[] = [];
  for (const m of MODELS) {
    for (const ep of [{ url: `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, h: { "x-goog-api-key": key } }, { url: `https://aiplatform.googleapis.com/v1/publishers/google/models/${m}:generateContent?key=${encodeURIComponent(key)}`, h: {} }]) {
      try {
        const r = await fetch(ep.url, { method: "POST", headers: { "Content-Type": "application/json", ...ep.h }, body });
        if (!r.ok) { errs.push(`${m}: ${r.status}`); continue; }
        const j = await r.json(); return { model: m, out: JSON.parse(j.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("") ?? "{}") };
      } catch { errs.push(`${m}: network`); }
    }
  }
  throw new Error("Gemini failed: " + errs.slice(-3).join(" | "));
}

// ---- fit engine (the browser runs the same rules so ranking and "why" always agree) ----
const FACTOR: Record<string, number> = { active: 1, emerging: 0.8, migrating_to: 0.9, migrating_from: 1, legacy: 0.6, contested: 0.5, hiring_only: 0.6 };
function fit(lens: any, ctx: any) {
  let s = Number(lens.base) || 0; const reasons: any[] = [];
  for (const r of lens.rules || []) {
    if (r.k === "tech") {
      const hit = ctx.signals.filter((g: any) => (r.techs || []).includes(g.tech) && g.state !== "noise");
      if (!hit.length) continue;
      const uniq = [...new Map(hit.map((g: any) => [g.tech, g])).values()].slice(0, 2) as any[];
      const f = Math.max(...uniq.map((g) => FACTOR[g.state] ?? 0.6)); const w = r.w * f; s += w;
      const label = uniq.map((g) => g.tech).join(" and ");
      reasons.push({ text: r.why.replace("{tech}", label) + (uniq.every((g) => g.state === "hiring_only") ? " (job posts only)" : ""), cites: uniq.map((g) => g.fid), w });
    } else if (r.k === "metric") {
      const v = ctx.metrics[r.m]; if (v == null) continue;
      if (v >= r.gte && (r.lt == null || v < r.lt)) { s += r.w; reasons.push({ text: r.why.replace("{v}", String(v)), cites: [ctx.metricIds[r.m]], w: r.w }); }
    }
  }
  reasons.sort((a, b) => b.w - a.w);
  return { score: Math.min(1, Math.round(s * 100) / 100), reasons };
}

const ambiguous = new Set(["go", "react", "rust", "java", "build", "nx", "monorepo", "docker"]);
function verify(text: string, cites: string[], facts: Map<string, string>, techs: string[], dict: { tech: string; aliases: string[] }[], company: string, banned: string[]) {
  const errors: string[] = [];
  if (!cites.length) errors.push("no cites");
  for (const c of cites) if (!facts.has(c)) errors.push(`unknown cite ${c}`);
  const cited = cites.map((c) => facts.get(c) ?? "").join(" ").toLowerCase();
  for (const n of text.match(/\d+(\.\d+)?/g) || []) if (!cited.includes(n)) errors.push(`number ${n} not in cited facts`);
  const low = text.toLowerCase();
  for (const b of banned) if (low.includes(b)) errors.push(`banned phrase "${b}"`);
  for (const d of dict) for (const a of [d.tech, ...(d.aliases || [])]) {
    const al = a.toLowerCase(); if (al.length < 3 || ambiguous.has(al) || company.toLowerCase().includes(al)) continue;
    if (new RegExp(`(^|[^a-z0-9])${al.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(low) && !techs.includes(d.tech)) errors.push(`"${al}" is not in the facts`);
  }
  if (text.split(/\s+/).filter(Boolean).length > 30) errors.push("opener longer than 30 words");
  if (text.includes("?")) errors.push("opener must not be a question");
  return [...new Set(errors)];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const who = await member(req);
    if (!who) return J({ error: "Sign in as a team member to write a lens opener.", code: "auth" }, 401);
    const { account_id, lens_id } = await req.json();
    const { count } = await SB.from("lens_openers").select("id", { count: "exact", head: true }).eq("created_by", who.email).gte("created_at", new Date(Date.now() - 3600e3).toISOString());
    if ((count ?? 0) >= 40) return J({ error: "Limit reached: 40 lens openers an hour.", code: "rate" }, 429);
    const [{ data: lens }, { data: acc }] = await Promise.all([SB.from("solution_lenses").select("*").eq("id", lens_id).maybeSingle(), SB.from("watchlist").select("id,name,domain,persona,is_demo").eq("id", account_id).maybeSingle()]);
    if (!lens || !acc) return J({ error: "Account or lens not found." }, 404);
    const { data: snap } = await SB.from("snapshots").select("*").eq("account_id", account_id).order("taken_at", { ascending: false }).limit(1).maybeSingle();
    if (!snap) return J({ error: "This account has no research yet. Refresh it first." }, 400);
    const { data: sigs } = await SB.from("signals").select("fid,tech,category,state,confidence,quote").eq("snapshot_id", snap.id);
    const signals = (sigs || []).filter((g: any) => g.state !== "noise");
    const langs = Object.keys(snap.languages || {}).length;
    const cloudCount = new Set(signals.filter((g: any) => g.category === "cloud").map((g: any) => g.tech)).size;
    const metrics: any = { ci: snap.ci_median_min != null ? Number(snap.ci_median_min) : null, platform_roles: snap.platform_roles, eng_roles: snap.eng_roles, active30: snap.active_repos_30d, langs: langs || null, cloud_count: cloudCount || null };
    const metricIds: any = { ci: "M1", platform_roles: "M2", eng_roles: "M3", active30: "M4", langs: "M5", cloud_count: "M6" };
    const metricText: any = { ci: (v: any) => `CI median ${v} minutes measured from recent workflow runs`, platform_roles: (v: any) => `${v} open platform engineering roles`, eng_roles: (v: any) => `${v} open engineering roles`, active30: (v: any) => `${v} repositories active in the last 30 days`, langs: (v: any) => `${v} programming languages in public repositories`, cloud_count: (v: any) => `${v} cloud providers seen` };
    const facts = new Map<string, string>();
    for (const g of signals) facts.set(g.fid, `${g.tech} (${g.category}, ${g.state}, confidence ${g.confidence}) ${g.quote ?? ""}`);
    for (const k of Object.keys(metricIds)) if (metrics[k] != null) facts.set(metricIds[k], metricText[k](metrics[k]));
    const { score, reasons } = fit(lens, { signals, metrics, metricIds });
    if (!reasons.length) return J({ error: "No evidence matches this lens, so there is nothing true to build an opener from.", score, reasons, code: "no_fit" }, 200);

    const { data: prof } = await SB.from("seller_profile").select("banned_phrases").eq("id", "default").maybeSingle();
    const banned = ((prof?.banned_phrases as string[]) || BANNED).map((x) => x.toLowerCase());
    const { data: dict } = await SB.from("tech_dictionary").select("tech,aliases").eq("enabled", true);
    const techs = signals.map((g: any) => g.tech);
    const persona = acc.persona || "VP Engineering";
    const useFacts = [...new Set(reasons.slice(0, 4).flatMap((r) => r.cites))].filter((id) => facts.has(id));
    const factSheet = useFacts.map((id) => `[${id}] ${facts.get(id)}`).join("\n");
    const reasonSheet = reasons.slice(0, 4).map((r) => `- ${r.text} (cite ${r.cites.join(", ")})`).join("\n");
    const system = `You write one opening line for an enterprise account executive who sells ${lens.pitch}.
Use ONLY the facts in FACT_SHEET. Cite the fact ids you rely on. Never name a technology, number, team or project that is not in FACT_SHEET.
Facts with state hiring_only or emerging, or confidence below 0.6, must be hedged ("job posts suggest", "appears to").
Write ONE sentence, maximum 30 words, to a ${persona}. It must contain a specific noun or number from the facts and connect it to a friction that this kind of product addresses. No greeting, no product name, no question mark. Never invent customers or results.
BANNED words/phrases: ${banned.map((b) => `"${b}"`).join(", ")}.`;
    const schema = { type: "OBJECT", properties: { opener: { type: "OBJECT", properties: { text: { type: "STRING" }, cites: { type: "ARRAY", items: { type: "STRING" } } }, required: ["text", "cites"] } }, required: ["opener"] };
    const user = `COMPANY: ${acc.name}\nFIT REASONS (already verified by code):\n${reasonSheet}\n\nFACT_SHEET:\n${factSheet}`;
    let { model, out } = await gemini(system, user, schema);
    let errors = verify(out.opener?.text ?? "", out.opener?.cites ?? [], facts, techs, dict || [], acc.name, banned); let repaired = false; let fallback = false;
    if (errors.length) {
      repaired = true;
      const r2 = await gemini(system, `${user}\n\nYOUR PREVIOUS ANSWER:\n${JSON.stringify(out)}\nIt failed these checks: ${errors.join("; ")}. Return it again, fixed.`, schema); out = r2.out; model = r2.model;
      errors = verify(out.opener?.text ?? "", out.opener?.cites ?? [], facts, techs, dict || [], acc.name, banned);
    }
    let text = out.opener?.text ?? ""; let cites: string[] = out.opener?.cites ?? [];
    if (errors.length) {
      fallback = true; const r1 = reasons[0];
      text = `Public data shows ${r1.text}; that is where ${String(lens.tagline).toLowerCase()} usually pays off.`; cites = r1.cites;
    }
    const { data: row } = await SB.from("lens_openers").insert({ account_id, lens_id, snapshot_id: snap.id, opener: text, cites, verifier_passed: !errors.length, used_fallback: fallback, model, created_by: who.email }).select("id,created_at").single();
    return J({ ok: true, id: row?.id, opener: text, cites, score, reasons: reasons.slice(0, 5), repaired, fallback, model, facts: Object.fromEntries(useFacts.map((id) => [id, facts.get(id)])) });
  } catch (e) { return J({ error: String((e as Error).message ?? e) }, 500); }
});
