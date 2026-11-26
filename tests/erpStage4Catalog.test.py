"""Validate the Stage 4 draft with disposable PostgreSQL catalog fixtures."""
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import json
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = spec_from_file_location("sku_writes", ROOT / "tests/erpSkuWrites.test.py")
sku_writes = module_from_spec(spec)
spec.loader.exec_module(sku_writes)


class Stage4Catalog(sku_writes.SkuWrites):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.query("""
            ALTER TABLE perfume_variants ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
            CREATE TABLE perfume_images (
              id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
              perfume_id bigint NOT NULL REFERENCES perfumes ON DELETE CASCADE
            );
            CREATE TABLE erp_master_publications (perfume_id bigint PRIMARY KEY);
            INSERT INTO volumes VALUES (30);
        """)
        for filename in ["20261124010000_erp_variant_writes.sql", "20261124030000_erp_perfume_delete.sql"]:
            cls.fixture.checked(*cls.fixture.psql, "-f", ROOT / "supabase/migrations" / filename)
        cls.fixture.checked(*cls.fixture.psql, "-f", ROOT / "docs/migration-drafts/erp-stage-4-catalog.sql")

    test_identity_reassignment_and_permanent_delete_blocked = None

    def test_transfer_unmatch_and_rematch_preserve_identity(self):
        source = self.perfume("Stage 4 source")
        target = self.perfume("Stage 4 target")
        row = json.loads(self.as_service(self.registration(source, "stage4-original")))
        corrected = json.loads(self.as_service(self.patch(row, {
            "perfume_id": target, "sku": "stage4-corrected", "volume_ml": 10,
        })))
        self.assertEqual((corrected["id"], corrected["perfume_id"], corrected["volume_ml"]), (row["id"], target, 10))
        self.fail(self.patch(row, {"volume_ml": 10}), "PT404")
        self.as_service(f"SELECT public.erp_unmatch_sku_v1({target},'{row['id']}','{corrected['updated_at']}')")
        self.assertEqual(self.query("SELECT count(*) FROM shop_products WHERE sku='stage4-corrected'"), "0")
        self.assertEqual(self.query("SELECT shop_id FROM erp_unmatched_skus WHERE sku='stage4-corrected'"), sku_writes.PRIMARY)
        self.fail(self.registration(source, "stage4-corrected", shop=sku_writes.RASPIV), "23505")
        restored = json.loads(self.as_service(self.registration(source, "stage4-corrected")))
        self.assertEqual(restored["id"], row["id"])
        self.assertEqual(self.query("SELECT count(*) FROM erp_unmatched_skus WHERE sku='stage4-corrected'"), "0")

    def test_identity_and_volume_corrections_preserve_history_and_mappings(self):
        source = self.perfume("Stage 4 historical")
        brand = json.loads(self.as_service("SELECT public.erp_create_brand_v1('Stage 4 brand',NULL)"))["id"]
        row = json.loads(self.as_service(self.registration(source, "stage4-history")))
        variant = self.query(f"SELECT id FROM perfume_variants WHERE perfume_id={source} AND volume_ml=3")
        self.query(f"INSERT INTO website_order_items(variant_id) VALUES ({variant})")
        corrected = json.loads(self.as_service(
            f"""SELECT public.erp_update_perfume_v1({source},'{{"name":"Corrected","brand_id":"{brand}"}}')"""
        ))
        self.assertEqual((corrected["id"], corrected["name"], corrected["brand_id"]), (source, "Corrected", brand))
        self.as_service(f"SELECT public.erp_change_variant_v1({source},{variant},30)")
        self.assertEqual(self.query(f"SELECT volume_ml FROM shop_products WHERE id='{row['id']}'"), "30")
        self.fail(self.patch(row, {"sku": "stale-history"}), "40001")
        self.fail(f"SELECT public.erp_delete_perfume_v1({source})", "P0001")
        self.assertEqual(self.query(f"SELECT variant_id FROM website_order_items WHERE variant_id={variant}"), variant)

    def test_perfume_deletion_detaches_mappings_and_preserves_publication(self):
        source = self.perfume("Stage 4 deletion")
        target = self.perfume("Stage 4 replacement")
        first = json.loads(self.as_service(self.registration(source, "stage4-delete-first")))
        second = json.loads(self.as_service(self.registration(source, "stage4-delete-second", shop=sku_writes.RASPIV)))
        self.query(f"INSERT INTO erp_master_publications VALUES ({source})")
        self.fail(f"SELECT public.erp_delete_perfume_v1({source})", "P0001")
        self.assertEqual(self.query(f"SELECT count(*) FROM shop_products WHERE perfume_id={source}"), "2")
        self.query(f"DELETE FROM erp_master_publications WHERE perfume_id={source}")
        preview = json.loads(self.as_service(f"SELECT public.erp_perfume_dependencies_v1({source})"))
        self.assertTrue(preview["canDelete"])
        self.assertEqual(preview["skuMappings"], 2)
        self.as_service(f"SELECT public.erp_delete_perfume_v1({source})")
        self.assertEqual(self.query(f"SELECT count(*) FROM perfume_variants WHERE perfume_id={source}"), "0")
        self.assertEqual(self.query("SELECT count(*) FROM shop_products WHERE sku LIKE 'stage4-delete-%'"), "0")
        self.assertEqual(self.query("SELECT count(*) FROM erp_unmatched_skus WHERE sku LIKE 'stage4-delete-%'"), "2")
        for row in [first, second]:
            result = json.loads(self.as_service(self.registration(target, row["sku"], shop=row["shop_id"])))
            self.assertEqual(result["id"], row["id"])

    def test_mapping_detachment_rolls_back_if_perfume_delete_fails_late(self):
        source = self.perfume("Stage 4 atomic deletion")
        self.as_service(self.registration(source, "stage4-atomic"))
        self.query(f"""
          CREATE FUNCTION fail_fixture_delete() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF OLD.id = {source} THEN RAISE EXCEPTION 'Fixture failure'; END IF;
            RETURN OLD;
          END;
          $$;
          CREATE TRIGGER fail_fixture_delete BEFORE DELETE ON perfumes
          FOR EACH ROW EXECUTE FUNCTION fail_fixture_delete();
        """)
        try:
            self.fail(f"SELECT public.erp_delete_perfume_v1({source})", "P0001")
            self.assertEqual(self.query(f"SELECT count(*) FROM perfumes WHERE id={source}"), "1")
            self.assertEqual(self.query("SELECT count(*) FROM shop_products WHERE sku='stage4-atomic'"), "1")
            self.assertEqual(self.query("SELECT count(*) FROM erp_unmatched_skus WHERE sku='stage4-atomic'"), "0")
        finally:
            self.query("DROP TRIGGER fail_fixture_delete ON perfumes; DROP FUNCTION fail_fixture_delete()")


if __name__ == "__main__":
    unittest.main()
