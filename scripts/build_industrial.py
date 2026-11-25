"""Build the offline industrial replay from three source contracts and the UCI RDF."""
from collections import defaultdict
from datetime import datetime, timedelta
import json
from pathlib import Path
import re

from pyshacl import validate
from rdflib import Graph, Literal, Namespace, RDF, RDFS, URIRef
from rdflib.namespace import OWL, PROV, XSD

ROOT = Path(__file__).resolve().parents[1]
DEMO = ROOT / "data/industrial-demo"
MODEL = ROOT / "model/industrial"
M = Namespace("https://example.org/hydraulics/industrial#")
UCI = Namespace("https://example.org/hydraulics/uci447#")
SOSA = Namespace("http://www.w3.org/ns/sosa/")
SOURCE = URIRef("https://doi.org/10.24432/C5CW21")


def read_json(name):
    return json.loads((DEMO / name).read_text(encoding="utf-8"))


def index(records):
    result = {}
    for record in records:
        key = record["id"]
        if not re.fullmatch(r"[A-Z0-9][A-Z0-9-]*", key) or key in result:
            raise ValueError(f"无效或重复的 ID：{key}")
        result[key] = record
    return result


def timestamp(value):
    if not isinstance(value, str) or not value.endswith("Z"):
        raise ValueError(f"场景时间须为 UTC ISO 8601：{value}")
    return datetime.fromisoformat(value)


def validate_installations(records, positions, assets):
    """Reject ambiguous master data before resolving any measurement."""
    by_key = defaultdict(list)
    for record in index(records).values():
        start = timestamp(record["from"])
        end = timestamp(record["until"]) if record["until"] is not None else None
        if record["position"] not in positions or record["asset"] not in assets or (end is not None and end <= start):
            raise ValueError(f"无效安装记录：{record['id']}")
        for field in ("position", "asset"):
            by_key[(field, record[field])].append((start, end, record["id"]))
    for intervals in by_key.values():
        intervals.sort(key=lambda item: item[0])
        for earlier, later in zip(intervals, intervals[1:]):
            if earlier[1] is None or earlier[1] > later[0]:
                raise ValueError(f"安装有效期重叠：{earlier[2]} 与 {later[2]}")


def resolve_installation(records, position, at):
    instant = timestamp(at)
    return next((record for record in records if record["position"] == position
                 and timestamp(record["from"]) <= instant
                 and (record["until"] is None or instant < timestamp(record["until"]))), None)


def uci_evidence(uci, cycle_number, channel):
    if type(cycle_number) is not int or cycle_number < 1:
        return None
    cycle = UCI[f"Cycle{cycle_number:04}"]
    summary = UCI[f"Cycle{cycle_number:04}-{channel}"]
    for predicate, obj in ((UCI.hasSummary, summary), (UCI.rowNumber, Literal(cycle_number))):
        if (cycle, predicate, obj) not in uci:
            return None
    pump = UCI[f"Cycle{cycle_number:04}-Pump"]
    if (cycle, UCI.hasAssessment, pump) not in uci or (pump, UCI.forComponent, UCI.Pump) not in uci:
        return None
    values = [uci.value(*fields) for fields in (
        (cycle, UCI.stabilityFlag), (pump, UCI.rawCode), (summary, UCI["mean"]), (UCI[channel], UCI.unit),
        (summary, UCI.sourceMember)
    )]
    if any(value is None for value in values):
        return None
    flag, pump_code, mean, unit, source_file = values
    return {"cycle":cycle_number, "cycleIri":str(cycle), "summaryIri":str(summary),
            "flag":int(flag), "pumpCode":int(pump_code), "mean":str(mean),
            "sourceUnit":str(unit), "file":str(source_file), "row":cycle_number}


MESSAGES = {
    "QUALIFIED": "证据通过校验",
    "NO_SIGNAL": "缺少测点记录或没有可对齐的 UCI 信号",
    "MISSING_INSTALLATION": "这个时刻没有有效的资产安装记录",
    "UNIT_MISMATCH": "上报单位与测点契约或 UCI 源单位不一致",
    "UNSTABLE": "UCI 标签提示工况可能尚未稳定",
}


