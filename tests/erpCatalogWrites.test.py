"""Exercise the ERP catalog RPCs in a socket-only disposable PostgreSQL cluster."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest

MIGRATION = Path(__file__).resolve().parents[1] / "supabase/migrations/20261124000000_erp_catalog_writes.sql"
BRAND = "aaaaaaaa-0000-4000-8000-000000000001"
RPC = {
    "erp_create_brand_v1": "text,text",
    "erp_create_perfume_v1": "text,uuid,text,text,integer[]",
    "erp_update_perfume_v1": "bigint,jsonb",
    "erp_update_brand_v1": "uuid,jsonb",
    "erp_assert_perfume_identity_unused_v1": "bigint",
}
FIXTURE = f"""
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role BYPASSRLS;
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
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  perfume_id bigint NOT NULL REFERENCES perfumes ON DELETE CASCADE,
  volume_ml integer NOT NULL REFERENCES volumes ON DELETE RESTRICT,
  CHECK (volume_ml <> 50), UNIQUE (perfume_id, volume_ml)
);
CREATE TABLE shop_products (
  sku text PRIMARY KEY, perfume_id bigint NOT NULL, volume_ml smallint NOT NULL,
  FOREIGN KEY (perfume_id, volume_ml) REFERENCES perfume_variants (perfume_id, volume_ml) ON DELETE RESTRICT
);
CREATE TABLE website_order_items (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  variant_id bigint NOT NULL REFERENCES perfume_variants ON DELETE NO ACTION
);
INSERT INTO brands (id,name) VALUES ('{BRAND}','Fixture');
INSERT INTO volumes VALUES (3), (10), (50);
ALTER TABLE brands ENABLE ROW LEVEL SECURITY;
ALTER TABLE perfumes ENABLE ROW LEVEL SECURITY;
ALTER TABLE perfume_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE volumes ENABLE ROW LEVEL SECURITY;
ALTER TABLE website_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_products ENABLE ROW LEVEL SECURITY;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO service_role;
"""

class ErpCatalogWrites(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        directory = tempfile.TemporaryDirectory(prefix="erp-catalog-pg-", dir="/tmp")
        cls.addClassCleanup(directory.cleanup)
        root = Path(directory.name)
        data = root / "data"
        cls.checked("initdb", "-D", data, "-U", "fixture_admin", "--auth=trust", "--no-locale")
        cls.checked("pg_ctl", "-D", data, "-l", root / "postgres.log", "-o",
                f"-c listen_addresses='' -k {root}", "-w", "start")
        cls.addClassCleanup(cls.checked, "pg_ctl", "-D", data, "-m", "immediate", "-w", "stop")
        cls.psql = ["psql", "-XAtq", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose",
                    "-h", str(root), "-p", "5432", "-U", "fixture_admin", "-d", "postgres"]
        cls.query(FIXTURE)
        cls.checked(*cls.psql, "-f", MIGRATION)

    @staticmethod
    def run_tool(args):
        return subprocess.run([shutil.which(args[0]) or args[0], *args[1:]], env={},
                              capture_output=True, text=True, timeout=20)

    @classmethod
    def checked(cls, *args):
        result = cls.run_tool(args)
        if result.returncode:
            raise RuntimeError(result.stderr)
        return result.stdout.strip()

    @classmethod
    def query(cls, sql):
        return cls.checked(*cls.psql, "-c", sql)

    @classmethod
    def statement(cls, name, volumes="3,10"):
        return f"SELECT public.erp_create_perfume_v1('{name}','{BRAND}','U',NULL,ARRAY[{volumes}])->>'id'"

    def create(self, name, volumes="3,10"):
        return self.query("SET ROLE service_role; " + self.statement(name, volumes))

    def failure(self, sql, code, role="service_role"):
        result = self.run_tool([*self.psql, "-c", f"SET ROLE {role}; {sql}"])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(code, result.stderr)

    def test_creation_and_bigint_projection(self):
        identifier = self.create("Atomic create")
        self.assertGreater(int(identifier), 2 ** 53)
        self.assertEqual(self.query(f"SELECT string_agg(volume_ml::text, ',' ORDER BY volume_ml) FROM perfume_variants WHERE perfume_id={identifier}"), "3,10")

    def test_atomic_rollback_after_variant_failure(self):
        self.failure(self.statement("Must roll back", "3,50"), "23514")
        self.assertEqual(self.query("SELECT count(*) FROM perfumes WHERE name='Must roll back'"), "0")

    def test_invalid_and_duplicate_volumes(self):
        self.failure(self.statement("Bad volume", "9"), "22023")
        self.failure(self.statement("Repeated volume", "3,3"), "22023")
        self.assertEqual(self.query("SELECT count(*) FROM perfumes WHERE name IN ('Bad volume','Repeated volume')"), "0")

    def test_concurrent_duplicate_create_and_case_sensitive_names(self):
        sql = "SET ROLE service_role; " + self.statement("Concurrent exact", "3")
        with ThreadPoolExecutor(2) as pool:
            results = list(pool.map(lambda _: self.run_tool([*self.psql, "-c", sql]), range(2)))
        self.assertEqual(sum(result.returncode == 0 for result in results), 1)
        self.assertTrue(any("23505" in result.stderr for result in results))
        self.create("concurrent exact", "3")

    def test_brand_duplicate_and_country_update(self):
        brand = self.query("SET ROLE service_role; SELECT public.erp_create_brand_v1('New Brand',NULL)->>'id'")
        self.failure("SELECT public.erp_create_brand_v1('New Brand',NULL)", "23505")
        country = self.query(f"""SET ROLE service_role; SELECT public.erp_update_brand_v1('{brand}','{{"country":"France"}}')->>'country'""")
        self.assertEqual(country, "France")
        self.failure(f"""SELECT public.erp_update_brand_v1('{brand}','{{"name":"Fixture"}}')""", "23505")

    def test_history_and_sku_protection_with_safe_edits(self):
        identifier = self.create("Historical")
        self.query(f"INSERT INTO website_order_items(variant_id) SELECT id FROM perfume_variants WHERE perfume_id={identifier} LIMIT 1")
        self.failure(f"""SELECT public.erp_update_perfume_v1({identifier},'{{"name":"New name"}}')""", "P0001")
        other = self.create("Mapped")
        self.query(f"INSERT INTO shop_products VALUES ('001', {other}, 3)")
        self.failure(f"""SELECT public.erp_update_perfume_v1({other},'{{"name":"New label"}}')""", "P0001")
        self.failure(f"""SELECT public.erp_update_brand_v1('{BRAND}','{{"name":"New identity"}}')""", "P0001")
        safe = self.query(f"""SET ROLE service_role; SELECT public.erp_update_perfume_v1({identifier},'{{"fragrance_family":"Woody"}}')->>'fragrance_family'""")
        self.assertEqual(safe, "Woody")
        self.assertEqual(self.query(f"SELECT updated_at > created_at FROM perfumes WHERE id={identifier}"), "t")

    def test_unreferenced_identity_edits_and_duplicate_rename(self):
        identifier = self.create("Editable")
        self.create("Occupied")
        self.failure(f"""SELECT public.erp_update_perfume_v1({identifier},'{{"name":"Occupied"}}')""", "23505")
        name = self.query(f"""SET ROLE service_role; SELECT public.erp_update_perfume_v1({identifier},'{{"name":"Renamed"}}')->>'name'""")
        self.assertEqual(name, "Renamed")
        brand = self.query("SET ROLE service_role; SELECT public.erp_create_brand_v1('Unused',NULL)->>'id'")
        name = self.query(f"""SET ROLE service_role; SELECT public.erp_update_brand_v1('{brand}','{{"name":"Rebranded"}}')->>'name'""")
        self.assertEqual(name, "Rebranded")

    def test_dependency_insert_race_waits_then_rechecks(self):
        identifier = self.create("Dependency race", "3")
        order = subprocess.Popen([shutil.which("psql"), *self.psql[1:], "-c",
            f"BEGIN; INSERT INTO website_order_items(variant_id) SELECT id FROM perfume_variants WHERE perfume_id={identifier}; SELECT pg_sleep(2); COMMIT;"],
            env={}, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            for _ in range(60):
                if self.query("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE wait_event='PgSleep')") == "t":
                    break
                time.sleep(0.025)
            else:
                self.fail("Order transaction did not enter its hold period")
            self.failure(f"""SELECT public.erp_update_perfume_v1({identifier},'{{"name":"Must wait"}}')""", "P0001")
            self.assertEqual(self.query(f"SELECT name FROM perfumes WHERE id={identifier}"), "Dependency race")
        finally:
            _, stderr = order.communicate(timeout=10)
            self.assertEqual(order.returncode, 0, stderr.decode())

    def test_only_backend_role_can_execute(self):
        for role in ["anon", "authenticated", "service_role"]:
            for name, arguments in RPC.items():
                self.assertEqual(
                    self.query(f"SELECT has_function_privilege('{role}', 'public.{name}({arguments})', 'EXECUTE')"),
                    "t" if role == "service_role" else "f",
                )
        self.failure("SELECT public.erp_create_brand_v1('Denied',NULL)", "42501", "authenticated")

if __name__ == "__main__":
    unittest.main(verbosity=2)
