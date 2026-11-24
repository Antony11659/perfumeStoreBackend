"""Run variant mutations in a socket-only disposable PostgreSQL catalog fixture."""
from concurrent.futures import ThreadPoolExecutor
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import json
import shutil
import subprocess
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = spec_from_file_location("catalog_writes", ROOT / "tests/erpCatalogWrites.test.py")
catalog = module_from_spec(spec)
spec.loader.exec_module(catalog)
AS_SERVICE = "SET ROLE service_role; "

class ErpVariantWrites(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.addClassCleanup(catalog.ErpCatalogWrites.doClassCleanups)
        catalog.ErpCatalogWrites.setUpClass()
        cls.query = catalog.ErpCatalogWrites.query
        cls.psql = catalog.ErpCatalogWrites.psql
        cls.query("ALTER TABLE perfume_variants ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(); "
                  "ALTER SEQUENCE perfume_variants_id_seq RESTART WITH 9007199254740993; "
                  "INSERT INTO volumes VALUES (20), (30)")
        catalog.ErpCatalogWrites.checked(*cls.psql, "-f", ROOT / "supabase/migrations/20261124010000_erp_variant_writes.sql")

    def perfume(self, name):
        return int(self.query(AS_SERVICE + catalog.ErpCatalogWrites.statement(name, "3")))

    def add(self, perfume, volume):
        return json.loads(self.query(f"{AS_SERVICE}SELECT public.erp_create_variant_v1({perfume},{volume})"))

    def change_sql(self, perfume, variant, volume):
        return f"SELECT public.erp_change_variant_v1({perfume},{variant},{volume})"

    def change(self, perfume, variant, volume):
        return json.loads(self.query(AS_SERVICE + self.change_sql(perfume, variant, volume)))

    def failure(self, sql, code, role="service_role"):
        result = catalog.ErpCatalogWrites.run_tool([*self.psql, "-c", f"SET ROLE {role}; {sql}"])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(code, result.stderr)
        return result.stderr

    def test_add_edit_and_delete_with_lossless_id_and_updated_at(self):
        perfume = self.perfume("Variant lifecycle")
        created = self.add(perfume, 10)
        self.assertIsInstance(created["id"], str)
        self.assertGreater(int(created["id"]), 2 ** 53)
        updated = self.change(perfume, created["id"], 20)
        self.assertEqual(updated["id"], created["id"])
        self.assertEqual(updated["volume_ml"], 20)
        self.assertGreater(updated["updated_at"], created["updated_at"])
        self.assertEqual(self.change(perfume, created["id"], "NULL"), updated)
        self.assertEqual(self.query(f"SELECT count(*) FROM perfume_variants WHERE id={created['id']}"), "0")

    def test_invalid_volume_wrong_parent_and_duplicate_edit(self):
        perfume = self.perfume("Variant validation")
        another = self.perfume("Another perfume")
        created = self.add(perfume, 10)
        self.failure(f"SELECT public.erp_create_variant_v1({perfume},99)", "22023")
        self.failure(f"SELECT public.erp_create_variant_v1(9223372036854775807,10)", "P0002")
        self.failure(self.change_sql(another, created["id"], "NULL"), "P0002")
        self.failure(self.change_sql(perfume, created["id"], 99), "22023")
        self.failure(self.change_sql(perfume, created["id"], 3), "23505")
        self.assertEqual(self.query(f"SELECT volume_ml FROM perfume_variants WHERE id={created['id']}"), "10")

    def test_concurrent_duplicate_has_one_winner(self):
        perfume = self.perfume("Concurrent variant")
        sql = f"{AS_SERVICE}SELECT public.erp_create_variant_v1({perfume},10)"
        with ThreadPoolExecutor(2) as pool:
            results = list(pool.map(lambda _: catalog.ErpCatalogWrites.run_tool([*self.psql, "-c", sql]), range(2)))
        self.assertEqual(sum(result.returncode == 0 for result in results), 1)
        self.assertTrue(any("23505" in result.stderr for result in results))

    def assert_blocked(self, perfume, variant, volume, orders, mappings):
        failure = self.failure(self.change_sql(perfume, variant, volume), "P0001")
        detail = next(line.split("DETAIL:", 1)[1] for line in failure.splitlines() if "DETAIL:" in line)
        self.assertEqual(json.loads(detail), {"websiteOrders": orders, "marketplaceMappings": mappings})

    def test_both_dependencies_and_noop(self):
        perfume = self.perfume("Referenced variant")
        variant = self.add(perfume, 10)
        self.query(f"INSERT INTO website_order_items(variant_id) VALUES ({variant['id']}); "
                   f"INSERT INTO shop_products VALUES ('Both deps', {perfume}, 10)")
        self.assert_blocked(perfume, variant["id"], 20, True, True)
        self.assert_blocked(perfume, variant["id"], "NULL", True, True)
        self.assertEqual(self.change(perfume, variant["id"], 10), variant)

    def test_uncommitted_order_and_marketplace_inserts_serialize_with_changes(self):
        for is_order in (True, False):
            with self.subTest(is_order=is_order):
                perfume = self.perfume(f"Variant race {is_order}")
                variant = self.add(perfume, 10)["id"]
                insert = (f"INSERT INTO website_order_items(variant_id) VALUES ({variant})" if is_order
                          else f"INSERT INTO shop_products VALUES ('Race SKU', {perfume}, 10)")
                holder = subprocess.Popen([
                    shutil.which("psql"), *self.psql[1:], "-c",
                    f"SET application_name='variant_reference_holder'; BEGIN; {insert}; SELECT pg_sleep(2); COMMIT;",
                ], env={}, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                try:
                    for _ in range(60):
                        if self.query("SELECT EXISTS (SELECT 1 FROM pg_stat_activity "
                                      "WHERE application_name='variant_reference_holder' AND wait_event='PgSleep')") == "t":
                            break
                        time.sleep(0.025)
                    else:
                        self.fail("Reference insert did not reach the concurrency barrier")
                    self.assert_blocked(perfume, variant, 20 if is_order else "NULL", is_order, not is_order)
                    self.assertEqual(self.query(f"SELECT volume_ml FROM perfume_variants WHERE id={variant}"), "10")
                finally:
                    _, stderr = holder.communicate(timeout=10)
                    self.assertEqual(holder.returncode, 0, stderr.decode())

    def test_execution_permissions_and_isolation(self):
        for role in ("anon", "authenticated", "service_role"):
            for signature in ("erp_create_variant_v1(bigint,integer)", "erp_change_variant_v1(bigint,bigint,integer)"):
                self.assertEqual(self.query(f"SELECT has_function_privilege('{role}','public.{signature}','EXECUTE')"),
                                 "t" if role == "service_role" else "f")
        self.failure("SELECT public.erp_create_variant_v1(1,10)", "42501", "anon")
        self.failure("BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT public.erp_change_variant_v1(1,1,NULL)", "0A000")

if __name__ == "__main__":
    unittest.main(verbosity=2)
