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
    throw new Error(
      `Failed to get Ozon session: ${error.message}`
    );
  }

  return data;

};