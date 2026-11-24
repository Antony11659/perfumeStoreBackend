"""Test SKU SQL under real transaction locking in a local socket-only database."""
from concurrent.futures import ThreadPoolExecutor
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import json
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = spec_from_file_location("catalog_writes", ROOT / "tests/erpCatalogWrites.test.py")
catalog = module_from_spec(spec)
spec.loader.exec_module(catalog)
PRIMARY = "aaaaaaaa-0000-4000-8000-000000000002"
RASPIV = "aaaaaaaa-0000-4000-8000-000000000003"
OTHER = "aaaaaaaa-0000-4000-8000-000000000004"

class SkuWrites(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = catalog.ErpCatalogWrites
        cls.addClassCleanup(cls.fixture.doClassCleanups)
        cls.fixture.setUpClass()
        cls.query = cls.fixture.query
        cls.query(f"""
          CREATE TABLE shops (id uuid PRIMARY KEY, code text NOT NULL, marketplace text NOT NULL);
          INSERT INTO shops VALUES ('{PRIMARY}','primary','Ozon'), ('{RASPIV}','raspiv','Ozon');
          GRANT SELECT, UPDATE ON shops TO service_role;
          ALTER TABLE shop_products ADD COLUMN id uuid DEFAULT gen_random_uuid() NOT NULL UNIQUE,
            ADD COLUMN shop_id uuid NOT NULL REFERENCES shops,
            ADD COLUMN is_active boolean DEFAULT true NOT NULL, ADD COLUMN is_archived boolean DEFAULT false NOT NULL,
            ADD COLUMN updated_at timestamptz DEFAULT now() NOT NULL,
            ADD COLUMN created_at timestamptz DEFAULT now() NOT NULL,
            ADD UNIQUE(shop_id,sku);
        """)
        cls.fixture.checked(*cls.fixture.psql, "-f", ROOT / "supabase/migrations/20261124020000_erp_sku_writes.sql")

    def perfume(self, name):
        return self.query("SET ROLE service_role; " + self.fixture.statement(name))

    def registration(self, perfume, sku, shop=PRIMARY, volume=3, replay="false"):
        return f"SELECT public.erp_create_sku_v1({perfume},'{shop}',{volume},'{sku}',true,false,{replay})"

    def as_service(self, sql):
        return self.query("SET ROLE service_role; " + sql)

    def fail(self, sql, code, role="service_role"):
        result = self.fixture.run_tool([*self.fixture.psql, "-c", f"SET ROLE {role}; {sql}"])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(code, result.stderr)

    def patch(self, row, fields, perfume=None):
        return f"SELECT public.erp_update_sku_v1({perfume or row['perfume_id']},'{row['id']}','{row['updated_at']}','{json.dumps(fields)}')"

    def test_create_and_exact_retry_preserve_text_and_bigint(self):
        perfume = self.perfume("SKU create")
        created = json.loads(self.as_service(self.registration(perfume, "0000123")))
        self.assertEqual(created["sku"], "0000123")
        self.assertEqual(created["perfume_id"], perfume)
        self.assertGreater(int(perfume), 2**53)
        self.assertFalse(created["replayed"])
        replay = json.loads(self.as_service(self.registration(perfume, "0000123", replay="true")))
        self.assertTrue(replay["replayed"])
        self.assertEqual(replay["id"], created["id"])
        self.fail(self.registration(perfume, "0000123"), "23505")
        self.fail(self.registration(perfume, "0000123", volume=10, replay="true"), "23505")
        self.fail(self.registration(perfume, "0000123", shop=RASPIV, replay="true"), "23505")

    def test_invalid_shop_variant_and_ownership(self):
        perfume = self.perfume("SKU validation")
        self.fail(self.registration(perfume, "invalid shop", shop=OTHER), "PT404")
        self.fail(self.registration(perfume, "invalid volume", volume=99), "22023")
        row = json.loads(self.as_service(self.registration(perfume, "belongs here")))
        self.fail(self.patch(row, {"is_active": False}, self.perfume("Other SKU owner")), "PT404")

    def test_status_and_stale_edit(self):
        row = json.loads(self.as_service(self.registration(self.perfume("SKU status"), "status-1")))
        updated = json.loads(self.as_service(self.patch(row, {"is_active": False, "is_archived": True})))
        self.assertFalse(updated["is_active"])
        self.assertTrue(updated["is_archived"])
        self.fail(self.patch(row, {"is_active": True}), "40001")
        restored = json.loads(self.as_service(self.patch(updated, {"is_active": True, "is_archived": False})))
        self.assertTrue(restored["is_active"])
        self.assertFalse(restored["is_archived"])
        self.fail(self.registration(row["perfume_id"], row["sku"], replay="false"), "23505")

    def test_identity_reassignment_and_permanent_delete_blocked(self):
        perfume = self.perfume("SKU protected")
        row = json.loads(self.as_service(self.registration(perfume, "locked")))
        for fields in ({"sku": "new"}, {"volume_ml": 10}, {"shop_id": RASPIV},
                       {"perfume_id": self.perfume("Protected target")}):
            self.fail(self.patch(row, fields), "P0001")
        archived = json.loads(self.as_service(self.patch(row, {"is_archived": True})))
        self.fail(f"SELECT public.erp_delete_sku_v1({perfume},'{archived['id']}')", "P0001")
        self.assertEqual(self.query("SELECT count(*) FROM shop_products WHERE sku='locked'"), "1")

    def test_raspiv_and_concurrent_duplicate(self):
        perfume = self.perfume("Raspiv competition")
        sqls = [self.registration(perfume, sku, shop=RASPIV) for sku in ("raspiv one", "raspiv two")]
        with ThreadPoolExecutor(2) as pool:
            results = list(pool.map(lambda sql: self.fixture.run_tool([*self.fixture.psql, "-c", "SET ROLE service_role; " + sql]), sqls))
        self.assertEqual(sum(result.returncode == 0 for result in results), 1)
        self.assertTrue(any("PT409" in result.stderr for result in results))
        row = json.loads(next(result.stdout for result in results if result.returncode == 0))
        self.fail(self.patch(row, {"is_archived": True}), "P0001")
        other = self.perfume("Global competition")
        concurrent = [self.registration(perfume, "global race"), self.registration(other, "global race")]
        with ThreadPoolExecutor(2) as pool:
            results = list(pool.map(lambda sql: self.fixture.run_tool([*self.fixture.psql, "-c", "SET ROLE service_role; " + sql]), concurrent))
        self.assertEqual(sum(result.returncode == 0 for result in results), 1)
        self.assertTrue(any("23505" in result.stderr for result in results))

    def test_only_service_role_executes(self):
        sql = self.registration(self.perfume("SKU authorization"), "deny me")
        for role in ("anon", "authenticated"):
            self.fail(sql, "42501", role)

if __name__ == "__main__":
    unittest.main(verbosity=2)
