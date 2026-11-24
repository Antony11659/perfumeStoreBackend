"""Exercise guarded perfume deletion against a disposable socket-only PostgreSQL database."""
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
SERVICE = "SET ROLE service_role; "

class PerfumeDeletion(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = catalog.ErpCatalogWrites
        cls.addClassCleanup(cls.fixture.doClassCleanups)
        cls.fixture.setUpClass()
        cls.query = cls.fixture.query
        cls.psql = cls.fixture.psql
        cls.query("""
            CREATE TABLE perfume_images (
                id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                perfume_id bigint NOT NULL REFERENCES perfumes ON DELETE CASCADE
            );
            ALTER TABLE perfume_images ENABLE ROW LEVEL SECURITY;
            GRANT SELECT ON perfume_images TO service_role;
            ALTER TABLE shop_products
                ADD COLUMN is_active boolean NOT NULL DEFAULT true,
                ADD COLUMN is_archived boolean NOT NULL DEFAULT false;
        """)
        cls.fixture.checked(*cls.psql, "-f", ROOT / "supabase/migrations/20261124030000_erp_perfume_delete.sql")

    def perfume(self, name):
        return self.query(SERVICE + self.fixture.statement(name))

    def preview(self, perfume):
        return json.loads(self.query(f"{SERVICE}SELECT public.erp_perfume_dependencies_v1({perfume})"))

    def command(self, perfume):
        return f"SELECT public.erp_delete_perfume_v1({perfume})"

    def error(self, sql, code, role="service_role"):
        result = self.fixture.run_tool([*self.psql, "-c", f"SET ROLE {role}; {sql}"])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(code, result.stderr)
        return result.stderr

    def blocked(self, perfume):
        error = self.error(self.command(perfume), "P0001")
        detail = next(line.split("DETAIL:", 1)[1] for line in error.splitlines() if "DETAIL:" in line)
        self.assertEqual(self.query(f"SELECT count(*) FROM perfumes WHERE id={perfume}"), "1")
        return json.loads(detail)

    def variant(self, perfume):
        return self.query(f"SELECT id FROM perfume_variants WHERE perfume_id={perfume} ORDER BY id LIMIT 1")

    def test_safe_delete_cascades_only_unused_variants_and_preserves_bigint(self):
        perfume = self.perfume("Safe deletion")
        self.assertGreater(int(perfume), 2**53)
        self.assertEqual(self.preview(perfume), {
            "variants": 2, "skuMappings": 0, "websiteOrderItems": 0, "images": 0,
            "unverifiedForeignKeys": 0, "canDelete": True,
        })
        self.assertEqual(json.loads(self.query(SERVICE + self.command(perfume))), {"id": perfume})
        for table, key in (("perfumes", "id"), ("perfume_variants", "perfume_id")):
            self.assertEqual(self.query(f"SELECT count(*) FROM {table} WHERE {key}={perfume}"), "0")
        self.error(f"SELECT public.erp_perfume_dependencies_v1({perfume})", "PT404")
        self.error(self.command(perfume), "PT404")

    def test_all_dependency_counts_include_inactive_and_archived(self):
        perfume = self.perfume("Referenced perfume")
        variant = self.variant(perfume)
        self.query(f"""
            INSERT INTO shop_products (sku,perfume_id,volume_ml,is_active,is_archived)
            VALUES ('ACTIVE',{perfume},3,true,false), ('INACTIVE',{perfume},3,false,false),
                   ('ARCHIVED',{perfume},10,true,true);
            INSERT INTO website_order_items(variant_id) VALUES ({variant}), ({variant});
            INSERT INTO perfume_images(perfume_id) VALUES ({perfume});
        """)
        expected = {"variants": 2, "skuMappings": 3, "websiteOrderItems": 2, "images": 1,
                    "unverifiedForeignKeys": 0, "canDelete": False}
        self.assertEqual(self.preview(perfume), expected)
        self.assertEqual(self.blocked(perfume), expected)
        self.assertEqual(self.query(f"SELECT count(*) FROM perfume_images WHERE perfume_id={perfume}"), "1")
        self.assertEqual(self.query(f"SELECT count(*) FROM shop_products WHERE perfume_id={perfume}"), "3")
        self.assertEqual(self.query(f"SELECT count(*) FROM website_order_items WHERE variant_id={variant}"), "2")

    def test_unverified_cascade_blocks_even_without_rows(self):
        perfume = self.perfume("Unverified cascade")
        self.query("CREATE TABLE extra_perfume_reference (perfume_id bigint REFERENCES perfumes ON DELETE CASCADE)")
        try:
            counts = self.preview(perfume)
            self.assertEqual(counts["unverifiedForeignKeys"], 1)
            self.assertFalse(counts["canDelete"])
            self.assertEqual(self.blocked(perfume), counts)
        finally:
            self.query("DROP TABLE extra_perfume_reference")

    def test_concurrent_reference_after_preview_blocks_deletion(self):
        for dependency in ("images", "skuMappings", "websiteOrderItems"):
            with self.subTest(dependency=dependency):
                perfume = self.perfume("Race " + dependency)
                variant = self.variant(perfume)
                self.assertTrue(self.preview(perfume)["canDelete"])
                insert = {
                    "images": f"INSERT INTO perfume_images(perfume_id) VALUES ({perfume})",
                    "skuMappings": f"INSERT INTO shop_products (sku,perfume_id,volume_ml) VALUES ('RACE SKU',{perfume},3)",
                    "websiteOrderItems": f"INSERT INTO website_order_items(variant_id) VALUES ({variant})",
                }[dependency]
                holder = subprocess.Popen([
                    shutil.which("psql"), *self.psql[1:], "-c",
                    f"SET application_name='erp_perfume_reference'; BEGIN; {insert}; SELECT pg_sleep(1.5); COMMIT;",
                ], env={}, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                try:
                    self.wait_for_holder()
                    self.assertEqual(self.blocked(perfume)[dependency], 1)
                finally:
                    _, stderr = holder.communicate(timeout=10)
                    self.assertEqual(holder.returncode, 0, stderr.decode())

    def wait_for_holder(self):
        for _ in range(60):
            if self.query("SELECT EXISTS (SELECT 1 FROM pg_stat_activity "
                          "WHERE application_name='erp_perfume_reference' AND wait_event='PgSleep')") == "t":
                return
            time.sleep(0.025)
        self.fail("Transaction did not reach the concurrency barrier")

    def test_reference_started_after_delete_lock_cannot_commit(self):
        perfume = self.perfume("Deletion wins")
        holder = subprocess.Popen([
            shutil.which("psql"), *self.psql[1:], "-c",
            f"SET application_name='erp_perfume_reference'; {SERVICE} BEGIN; {self.command(perfume)}; "
            "SELECT pg_sleep(1.5); COMMIT;",
        ], env={}, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            self.wait_for_holder()
            inserted = self.fixture.run_tool([*self.psql, "-c",
                f"INSERT INTO perfume_images(perfume_id) VALUES ({perfume})"])
            self.assertIn("23503", inserted.stderr)
        finally:
            _, stderr = holder.communicate(timeout=10)
            self.assertEqual(holder.returncode, 0, stderr.decode())
        self.assertEqual(self.query(f"SELECT count(*) FROM perfumes WHERE id={perfume}"), "0")

    def test_only_backend_role_executes_and_unsafe_isolation_fails_closed(self):
        perfume = self.perfume("Permission fixture")
        for role in ("anon", "authenticated"):
            self.error(f"SELECT public.erp_perfume_dependencies_v1({perfume})", "42501", role)
            self.error(self.command(perfume), "42501", role)
        self.error("BEGIN ISOLATION LEVEL REPEATABLE READ; " + self.command(perfume), "0A000")
        self.assertTrue(self.preview(perfume)["canDelete"])

if __name__ == "__main__":
    unittest.main(verbosity=2)
