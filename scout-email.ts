// Tech Stack Scout — send an outreach email through Resend, from inside the platform.
// Only signed-in team members can call it. The API key lives in the RESEND_API_KEY Edge Function secret and never reaches the browser.
// Every send is logged in the `outreach` table so replies can be tracked (sent -> replied -> meeting).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
const SB = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const J = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const EMAIL = /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$/;

async function member(req: Request) {
  const tok = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data, error } = await SB.auth.getUser(tok);
  const email = data?.user?.email?.toLowerCase();
  if (error || !email) return null;
  const { data: m } = await SB.from("team_members").select("email,name,role,active").eq("email", email).maybeSingle();
  return m?.active ? m : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const who = await member(req);
    if (!who) return J({ error: "Sign in as a team member to send email.", code: "auth" }, 401);
    const key = Deno.env.get("RESEND_API_KEY");
    if (!key) return J({ error: "Email is not set up yet: the RESEND_API_KEY secret is missing.", code: "no_key" }, 503);
    const { account_id, to, subject, body } = await req.json();
    const addr = String(to ?? "").trim(); const subj = String(subject ?? "").trim(); const text = String(body ?? "").trim();
    if (!EMAIL.test(addr)) return J({ error: "Enter one valid recipient address.", code: "bad_to" }, 400);
    if (subj.length < 3 || subj.length > 200) return J({ error: "The subject needs 3 to 200 characters.", code: "bad_subject" }, 400);
    if (text.length < 20 || text.length > 5000) return J({ error: "The message needs 20 to 5000 characters.", code: "bad_body" }, 400);
    const { data: acc } = await SB.from("watchlist").select("id,name,is_demo").eq("id", account_id).maybeSingle();
    if (!acc) return J({ error: "Account not found.", code: "no_account" }, 404);
    if (acc.is_demo) return J({ error: "Demo companies are fictional, so email is blocked for them.", code: "demo" }, 400);
    // simple abuse guard: at most 20 emails an hour and 100 a day per person
    const since = (h: number) => new Date(Date.now() - h * 3600e3).toISOString();
    const [{ count: h1 }, { count: d1 }] = await Promise.all([
      SB.from("outreach").select("id", { count: "exact", head: true }).eq("sent_by", who.email).eq("channel", "email").gte("sent_at", since(1)),
      SB.from("outreach").select("id", { count: "exact", head: true }).eq("sent_by", who.email).eq("channel", "email").gte("sent_at", since(24)),
    ]);
    if ((h1 ?? 0) >= 20 || (d1 ?? 0) >= 100) return J({ error: "Sending limit reached (20 an hour, 100 a day). Try again later.", code: "rate" }, 429);

    const from = Deno.env.get("RESEND_FROM") || "Tech Stack Scout <onboarding@resend.dev>";
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [addr], subject: subj, text, reply_to: who.email }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return J({ error: `Resend refused the email: ${String(j?.message ?? j?.error ?? r.status).slice(0, 220)}`, code: "resend", status: r.status }, 502);

    const { data: b } = await SB.from("briefs").select("id,opener,hook_type").eq("account_id", account_id).order("created_at", { ascending: false }).limit(1).maybeSingle();
    const { data: row } = await SB.from("outreach").insert({ account_id, brief_id: b?.id ?? null, hook_type: b?.hook_type ?? null, opener: b?.opener ?? null, channel: "email", to_email: addr, subject: subj, body: text, sent_by: who.email, resend_id: j?.id ?? null }).select("id").single();
    return J({ ok: true, resend_id: j?.id ?? null, outreach_id: row?.id ?? null, from });
  } catch (e) { return J({ error: String((e as Error).message ?? e) }, 500); }
});
