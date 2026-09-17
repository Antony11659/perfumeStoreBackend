// TEMPORARY:
// Stores the current Raspiv workflow until the database-backed
// order/session system is implemented

import { supabase } from "../lib/supabase.js";

export const saveRaspivSession = async (products) => {
    const { error } = await supabase
      .from("raspiv_session")
      .upsert({
        id: 1,
        products: products,
        updated_at: new Date().toISOString()
      });
  
    if (error) {
      throw error;
    }
  };

  export const getRaspivSession = async () => {
    const { data, error } = await supabase
      .from("raspiv_session")
      .select("products")
      .eq("id", 1)
      .single();
  
    if (error) {
      throw error;
    }
  
    return data.products;
  };