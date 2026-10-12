// Tech Stack Scout — push a brief (or a material-change alert) to Slack, a generic webhook (Zapier/Make -> HubSpot) or a HubSpot note.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
const SB = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const J = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const PRIVATE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1)/i;

const EMAIL_OK = (e: unknown) => typeof e === "string" && e.length > 3;
async function member(req: Request) {
  const tok = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (tok && tok === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) return { email: "system", active: true }; // internal callers (change alerts)
  const { data, error } = await SB.auth.getUser(tok);
  const email = data?.user?.email?.toLowerCase();
  if (error || !EMAIL_OK(email)) return null;
  const { data: m } = await SB.from("team_members").select("email,active").eq("email", email!).maybeSingle();
  return m?.active ? m : null;
}

async function load(accountId: string) {
  const { data: acc } = await SB.from("watchlist").select("*").eq("id", accountId).single();
  if (!acc) throw new Error("account not found");
  const { data: b } = await SB.from("briefs").select("*").eq("account_id", accountId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  const { data: s } = await SB.from("snapshots").select("evidence_tier, icp_fit, why_now, diff").eq("account_id", accountId).order("taken_at", { ascending: false }).limit(1).maybeSingle();
  const { data: r } = await SB.from("radar").select("phase, weeks_in_phase, gap, window_score, play").eq("account_id", accountId).maybeSingle();
  return { acc, b, s, r };
}
const summaryText = (b: any) => (b?.summary || []).map((p: any[]) => p.map((x) => x.text).join(" ")).join("\n\n");
const esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function message(d: any, mode: string, reason?: string) {
  const { acc, b, s, r } = d;
  const head = mode === "alert" ? `Change at ${acc.name}${reason ? ": " + reason : ""}` : `Scout brief: ${acc.name}`;
  const lines = [head];
  if (b?.opener) lines.push(`Opener: ${b.opener}`);
  if (r?.play) lines.push(`Play (${r.phase}, week ${r.weeks_in_phase}): ${r.play}`);
  if (s) lines.push(`Evidence tier ${s.evidence_tier} | ICP fit ${s.icp_fit} | why now ${s.why_now}`);
  return { head, text: lines.join("\n"), summary: summaryText(b), opener: b?.opener ?? null, hook_type: b?.hook_type ?? null, discovery: b?.discovery ?? [] };
}

async function send(t: any, d: any, mode: string, reason?: string) {
  const m = message(d, mode, reason);
  if (t.kind !== "hubspot" && (!/^https:\/\//.test(t.url) || PRIVATE.test(t.url.replace(/^https:\/\//, "")))) throw new Error("target url must be public https");
  if (t.kind === "slack") {
    const r = await fetch(t.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: m.text + (m.summary ? `\n\n${m.summary}` : "") }) });
    if (!r.ok) throw new Error(`slack ${r.status}`); return "slack ok";
  }
  if (t.kind === "webhook") {
    const r = await fetch(t.url, { method: "POST", headers: { "Content-Type": "application/json", ...(t.token ? { Authorization: `Bearer ${t.token}` } : {}) }, body: JSON.stringify({ event: mode === "alert" ? "scout.alert" : "scout.brief", account: { name: d.acc.name, domain: d.acc.domain, stage: d.acc.stage, owner: d.acc.owner }, reason: reason ?? null, ...m, radar: d.r ?? null, scores: d.s ? { tier: d.s.evidence_tier, icp_fit: d.s.icp_fit, why_now: d.s.why_now } : null }) });
    if (!r.ok) throw new Error(`webhook ${r.status}`); return `webhook ${r.status}`;
  }
  if (t.kind === "hubspot") {
    // NOTE: not tested against a live HubSpot portal. Needs a private-app token with crm.objects.companies.read and crm.objects.notes.write (token field).
    if (!t.token) throw new Error("hubspot token missing");
    const H = { Authorization: `Bearer ${t.token}`, "Content-Type": "application/json" };
    const sr = await fetch("https://api.hubapi.com/crm/v3/objects/companies/search", { method: "POST", headers: H, body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: "domain", operator: "EQ", value: d.acc.domain }] }], limit: 1 }) });
    if (!sr.ok) throw new Error(`hubspot search ${sr.status}`);
    const cid = (await sr.json()).results?.[0]?.id; if (!cid) throw new Error(`no HubSpot company with domain ${d.acc.domain}`);
    const body = `<p><b>${esc(m.head)}</b></p><p>${esc(m.opener ?? "")}</p><p>${esc(m.summary).replace(/\n\n/g, "</p><p>")}</p>`;
    const nr = await fetch("https://api.hubapi.com/crm/v3/objects/notes", { method: "POST", headers: H, body: JSON.stringify({ properties: { hs_timestamp: new Date().toISOString(), hs_note_body: body }, associations: [{ to: { id: cid }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 190 }] }] }) });
    if (!nr.ok) throw new Error(`hubspot note ${nr.status}`); return "hubspot note created";
  }
  throw new Error("unknown target kind");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (!(await member(req))) return J({ error: "Sign in as a team member to push briefs.", code: "auth" }, 401);
    const { account_id, mode = "push", reason, target_id, test } = await req.json();
    let q = SB.from("output_targets").select("*").eq("enabled", true); if (target_id) q = q.eq("id", target_id);
    const { data: targets } = await q;
    const stamp = (id: string, ok: boolean, msg: string) => SB.from("output_targets").update({ last_status: ok ? "ok" : "error: " + msg.slice(0, 80), last_at: new Date().toISOString() }).eq("id", id);
    if (test) { // connectivity test: a fixed message, no real account
      const out = [];
      for (const t of targets || []) {
        try { const r = await send(t, { acc: { name: "Test account", domain: "example.com" }, b: { opener: "This is a test from Tech Stack Scout.", summary: [] }, s: null, r: null }, "push"); out.push({ id: t.id, ok: true, r }); await stamp(t.id, true, ""); }
        catch (e) { const msg = String((e as Error).message); out.push({ id: t.id, ok: false, error: msg }); await stamp(t.id, false, msg); }
      }
      return J({ results: out });
    }
    if (!account_id) return J({ error: "account_id required" }, 400);
    if (!targets?.length) return J({ results: [], note: "no enabled output targets" });
    const d = await load(account_id);
    const results = [];
    for (const t of targets) {
      try { const r = await send(t, d, mode, reason); results.push({ id: t.id, label: t.label, ok: true, r }); await SB.from("push_log").insert({ account_id, target_id: t.id, kind: mode, status: "ok", detail: r }); await stamp(t.id, true, ""); }
      catch (e) { const msg = String((e as Error).message).slice(0, 120); results.push({ id: t.id, label: t.label, ok: false, error: msg }); await SB.from("push_log").insert({ account_id, target_id: t.id, kind: mode, status: "error", detail: msg }); await stamp(t.id, false, msg); }
    }
    return J({ results });
  } catch (e) { return J({ error: String((e as Error).message ?? e) }, 500); }
});
