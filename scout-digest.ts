// Tech Stack Scout — weekly digest: best windows to act on, what changed, fresh openers. Sent to Slack/webhook targets.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
const SB = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const J = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const PRIVATE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1)/i;
const OPEN = ["decision", "building", "post_decision"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    let body: any = {}; try { body = await req.json(); } catch { /* cron sends {} */ }
    const dry = !!body.dry_run;
    const { data: wl } = await SB.from("watchlist").select("id,name,domain,stage,owner").eq("active", true).eq("is_demo", !!body.demo);
    const ids = (wl || []).map((w) => w.id); const nm = new Map((wl || []).map((w) => [w.id, w]));
    if (!ids.length) return J({ sent: 0, note: "empty watchlist" });
    const since = new Date(Date.now() - 7 * 864e5).toISOString();
    const [{ data: radar }, { data: snaps }, { data: briefs }] = await Promise.all([
      SB.from("radar").select("account_id,phase,weeks_in_phase,gap,window_score,play").in("account_id", ids).in("phase", OPEN).order("window_score", { ascending: false }).limit(5),
      SB.from("snapshots").select("account_id,diff,taken_at,material").in("account_id", ids).gte("taken_at", since).eq("material", true),
      SB.from("briefs").select("account_id,opener,hook_type,created_at").in("account_id", ids).gte("created_at", since).order("created_at", { ascending: false }),
    ]);
    const lines = [`Tech Stack Scout weekly digest (${new Date().toISOString().slice(0, 10)})`];
    const top = (radar || []).filter((r) => Number(r.window_score) > 0);
    if (top.length) { lines.push("\nBest windows to act on now:"); top.slice(0, 3).forEach((r, i) => lines.push(`${i + 1}. ${nm.get(r.account_id)?.name} — ${String(r.phase).replace("_", " ")}${r.weeks_in_phase != null ? `, week ${r.weeks_in_phase}` : ""}. ${r.play ?? ""}`)); }
    const changed = new Map<string, string[]>();
    for (const s of snaps || []) { const d = (s.diff || []).filter((x: string) => x !== "First snapshot"); if (d.length) changed.set(s.account_id, [...(changed.get(s.account_id) || []), ...d]); }
    if (changed.size) { lines.push("\nWhat changed this week:"); for (const [id, d] of [...changed].slice(0, 6)) lines.push(`- ${nm.get(id)?.name}: ${[...new Set(d)].slice(0, 3).join("; ")}`); }
    const fresh = (briefs || []).filter((b) => b.opener).slice(0, 3);
    if (fresh.length) { lines.push("\nFresh openers:"); fresh.forEach((b) => lines.push(`- ${nm.get(b.account_id)?.name}: ${b.opener}`)); }
    if (lines.length === 1) lines.push("\nNothing material changed on the watchlist this week.");
    else if (!top.length) lines.push("\nNo account is in an open decision window yet. Radar needs two or more weekly snapshots per account.");
    const text = lines.join("\n");
    if (dry) return J({ text });
    const { data: targets } = await SB.from("output_targets").select("*").eq("enabled", true).in("kind", ["slack", "webhook"]);
    const out = [];
    for (const t of targets || []) {
      try {
        if (!/^https:\/\//.test(t.url) || PRIVATE.test(t.url.replace(/^https:\/\//, ""))) throw new Error("bad url");
        const payload = t.kind === "slack" ? { text } : { event: "scout.digest", text, windows: top.map((r) => ({ name: nm.get(r.account_id)?.name, ...r })) };
        const r = await fetch(t.url, { method: "POST", headers: { "Content-Type": "application/json", ...(t.kind === "webhook" && t.token ? { Authorization: `Bearer ${t.token}` } : {}) }, body: JSON.stringify(payload) });
        if (!r.ok) throw new Error(`status ${r.status}`);
        out.push({ id: t.id, ok: true }); await SB.from("push_log").insert({ target_id: t.id, kind: "digest", status: "ok", detail: "digest sent" });
      } catch (e) { out.push({ id: t.id, ok: false }); await SB.from("push_log").insert({ target_id: t.id, kind: "digest", status: "error", detail: String((e as Error).message).slice(0, 100) }); }
    }
    return J({ sent: out.filter((o) => o.ok).length, targets: out.length, text });
  } catch (e) { return J({ error: String((e as Error).message ?? e) }, 500); }
});
