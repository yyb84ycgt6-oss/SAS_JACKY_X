import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Verify user identity
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const admin = createClient(supabaseUrl, serviceKey);

  try {
    const body = await req.json();
    const { action } = body;

    // ── Log Transaction ──
    if (action === "log") {
      const { record } = body;
      if (!record?.transaction_type || !record?.currency_type || record?.amount == null) {
        return new Response(JSON.stringify({ error: "Invalid record" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { error } = await admin.from("game_transactions").insert({
        user_id: user.id,
        transaction_type: String(record.transaction_type),
        currency_type: String(record.currency_type),
        amount: Number(record.amount),
        balance_before: Number(record.balance_before) || 0,
        balance_after: Number(record.balance_after) || 0,
        source: String(record.source || "unknown"),
        source_id: record.source_id ? String(record.source_id) : null,
        metadata: record.metadata || {},
      });

      if (error) throw error;
      return new Response(JSON.stringify({ logged: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Dedup Check ──
    if (action === "dedup") {
      const { transaction_id, source } = body;
      if (!transaction_id || !source) {
        return new Response(JSON.stringify({ error: "Missing fields" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { error } = await admin.from("game_purchase_locks").insert({
        user_id: user.id,
        transaction_id: String(transaction_id),
        source: String(source),
      });

      if (error && error.code === "23505") {
        return new Response(JSON.stringify({ duplicate: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (error) throw error;

      return new Response(JSON.stringify({ duplicate: false }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Unknown action" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("game-transaction error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Internal error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
