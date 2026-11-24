"""Apply both drafts to a disposable database, then rerun the workflow SQL tests."""
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import json
import shutil
import subprocess
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
DRAFT = ROOT / "docs/migration-drafts/20261123235959_erp_catalog_browser_privileges.sql"
INVENTORY = ROOT / "docs/migration-drafts/public-rpc-inventory.sql"
ERP = ROOT / "supabase/migrations/20261124000000_erp_catalog_writes.sql"

spec = spec_from_file_location("payment_reservation", ROOT / "tests/websitePaymentReservation.test.py")
payment = module_from_spec(spec)
spec.loader.exec_module(payment)

FIXTURE = """
CREATE TABLE brands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL UNIQUE, country text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE volumes (volume_ml smallint PRIMARY KEY);
CREATE TABLE perfumes (
  id bigint GENERATED ALWAYS AS IDENTITY (START WITH 9007199254740993) PRIMARY KEY,
  name text NOT NULL, brand_id uuid NOT NULL REFERENCES brands ON DELETE RESTRICT,
  gender text, fragrance_family text, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (brand_id, name)
);
CREATE TABLE perfume_variants (
  id bigint GENERATED ALWAYS AS IDENTITY (START WITH 1000) PRIMARY KEY,
  perfume_id bigint NOT NULL REFERENCES perfumes ON DELETE CASCADE,
  volume_ml integer NOT NULL REFERENCES volumes ON DELETE RESTRICT, UNIQUE (perfume_id, volume_ml)
);
ALTER TABLE website_order_items ADD FOREIGN KEY (variant_id) REFERENCES perfume_variants;
CREATE TABLE perfume_images (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  perfume_id bigint NOT NULL REFERENCES perfumes ON DELETE CASCADE, image_url text NOT NULL
);
CREATE TABLE shops (id uuid PRIMARY KEY, code text NOT NULL);
CREATE TABLE shop_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sku text NOT NULL UNIQUE, shop_id uuid NOT NULL REFERENCES shops,
  perfume_id bigint NOT NULL, volume_ml smallint NOT NULL, UNIQUE (shop_id, sku),
  FOREIGN KEY (perfume_id, volume_ml) REFERENCES perfume_variants (perfume_id, volume_ml) ON DELETE RESTRICT
);
CREATE TABLE prices (id bigint PRIMARY KEY, volume_ml smallint NOT NULL REFERENCES volumes, website_price numeric);
INSERT INTO volumes VALUES (3), (10), (20);
INSERT INTO prices VALUES (1, 3, 10);
INSERT INTO shops VALUES ('bbbbbbbb-0000-4000-8000-000000000001', 'fixture');

ALTER TABLE brands ENABLE ROW LEVEL SECURITY;
ALTER TABLE volumes ENABLE ROW LEVEL SECURITY;
ALTER TABLE perfumes ENABLE ROW LEVEL SECURITY;
ALTER TABLE perfume_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE perfume_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE shops ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE website_order_items ENABLE ROW LEVEL SECURITY;
GRANT ALL ON brands, volumes, perfumes, perfume_variants, perfume_images, shops, shop_products, prices
  TO service_role;
GRANT SELECT ON website_order_items TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON brands, volumes, perfumes, perfume_variants, perfume_images, shops, shop_products, prices,
     website_orders, website_order_items TO anon, authenticated;
GRANT SELECT(name), UPDATE(country) ON brands TO PUBLIC;
GRANT USAGE ON perfumes_id_seq, perfume_variants_id_seq, perfume_images_id_seq,
  website_orders_id_seq TO service_role, anon, authenticated;
CREATE FUNCTION public.audit_fixture_definer() RETURNS integer
  LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$ SELECT 1 $$;
"""

