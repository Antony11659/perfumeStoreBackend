import assert from "node:assert/strict";
import { test } from "node:test";

test("the existing sticking-label input reports a detached ordered SKU as unknown until rematched", async t => {
  process.env.SUPABASE_URL = "http://127.0.0.1:1";
  process.env.SUPABASE_SECRET_KEY = "fixture-only";
  const { supabase } = await import("../src/lib/supabase.js");
  const { prepareStickingLabels } = await import("../src/modules/ozon/ozonService.js");
  let mapped = false;
  t.mock.method(supabase, "from", table => ({
    select: () => ({
      in: async () => {
        if (table === "shop_products") return { data: mapped ? [{ sku: "123", perfume_id: 42, volume_ml: 10 }] : [] };
        assert.equal(table, "perfumes");
        return { data: [{ id: 42, name: "Corrected perfume" }] };
      },
    }),
  }));
  const session = { shops: [{ shop: "fixture", orders: [{
    scanit: "123", posting_number: "fixture-order", products: [{ sku: 123, offer_id: "fixture-offer", quantity: 2 }],
  }] }] };

  const detached = await prepareStickingLabels(session);
  assert.deepEqual(detached.labels, []);
  assert.deepEqual(detached.unknownProducts, [{ sku: "123", shop: "fixture", offer_id: "fixture-offer", quantity: 2 }]);

  mapped = true;
  const rematched = await prepareStickingLabels(session);
  assert.deepEqual(rematched.unknownProducts, []);
  assert.deepEqual(rematched.labels, [{ name: "Corrected perfume", quantity: 2 }]);
});
