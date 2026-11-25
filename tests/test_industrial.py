import copy
from pathlib import Path
import sys
import unittest

from pyshacl import validate
from rdflib import Graph, RDF

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from build_industrial import M, MODEL, ROOT, import_data, query_closed, read_json, replay_graph


class IndustrialReplayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.uci = Graph().parse(ROOT / "model/instances.ttl", format="turtle")
        cls.master = read_json("assets.json")
        cls.historian = read_json("historian.json")
        cls.maintenance = read_json("maintenance.json")
        cls.data = import_data(cls.master, cls.historian, cls.maintenance, cls.uci)
        cls.cases = {row["id"]: row for row in cls.data["cases"]}

    def test_installation_is_resolved_at_alarm_time(self):
        self.assertEqual(self.cases["AL-BEFORE"]["asset"], "P-100")
        self.assertEqual(self.cases["AL-SWAP"]["asset"], "P-200")
        invalid = copy.deepcopy(self.master)
        invalid["installations"][0]["until"] = "2026-11-20T08:01:00Z"
        with self.assertRaisesRegex(ValueError, "安装有效期重叠"):
            import_data(invalid, self.historian, self.maintenance, self.uci)

    def test_quarantine_and_closed_work_order(self):
        self.assertEqual(self.cases["AL-UNSTABLE"]["quality"], "UNSTABLE")
        self.assertEqual(self.cases["AL-UNIT"]["quality"], "UNIT_MISMATCH")
        self.assertEqual(self.cases["AL-MISSING"]["quality"], "NO_SIGNAL")
        g = replay_graph(self.data)
        self.assertIn((M["OBS-UNIT"], RDF.type, M.RejectedObservation), g)
        self.assertIsNone(g.value(M["OBS-UNIT"], M.reading))
        self.assertTrue(validate(g, shacl_graph=str(MODEL / "shapes.ttl"))[0])
        rows = query_closed(g, self.data["asOf"])
        self.assertEqual(len(rows), 1)
        self.assertEqual([rows[0][i] for i in (0, 2, 4, 5, 6)],
                         [str(M["P-200"]), "611", str(M["WO-DEMO-001"]), "1788", "pass"])
        self.assertEqual(query_closed(g, "2026-11-21T00:00:00Z"), [])

    def test_a_missing_verification_relation_fails_shacl(self):
        g = replay_graph(self.data)
        g.remove((M["WO-DEMO-001"], M.verification, None))
        self.assertFalse(validate(g, shacl_graph=str(MODEL / "shapes.ttl"))[0])