class CatalogPrivileges(payment.PaymentReservationTest):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.query(FIXTURE)
        cls.query("CREATE ROLE inherited_browser; GRANT inherited_browser TO authenticated; "
                  "GRANT TRUNCATE ON website_order_items TO inherited_browser")
        cls.check_rollback("Residual effective privileges")
        cls.query("REVOKE inherited_browser FROM authenticated; "
                  "REVOKE SELECT ON prices FROM service_role; GRANT SELECT ON prices TO PUBLIC")
        cls.check_rollback("Effective service_role privileges changed")
        cls.query("GRANT SELECT ON prices TO service_role; REVOKE SELECT ON prices FROM PUBLIC")
        cls.query("GRANT EXECUTE ON FUNCTION public.persist_website_order_v1(uuid,text,jsonb) TO authenticated")
        cls.check_rollback("Unexpected execution privileges")
        cls.query("REVOKE EXECUTE ON FUNCTION public.persist_website_order_v1(uuid,text,jsonb) FROM authenticated")
        cls.run_tool(*cls.psql, "-f", DRAFT)
        cls.run_tool(*cls.psql, "-f", ERP)

        # Seed the variants consumed by the inherited order workflow fixtures.
        cls.query("INSERT INTO brands (name) VALUES ('Order fixture'); "
                  "INSERT INTO perfumes (name,brand_id) SELECT 'Workflow fixture', id FROM brands WHERE name='Order fixture'; "
                  "INSERT INTO perfume_variants (id,perfume_id,volume_ml) OVERRIDING SYSTEM VALUE "
                  "SELECT fixture.variant_id, perfumes.id, fixture.volume_ml FROM perfumes "
                  "CROSS JOIN (VALUES (1,3), (422,10), (423,20)) AS fixture(variant_id,volume_ml)")

    @classmethod
    def check_rollback(cls, message):
        try:
            cls.run_tool(*cls.psql, "-f", DRAFT)
        except RuntimeError as error:
            if message not in str(error):
                raise
        else:
            raise AssertionError("Draft must reject: " + message)
        if cls.query("SELECT has_table_privilege('authenticated','brands','TRUNCATE')") != "t":
            raise AssertionError("Revocations before a failed assertion must roll back")

    def test_browser_table_column_sequence_and_rpc_privileges(self):
        self.assertEqual(self.query("""
            SELECT bool_and(NOT has_table_privilege(role_name, relation, 'TRUNCATE')
                            AND NOT has_table_privilege(role_name, relation, 'TRIGGER')
                            AND NOT has_any_column_privilege(role_name, relation, 'SELECT')
                            AND NOT has_any_column_privilege(role_name, relation, 'UPDATE'))
            FROM unnest(ARRAY['anon','authenticated']) AS role_name
            CROSS JOIN unnest(ARRAY['brands','perfumes','perfume_variants','volumes','prices','shops',
              'shop_products','perfume_images','website_orders','website_order_items']) AS relation
        """), "t")
        self.assertEqual(self.query("SELECT has_sequence_privilege('anon','perfumes_id_seq','USAGE')"), "f")
        self.assertEqual(self.query("SELECT has_sequence_privilege('service_role','perfumes_id_seq','USAGE')"), "t")
        self.assertEqual(self.query("SELECT has_function_privilege('authenticated','public.erp_create_brand_v1(text,text)','EXECUTE')"), "f")
        with self.assertRaisesRegex(RuntimeError, "permission denied"):
            self.query("SET ROLE anon; SELECT * FROM prices")

    def test_catalog_packaging_and_prices_service_access(self):
        result = json.loads(self.query("""
            SET ROLE service_role;
            WITH mapping AS (
              INSERT INTO shop_products(sku,shop_id,perfume_id,volume_ml)
              SELECT 'Fixture SKU', shops.id, perfumes.id, 3 FROM shops CROSS JOIN perfumes
              WHERE perfumes.name='Workflow fixture'
              RETURNING sku,perfume_id,volume_ml
            )
            SELECT jsonb_build_object('sku',mapping.sku,'name',perfumes.name,'price',prices.website_price)
            FROM mapping JOIN perfumes ON perfumes.id=mapping.perfume_id
            JOIN prices ON prices.volume_ml=mapping.volume_ml
        """))
        self.assertEqual(result, {"sku": "Fixture SKU", "name": "Workflow fixture", "price": 10})
        self.assertEqual(self.query("""
            SET ROLE service_role;
            SELECT public.erp_create_brand_v1('ERP fixture',NULL)->>'name'
        """), "ERP fixture")
        self.assertEqual(self.query("""
            SET ROLE service_role;
            SELECT public.erp_create_perfume_v1('ERP perfume',id,'U',NULL,ARRAY[3,10])->>'name'
            FROM brands WHERE name='ERP fixture'
        """), "ERP perfume")
        self.assertEqual(self.query("SELECT count(*) FROM perfume_variants v JOIN perfumes p ON p.id=v.perfume_id WHERE p.name='ERP perfume'"), "2")

    def test_marketplace_mapping_race_blocks_identity_update(self):
        self.query("SET ROLE service_role; SELECT public.erp_create_brand_v1('Mapping race brand', NULL)")
        identifier = int(self.query("""
            SET ROLE service_role;
            SELECT public.erp_create_perfume_v1('Mapping race perfume', id, 'U', NULL, ARRAY[3])->>'id'
            FROM brands WHERE name='Mapping race brand'
        """))
        mapping = subprocess.Popen([
            shutil.which("psql"), *self.psql[1:], "-c",
            "SET application_name='erp_mapping_race'; SET ROLE service_role; BEGIN; "
            "INSERT INTO shop_products(sku,shop_id,perfume_id,volume_ml) "
            f"SELECT 'Mapping race SKU',id,{identifier},3 FROM shops; SELECT pg_sleep(2); COMMIT;",
        ], env={}, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            for _ in range(60):
                if self.query("SELECT EXISTS (SELECT 1 FROM pg_stat_activity "
                              "WHERE application_name='erp_mapping_race' AND wait_event='PgSleep')") == "t":
                    break
                time.sleep(0.025)
            else:
                self.fail("The mapping insert did not reach its hold period")
            with self.assertRaisesRegex(RuntimeError, "Catalog identity has order or marketplace dependencies"):
                self.query(f"""SET ROLE service_role;
                    SELECT public.erp_update_perfume_v1({identifier}, '{{"name":"Unsafe rename"}}')""")
            self.assertEqual(self.query(f"SELECT name FROM perfumes WHERE id={identifier}"), "Mapping race perfume")
        finally:
            _, stderr = mapping.communicate(timeout=10)
            self.assertEqual(mapping.returncode, 0, stderr.decode())

    def test_rpc_inventory_reports_unknown_definer_without_mutating_it(self):
        metadata = self.run_tool(*self.psql, "-f", INVENTORY)
        row = next(row for row in metadata.splitlines() if "|audit_fixture_definer|" in row)
        self.assertEqual(row.split("|")[4], "t")
        self.assertEqual(row.split("|")[7], "t")

if __name__ == "__main__":
    unittest.main(verbosity=2)
