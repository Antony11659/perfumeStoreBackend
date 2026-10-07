import { supabase } from "../../lib/supabase.js";

export const saveOzonSession = async (session) => {
  const { data, error } = await supabase
    .from("ozon_session")
    .upsert({
      id: 1,
      updated_at: new Date().toISOString(),
      shops: session.shops,
    })
    .select()
    .single();

  if (error) {
    throw new Error(
      `Failed to save Ozon session: ${error.message}`
    );
  }

  return data;
};



export const getOzonSession = async () => {
  const { data, error } = await supabase
    .from("ozon_session")
    .select("*")
    .eq("id", 1)
    .single();

  if (error) {
    let supabaseHostname = null;
    let supabaseHttps = false;

    try {
      const url = new URL(process.env.SUPABASE_URL);
      supabaseHostname = url.hostname;
      supabaseHttps = url.protocol === "https:";
    } catch {
      // Keep diagnostics from replacing the original Supabase error.
    }

    console.error("getOzonSession Supabase diagnostic", JSON.stringify({
      message: error.message,
      details: error.details,
      hint: error.hint,
      code: error.code,
      supabaseUrlExists: Boolean(process.env.SUPABASE_URL),
      supabaseHostname,
      supabaseHttps,
    }));

    throw new Error(
      `Failed to get Ozon session: ${error.message}`,
      { cause: error }
    );
  }

  return data;

};