def import_data(master, historian, maintenance, uci):
    position = master["position"]
    assets = index(master["assets"])
    if any(asset["type"] != "HydraulicPump" for asset in assets.values()):
        raise ValueError("液压站第一版仅接入液压泵资产")
    tags = index(master["tags"])
    cases = index(maintenance["cases"])
    installations = master["installations"]
    if not re.fullmatch(r"[A-Z0-9][A-Z0-9-]*", position["id"]):
        raise ValueError("无效安装位 ID")
    validate_installations(installations, {position["id"]}, assets)
    timestamp(maintenance["asOf"])
    index([maintenance["rule"]])
    for tag in tags.values():
        if tag["position"] != position["id"] or tag["property"] != "Pressure":
            raise ValueError(f"测点没有有效安装位置或物理量：{tag['id']}")

    observations = {}
    for ident, source in index(historian).items():
        tag = tags[source["tag"]]
        installed = resolve_installation(installations, tag["position"], source["at"])
        evidence = uci_evidence(uci, source["cycle"], tag["channel"])
        if not installed:
            quality = "MISSING_INSTALLATION"
        elif evidence is None:
            quality = "NO_SIGNAL"
        elif source["unit"] != tag["unit"] or tag["unit"] != evidence["sourceUnit"]:
            quality = "UNIT_MISMATCH"
        elif evidence["flag"] != 0:
            quality = "UNSTABLE"
        else:
            quality = "QUALIFIED"
        observations[ident] = {
            **source, "tagLabel":tag["label"], "position":tag["position"],
            "installation":installed["id"] if installed else None,
            "asset":installed["asset"] if installed else None,
            "expectedUnit":tag["unit"], "quality":quality, "message":MESSAGES[quality], "uci":evidence,
        }

    histories = {}
    for history in maintenance["history"]:
        case_id = history["case"]
        if case_id not in cases or case_id in histories:
            raise ValueError(f"无效或重复结案记录：{case_id}")
        histories[case_id] = history
    index([history["order"] for history in histories.values()])
    rule = maintenance["rule"]
    output = []
    for case in cases.values():
        installed = resolve_installation(installations, case["position"], case["at"])
        if case["position"] != position["id"]:
            raise ValueError(f"告警没有有效安装位置：{case['id']}")
        observation = observations[case["observation"]] if case["observation"] else None
        if observation and (observation["position"] != case["position"] or observation["at"] != case["at"]):
            raise ValueError(f"告警证据未对齐到同一安装位和时间：{case['id']}")
        retests = [observations[ref] for ref in case["retests"]]
        history = histories.get(case["id"])
        if history:
            retest = observations[history["retest"]]
            order = history["order"]
            chronology = [timestamp(value) for value in (
                case["at"], history["confirmedAt"], order["approvedAt"], order["completedAt"], retest["at"], history["closedAt"]
            )]
            if (not history["reviewer"].strip() or not observation or observation["quality"] != "QUALIFIED"
                    or observation["uci"]["pumpCode"] != rule["labelCode"]
                    or retest not in retests or retest["quality"] != "QUALIFIED"
                    or retest["installation"] != observation["installation"]
                    or retest["uci"]["pumpCode"] != rule["verificationCode"]
                    or any(left >= right for left, right in zip(chronology, chronology[1:]))):
                raise ValueError(f"结案记录缺少合格的确认、审批或同一资产复测：{case['id']}")
        output.append({**case, "observation":observation, "retests":retests, "history":history,
                       "quality":observation["quality"] if observation else "NO_SIGNAL",
                       "message":observation["message"] if observation else MESSAGES["NO_SIGNAL"],
                       "installation":installed["id"] if installed else None,
                       "asset":installed["asset"] if installed else None})
    return {"plant":master["plant"], "position":position, "assets":assets,
            "installations":installations, "tags":tags, "rule":rule, "cases":output,
            "asOf":maintenance["asOf"], "source":str(SOURCE)}


