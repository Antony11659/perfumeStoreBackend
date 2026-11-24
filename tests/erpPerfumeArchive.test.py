"""Test archiving and actual order persistence on a socket-only disposable cluster."""
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import json
import subprocess
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]
spec = spec_from_file_location("privileges", ROOT / "tests/erpCatalogPrivileges.test.py")
support = module_from_spec(spec)
spec.loader.exec_module(support)
SERVICE = "SET ROLE service_role; "


class PerfumeArchive(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = support.payment.PaymentReservationTest
        cls.addClassCleanup(cls.fixture.doClassCleanups)
        cls.fixture.setUpClass()
        cls.query = cls.fixture.query
        cls.psql = cls.fixture.psql
        cls.query(support.FIXTURE)
        cls.fixture.run_tool(*cls.psql, "-f", support.DRAFT)
        cls.fixture.run_tool(*cls.psql, "-f", support.ERP)
        cls.query("INSERT INTO public.brands(name) VALUES ('Archive fixture')")
        cls.preexisting, cls.preexisting_variant = cls.seed("Preexisting")
        cls.fixture.run_tool(*cls.psql, "-f", ROOT / "supabase/migrations/20261124040000_erp_perfume_archive.sql")

    @classmethod
    def seed(cls, name):
        perfume = json.loads(cls.query(SERVICE + f"""
            SELECT public.erp_create_perfume_v1('{name}',
                (SELECT id FROM public.brands WHERE name='Archive fixture'),'U',NULL,ARRAY[3])
        """))["id"]
        variant = cls.query(f"SELECT id FROM public.perfume_variants WHERE perfume_id={perfume}")
        return perfume, variant

    def archive_sql(self, *perfumes, archived=True):
        return f"SELECT public.erp_set_perfume_archive_v1(ARRAY[{','.join(perfumes)}]::bigint[],{str(archived).lower()})"

    def order_sql(self, key, variant=None, number=None):
        arguments = f"'{key}', repeat('a',64)"
        if variant is not None:
            data = {
                "order": {"order_number": number, "pricing_mode": "website", "subtotal": 100,
                          "delivery_price": 0, "total": 100},
                "items": [{"variant_id": int(variant), "quantity": 1, "unit_price": 100, "line_total": 100}],
                "delivery": {"provider": "ozon", "delivery_type": "pvz"},
            }
            arguments += f", '{json.dumps(data)}'"
        return f"SELECT public.persist_website_order_v1({arguments})"

    def status(self, perfume):
        return self.query(f"""
            SELECT json_build_array(is_archived, archived_at, updated_at)
            FROM public.perfumes WHERE id={perfume}
        """)

    def test_defaults_and_permissions(self):
        self.assertEqual(json.loads(self.status(self.preexisting))[:2], [False, None])
        with self.assertRaisesRegex(RuntimeError, "perfumes_archive_status_consistent"):
            self.query(f"UPDATE public.perfumes SET is_archived=true WHERE id={self.preexisting}")
        for role in ["anon", "authenticated"]:
            with self.assertRaisesRegex(RuntimeError, "permission denied"):
                self.query(f"SET ROLE {role}; " + self.archive_sql(self.preexisting))

    def test_bulk_archive_is_atomic_and_idempotent(self):
        first, _ = self.seed("First")
        second, _ = self.seed("Second")
        before = self.status(first)
        with self.assertRaisesRegex(RuntimeError, "One or more perfumes were not found"):
            self.query(SERVICE + self.archive_sql(first, "9223372036854775807"))
        self.assertEqual(self.status(first), before)
        self.assertEqual(json.loads(self.query(SERVICE + self.archive_sql(second, first))), {"changed": 2})
        archived = self.status(first)
        self.assertEqual(json.loads(archived)[:2], [True, json.loads(archived)[2]])
        self.assertNotEqual(archived, before)
        self.assertEqual(json.loads(self.query(SERVICE + self.archive_sql(first, second))), {"changed": 0})
        self.assertEqual(self.status(first), archived)
        self.assertEqual(json.loads(self.query(SERVICE + self.archive_sql(first, archived=False))), {"changed": 1})
        restored = self.status(first)
        self.assertEqual(json.loads(restored)[:2], [False, None])
        self.assertNotEqual(restored, before)
        self.assertEqual(json.loads(self.query(SERVICE + self.archive_sql(first, archived=False))), {"changed": 0})
        self.assertEqual(self.status(first), restored)

    def test_history_and_relationships_survive_archive_and_stale_cart_rolls_back(self):
        perfume, variant = self.seed("Referenced")
        self.query(f"""
            INSERT INTO public.shop_products (sku,shop_id,perfume_id,volume_ml)
            VALUES ('00025','bbbbbbbb-0000-4000-8000-000000000001',{perfume},3);
            INSERT INTO public.perfume_images (perfume_id,image_url) VALUES ({perfume},'https://example.test/image');
        """)
        key = uuid.uuid4()
        created = json.loads(self.query(SERVICE + self.order_sql(key, variant, "accepted-before-archive")))
        self.query(SERVICE + self.archive_sql(perfume))
        self.assertEqual(json.loads(self.query(SERVICE + self.order_sql(key))),
                         {"outcome": "completed", "response": created["response"]})
        stale_key = uuid.uuid4()
        with self.assertRaisesRegex(RuntimeError, "WEBSITE_PERFUME_ARCHIVED"):
            self.query(SERVICE + self.order_sql(stale_key, variant, "rejected-after-archive"))
        self.assertEqual(self.query(f"""
            SELECT (SELECT count(*) FROM public.website_orders WHERE order_number='rejected-after-archive'),
                   (SELECT count(*) FROM public.website_order_items WHERE variant_id={variant}),
                   (SELECT count(*) FROM public.perfume_variants WHERE id={variant}),
                   (SELECT count(*) FROM public.shop_products WHERE sku='00025' AND perfume_id={perfume}),
                   (SELECT count(*) FROM public.perfume_images WHERE perfume_id={perfume})
        """), "0|1|1|1|1")
        self.query(SERVICE + self.archive_sql(perfume, archived=False))
        self.assertEqual(json.loads(self.query(SERVICE + self.order_sql(stale_key, variant, "accepted-after-restore")))["outcome"], "created")

    def race(self, first, second):
        with subprocess.Popen(self.psql, env={}, text=True, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE) as holder:
            holder.stdin.write(f"BEGIN; {SERVICE}{first}; SELECT 'archive_test_locked';\n")
            holder.stdin.flush()
            self.assertNotEqual(holder.stdout.readline(), "")
            self.assertEqual(holder.stdout.readline().strip(), "archive_test_locked")
            contender_sql = "/* archive_test_contender */ SET statement_timeout='6s'; " + SERVICE + second
            with subprocess.Popen([*self.psql, "-c", contender_sql], env={}, text=True, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE) as contender:
                try:
                    for _ in range(60):
                        if self.query("""SELECT count(*) FROM pg_stat_activity
                            WHERE query LIKE '/* archive_test_contender */%' AND wait_event_type='Lock'
                              AND cardinality(pg_blocking_pids(pid))>0""") == "1":
                            break
                        time.sleep(.025)
                    else:
                        self.fail("The concurrent request never waited on the perfume lock")
                finally:
                    holder.stdin.write("COMMIT;\n")
                    holder.stdin.close()
                stdout, stderr = contender.communicate(timeout=8)
                return contender.returncode, stdout, stderr

    def test_concurrent_archive_wins_and_checkout_is_rejected(self):
        perfume, variant = self.seed("Archive wins")
        status, _, stderr = self.race(self.archive_sql(perfume), self.order_sql(uuid.uuid4(), variant, "archive-wins"))
        self.assertNotEqual(status, 0)
        self.assertIn("WEBSITE_PERFUME_ARCHIVED", stderr)
        self.assertEqual(self.query("SELECT count(*) FROM website_orders WHERE order_number='archive-wins'"), "0")

    def test_concurrent_checkout_wins_and_archive_preserves_the_order(self):
        perfume, variant = self.seed("Checkout wins")
        status, stdout, _ = self.race(self.order_sql(uuid.uuid4(), variant, "checkout-wins"), self.archive_sql(perfume))
        self.assertEqual(status, 0)
        self.assertEqual(json.loads(stdout), {"changed": 1})
        self.assertEqual(self.query("SELECT count(*) FROM website_orders WHERE order_number='checkout-wins'"), "1")
        self.assertTrue(json.loads(self.status(perfume))[0])


if __name__ == "__main__":
    unittest.main()
