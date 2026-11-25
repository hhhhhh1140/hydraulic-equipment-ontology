from copy import deepcopy
from decimal import Decimal
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest

from rdflib import Graph, RDF
from rdflib.namespace import PROV

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from build_industrial import M
from import_plant import SOURCES, review, run, utc

SAMPLES = Path(__file__).resolve().parents[1] / "data/plant-intake-example"


class PlantIntakeTests(unittest.TestCase):
    def fixture(self):
        return [json.loads((SAMPLES / file).read_bytes(), parse_float=Decimal) for file in SOURCES]

    def test_timezone_conversion_keeps_installation_boundary_and_units(self):
        snapshot, report = review(*self.fixture())
        alarms = {row["id"]: row for row in snapshot["cases"]}
        self.assertEqual(alarms["AL-OLD"]["asset"], "PUMP-A")
        self.assertEqual(alarms["AL-NEW"]["asset"], "PUMP-B")
        self.assertEqual(snapshot["observations"]["M-OLD"]["value"], "173")
        self.assertEqual(snapshot["observations"]["M-NEW"]["value"], "184")
        self.assertEqual(alarms["AL-CROSS"]["references"][0]["eligible"], False)
        self.assertEqual(report["summary"]["blockedAlarms"], 3)
        self.assertEqual(report["summary"]["verifiedClosed"], 1)
        self.assertEqual(report["summary"]["quarantinedOrders"], 2)
        results = {row["id"]:row["result"] for row in alarms["AL-NEW"]["orders"]}
        self.assertEqual(results, {"WO-OK":"结案已核验", "WO-NO-RETEST":"结案待核验"})
        self.assertEqual(utc("2026-11-20T16:00:00+08:00"), "2026-11-20T08:00:00.000000Z")
        with self.assertRaises(ValueError):
            utc("2026-11-20T16:00:00")

    def test_pump_swap_overlap_and_pressure_semantics(self):
        master, historian, maintenance = self.fixture()
        invalid = deepcopy(master)
        invalid["installations"][0]["until"] = "2026-11-20T16:01:00+08:00"
        with self.assertRaisesRegex(ValueError, "安装有效期重叠"):
            review(invalid, historian, maintenance)
        next(row for row in historian["measurements"] if row["id"] == "M-NEW")["quantity"] = "absolutePressure"
        snapshot, report = review(master, historian, maintenance)
        self.assertEqual(snapshot["observations"]["M-NEW"]["quality"], "INCOMPATIBLE_MEASUREMENT")
        self.assertEqual(report["summary"]["verifiedClosed"], 0)

    def test_batch_roundtrip_and_rdf_excludes_unverified_records(self):
        with TemporaryDirectory() as folder:
            output = Path(folder)
            target, report = run(SAMPLES, output)
            repeated, second = run(SAMPLES, output)
            self.assertEqual(repeated, target)
            self.assertEqual(report, second)
            self.assertEqual(len(report["sourceSha256"]), 3)
            self.assertEqual(report["issueCounts"]["MEASUREMENT_CONTEXT"], 1)
            graph = Graph().parse(target / "field-facts.ttl", format="turtle")
            orders = list(graph.subjects(RDF.type, M.VerifiedFieldOrder))
            self.assertEqual(len(orders), 1)
            route = Path(SAMPLES.parents[1]) / "queries/industrial/verified-field-orders.rq"
            result = list(graph.query(route.read_text(encoding="utf-8")))
            self.assertEqual([(str(row.assetName), str(row.orderId), int(row.row)) for row in result],
                             [("样例新泵", "WO-OK", 5)])
            self.assertTrue(str(orders[0]).endswith("WO-OK"))
            observations = list(graph.subjects(RDF.type, M.FieldObservation))
            self.assertEqual(len(observations), 3)
            self.assertTrue(all(graph.value(obs, PROV.wasDerivedFrom) for obs in observations))