def replay_graph(data):
    g = Graph(bind_namespaces="none")
    for prefix, ns in (("m", M), ("uci", UCI), ("sosa", SOSA), ("prov", PROV), ("owl", OWL),
                       ("rdf", RDF), ("rdfs", RDFS), ("xsd", XSD)):
        g.bind(prefix, ns)

    def add_node(ident, class_name, name=None):
        g.add((M[ident], RDF.type, M[class_name]))
        if name:
            g.add((M[ident], RDFS.label, Literal(name, lang="zh")))
        return M[ident]

    def link(subject, predicate, ident):
        if ident is not None:
            g.add((subject, M[predicate], M[ident]))

    def field(subject, predicate, value, datatype=XSD.string):
        if value is not None:
            g.add((subject, M[predicate], Literal(value, datatype=datatype)))

    plant = data["plant"]
    parent = add_node(plant["id"], "Site", plant["name"])
    for name, key in (("Area","area"), ("WorkCenter","center"), ("WorkUnit","unit")):
        node = add_node(f"{plant['id']}-{name}", name, plant[key])
        g.add((node, M.parent, parent))
        parent = node
    position = add_node(data["position"]["id"], "Position", data["position"]["name"])
    g.add((position, M.parent, parent))
    for ident, asset in data["assets"].items():
        node = add_node(ident, "Asset", asset["name"])
        g.add((node, RDF.type, M[asset["type"]]))
    for record in data["installations"]:
        node = add_node(record["id"], "Installation")
        link(node, "position", record["position"])
        link(node, "asset", record["asset"])
        field(node, "validFrom", record["from"], XSD.dateTime)
        field(node, "validUntil", record["until"], XSD.dateTime)
    for ident, tag in data["tags"].items():
        node = add_node(ident, "Tag", tag["label"])
        g.add((node, RDF.type, SOSA.Sensor))
        g.add((node, SOSA.observes, M[tag["property"]]))
        g.add((M[tag["property"]], RDF.type, SOSA.ObservableProperty))
        link(node, "position", tag["position"])
        field(node, "expectedUnit", tag["unit"])
    add_node("InternalPumpLeakage", "FaultMode", "液压泵内泄漏")
    rule = data["rule"]
    rule_node = add_node(rule["id"], "Rule", rule["name"])
    g.add((rule_node, OWL.versionInfo, Literal(rule["version"])))

    def add_observation(observation):
        node = add_node(observation["id"], "ReplayObservation")
        g.add((node, RDF.type, SOSA.Observation))
        g.add((node, SOSA.madeBySensor, M[observation["tag"]]))
        g.add((node, SOSA.observedProperty, M[data["tags"][observation["tag"]]["property"]]))
        if observation["asset"]:
            g.add((node, SOSA.hasFeatureOfInterest, M[observation["asset"]]))
        link(node, "position", observation["position"])
        link(node, "installation", observation["installation"])
        field(node, "scenarioTime", observation["at"], XSD.dateTime)
        field(node, "reportedUnit", observation["unit"])
        field(node, "expectedUnit", observation["expectedUnit"])
        field(node, "quality", observation["quality"])
        qualified = observation["quality"] == "QUALIFIED"
        g.add((node, RDF.type, M.QualifiedObservation if qualified else M.RejectedObservation))
        if observation["uci"]:
            src = observation["uci"]
            g.add((node, M.originCycle, URIRef(src["cycleIri"])))
            g.add((node, PROV.wasDerivedFrom, URIRef(src["summaryIri"])))
            g.add((node, RDFS.seeAlso, SOURCE))
            field(node, "rowNumber", src["row"], XSD.integer)
            if qualified:
                field(node, "reading", src["mean"], XSD.decimal)
                field(node, "pumpCode", src["pumpCode"], XSD.integer)

    for case in data["cases"]:
        alarm = add_node(case["id"], "Alarm", case["label"])
        link(alarm, "position", case["position"])
        link(alarm, "installation", case["installation"])
        link(alarm, "rule", rule["id"])
        field(alarm, "scenarioTime", case["at"], XSD.dateTime)
        field(alarm, "quality", case["quality"])
        field(alarm, "status", "closed" if case["history"] else "open")
        for observation in filter(None, [case["observation"], *case["retests"]]):
            add_observation(observation)
        if case["observation"]:
            link(alarm, "evidence", case["observation"]["id"])
        history = case["history"]
        if history:
            fault = add_node(f"{case['id']}-FAULT", "ConfirmedFault", "液压泵内泄漏")
            link(fault, "alarm", case["id"])
            link(fault, "faultMode", "InternalPumpLeakage")
            link(fault, "installation", case["installation"])
            link(fault, "rule", rule["id"])
            field(fault, "confirmedAt", history["confirmedAt"], XSD.dateTime)
            field(fault, "reviewer", history["reviewer"])
            order = history["order"]
            order_node = add_node(order["id"], "WorkOrder", order["summary"])
            g.add((order_node, RDF.type, M.ClosedWorkOrder))
            link(order_node, "fault", f"{case['id']}-FAULT")
            link(order_node, "installation", case["installation"])
            field(order_node, "approvedAt", order["approvedAt"], XSD.dateTime)
            field(order_node, "completedAt", order["completedAt"], XSD.dateTime)
            field(order_node, "closedAt", history["closedAt"], XSD.dateTime)
            field(order_node, "status", "closed")
            verification = add_node(f"{order['id']}-VERIFY", "Verification")
            link(order_node, "verification", f"{order['id']}-VERIFY")
            link(verification, "evidence", history["retest"])
            field(verification, "result", "pass")
    return g


def query_closed(g, as_of):
    query = (ROOT / "queries/industrial/closed-pump-faults.rq").read_text(encoding="utf-8")
    end = timestamp(as_of)
    bindings = {"windowStart":Literal(end - timedelta(days=7)), "windowEnd":Literal(end)}
    return [tuple(str(value) for value in result) for result in g.query(query, initBindings=bindings)]


def main(uci=None):
    if uci is None:
        uci = Graph().parse(ROOT / "model/instances.ttl", format="turtle")
    data = import_data(read_json("assets.json"), read_json("historian.json"), read_json("maintenance.json"), uci)
    g = replay_graph(data)
    conforms, _, report = validate(g, shacl_graph=str(MODEL / "shapes.ttl"))
    if not conforms:
        raise ValueError(report)
    rows = query_closed(g, data["asOf"])
    (MODEL / "replay.ttl").write_text(g.serialize(format="turtle").rstrip() + "\n", encoding="utf-8")
    data["closedQuery"] = rows
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("<", r"\u003c")
    (ROOT / "visualization/pilot-data.js").write_text("window.HydraulicPilotData = " + payload + ";\n", encoding="utf-8")
    print(f"工业回放校验通过：{len(g)} 条三元组、{len(data['cases'])} 个案例、{len(rows)} 条七天已结案查询结果")


if __name__ == "__main__":
    main()
