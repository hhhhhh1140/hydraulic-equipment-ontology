import argparse
from collections import Counter
import hashlib
import io
import json
import math
from pathlib import Path
import shutil
import sys
from urllib.request import urlopen
from zipfile import ZipFile

from pyshacl import validate
from rdflib import BNode, Graph, Literal, Namespace, URIRef
from rdflib.namespace import DCTERMS, OWL, PROV, RDF, RDFS, SH, XSD
import yaml

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ARCHIVE = ROOT / "data/source/hydraulic-uci.zip"
DOWNLOAD_URL = "https://archive.ics.uci.edu/static/public/447/condition+monitoring+of+hydraulic+systems.zip"
ARCHIVE_SHA256 = "24128aad2ee45eea7e6b63ebbd9992cdf25d0483a2cebefbfc13bc69079af1f2"
SOURCE = URIRef("https://doi.org/10.24432/C5CW21")
LICENSE = URIRef("https://creativecommons.org/licenses/by/4.0/")
EX = Namespace("https://example.org/hydraulics/uci447#")
DOMAIN = "工业液压试验台状态监测"
TITLE = "液压设备状态监测本体"
DURATION = 60
CLASSES = {
    "HydraulicRig": ("液压试验台", "包含工作回路、冷却过滤回路和受试部件的实验设备。"),
    "HydraulicCircuit": ("液压回路", "试验台的工作回路或冷却过滤回路。"),
    "OilTank": ("油箱", "连接两个回路的共用油箱。"),
    "Component": ("受试部件", "公开数据中具备周期级状态标签的四种部件。"),
    "Channel": ("采集通道", "数据集定义的测量或计算通道，保留采样率和物理量。"),
    "TestCycle": ("试验周期", "原压缩包中按行对齐的一次 60 秒负载循环。"),
    "ConditionAssessment": ("部件工况标签", "原始 profile.txt 对某一试验周期、某一部件的工况标注。"),
    "SignalSummary": ("周期信号摘要", "从一个周期和一个通道的原始采样值计算的均值、最小值和最大值。"),
}
OBJECTS = {
    "hasCircuit": ("包含回路", "HydraulicRig", "HydraulicCircuit"),
    "sharesTank": ("使用共用油箱", "HydraulicCircuit", "OilTank"),
    "hasComponent": ("包含受试部件", "HydraulicRig", "Component"),
    "hasChannel": ("配置采集通道", "HydraulicRig", "Channel"),
    "onRig": ("在试验台运行", "TestCycle", "HydraulicRig"),
    "hasAssessment": ("具有工况标签", "TestCycle", "ConditionAssessment"),
    "forComponent": ("标注部件", "ConditionAssessment", "Component"),
    "hasSummary": ("具有信号摘要", "TestCycle", "SignalSummary"),
    "fromChannel": ("来自通道", "SignalSummary", "Channel"),
}
FIELDS = {
    "rowNumber": ("原始行号（从1起）", "TestCycle", XSD.integer),
    "durationSeconds": ("周期时长（秒）", "TestCycle", XSD.integer),
    "stabilityFlag": ("稳定性标记", "TestCycle", XSD.integer),
    "quantity": ("物理量", "Channel", XSD.string),
    "unit": ("单位", "Channel", XSD.string),
    "sampleRateHz": ("采样率（Hz）", "Channel", XSD.integer),
    "virtual": ("虚拟通道", "Channel", XSD.boolean),
    "rawCode": ("原始工况值", "ConditionAssessment", XSD.integer),
    "conditionMeaning": ("工况释义", "ConditionAssessment", XSD.string),
    "sampleCount": ("样点数", "SignalSummary", XSD.integer),
    "mean": ("周期均值", "SignalSummary", XSD.decimal),
    "minimum": ("周期最小值", "SignalSummary", XSD.decimal),
    "maximum": ("周期最大值", "SignalSummary", XSD.decimal),
    "sourceMember": ("原压缩包文件", "SignalSummary", XSD.string),
}
COMPONENTS = [
    ("Cooler", "冷却器", "%", {3: "接近失效", 20: "效率下降", 100: "满效率"}),
    ("Valve", "换向阀", "%", {100: "最佳切换", 90: "轻度滞后", 80: "严重滞后", 73: "接近失效"}),
    ("Pump", "液压泵", "等级", {0: "无内泄漏", 1: "轻度内泄漏", 2: "严重内泄漏"}),
    ("Accumulator", "蓄能器", "bar", {130: "最佳压力", 115: "轻度降低", 100: "明显降低", 90: "接近失效"}),
]
CHANNELS = {
    **{f"PS{i}": ("压力", "bar", 100, False) for i in range(1, 7)},
    "EPS1": ("电机功率", "W", 100, False),
    **{f"FS{i}": ("体积流量", "L/min", 10, False) for i in range(1, 3)},
    **{f"TS{i}": ("温度", "°C", 1, False) for i in range(1, 5)},
    "VS1": ("振动速度", "mm/s", 1, False),
    "CE": ("冷却效率", "%", 1, True),
    "CP": ("冷却功率", "kW", 1, True),
    "SE": ("效率因子", "%", 1, None),
}
SELECTED_CHANNELS = ("PS1", "FS1", "TS1", "VS1")


def source_archive(archive_path):
    outer = ZipFile(archive_path)
    if any(Path(name).name == "profile.txt" for name in outer.namelist()):
        return outer
    nested = [name for name in outer.namelist() if name.endswith(".zip")]
    if len(nested) != 1:
        raise ValueError(f"找不到原始数据文件: {outer.namelist()}")
    with outer:
        return ZipFile(io.BytesIO(outer.read(nested[0])))


def signal_summaries(archive, names):
    result = {}
    for channel in SELECTED_CHANNELS:
        count = CHANNELS[channel][2] * DURATION
        with archive.open(names[f"{channel}.txt"]) as source:
            summaries = []
            for line in source:
                samples = [float(value) for value in line.split()]
                assert len(samples) == count and all(map(math.isfinite, samples)), channel
                summaries.append((count, f"{math.fsum(samples) / count:.4f}", f"{min(samples):.4f}", f"{max(samples):.4f}"))
        result[channel] = summaries
    return result


def graph():
    result = Graph()
    for prefix, ns in (("hyd", EX), ("prov", PROV), ("dct", DCTERMS), ("owl", OWL), ("sh", SH)):
        result.bind(prefix, ns)
    return result


def named(g, ident, class_name, label, source=True):
    uri = EX[ident]
    g.add((uri, RDF.type, EX[class_name]))
    g.add((uri, RDFS.label, Literal(label, lang="zh")))
    if source:
        g.add((uri, PROV.wasDerivedFrom, SOURCE))
    return uri


def build_graph(profiles, summaries):
    schema, facts = graph(), graph()
    ontology = URIRef(str(EX).rstrip("#"))
    schema.add((ontology, RDF.type, OWL.Ontology))
    schema.add((ontology, RDFS.label, Literal(TITLE, lang="zh")))
    schema.add((ontology, OWL.versionInfo, Literal("1.0")))
    schema.add((ontology, DCTERMS.source, SOURCE))
    schema.add((SOURCE, DCTERMS.license, LICENSE))
    schema.add((SOURCE, DCTERMS.title, Literal("Condition monitoring of hydraulic systems")))
    schema.add((SOURCE, DCTERMS.creator, Literal("Nikolai Helwig, Eliseo Pignanelli, Andreas Schütze")))
    for key, (label, description) in CLASSES.items():
        schema.add((EX[key], RDF.type, OWL.Class))
        schema.add((EX[key], RDFS.label, Literal(label, lang="zh")))
        schema.add((EX[key], RDFS.comment, Literal(description, lang="zh")))
    for key, (label, domain, range_) in {**OBJECTS, **FIELDS}.items():
        predicate = EX[key]
        schema.add((predicate, RDF.type, OWL.ObjectProperty if key in OBJECTS else OWL.DatatypeProperty))
        schema.add((predicate, RDFS.label, Literal(label, lang="zh")))
        schema.add((predicate, RDFS.domain, EX[domain]))
        schema.add((predicate, RDFS.range, EX[range_] if key in OBJECTS else range_))

    rig = named(facts, "Rig447", "HydraulicRig", "UCI 447 液压试验台")
    tank = named(facts, "SharedOilTank", "OilTank", "共用油箱")
    for ident, label in (("WorkingCircuit", "工作回路"), ("CoolingCircuit", "冷却过滤回路")):
        circuit = named(facts, ident, "HydraulicCircuit", label)
        facts.add((rig, EX.hasCircuit, circuit))
        facts.add((circuit, EX.sharesTank, tank))
    for key, label, _, _ in COMPONENTS:
        facts.add((rig, EX.hasComponent, named(facts, key, "Component", label)))
    for name, (quantity, unit, rate, virtual) in CHANNELS.items():
        channel = named(facts, name, "Channel", f"{name} · {quantity}")
        facts.add((rig, EX.hasChannel, channel))
        for prop, value in (("quantity", quantity), ("unit", unit), ("sampleRateHz", rate), ("virtual", virtual)):
            if value is not None:
                facts.add((channel, EX[prop], Literal(value, datatype=FIELDS[prop][2])))

    for row, profile in enumerate(profiles, start=1):
        cycle_id = f"Cycle{row:04}"
        cycle = named(facts, cycle_id, "TestCycle", f"周期 {row}")
        facts.add((cycle, EX.onRig, rig))
        facts.add((cycle, EX.rowNumber, Literal(row)))
        facts.add((cycle, EX.durationSeconds, Literal(DURATION)))
        facts.add((cycle, EX.stabilityFlag, Literal(profile[-1])))
        for (component, label, _, meanings), code in zip(COMPONENTS, profile[:-1], strict=True):
            assessment = named(facts, f"{cycle_id}-{component}", "ConditionAssessment", f"周期 {row} · {label}")
            facts.add((cycle, EX.hasAssessment, assessment))
            facts.add((assessment, EX.forComponent, EX[component]))
            facts.add((assessment, EX.rawCode, Literal(code)))
            facts.add((assessment, EX.conditionMeaning, Literal(meanings[code], datatype=XSD.string)))
        for channel, rows in summaries.items():
            summary = named(facts, f"{cycle_id}-{channel}", "SignalSummary", f"周期 {row} · {channel}")
            facts.add((cycle, EX.hasSummary, summary))
            facts.add((summary, EX.fromChannel, EX[channel]))
            count, average, minimum, maximum = rows[row - 1]
            facts.add((summary, EX.sampleCount, Literal(count)))
            for prop, value in (("mean", average), ("minimum", minimum), ("maximum", maximum)):
                facts.add((summary, EX[prop], Literal(value, datatype=XSD.decimal)))
            facts.add((summary, EX.sourceMember, Literal(f"{channel}.txt", datatype=XSD.string)))
    return schema, facts


def build_shapes():
    shapes = graph()
    properties = {
        "TestCycle": {"rowNumber": (1, 1), "durationSeconds": (1, 1), "stabilityFlag": (1, 1), "onRig": (1, 1), "hasAssessment": (4, 4), "hasSummary": (4, 4)},
        "ConditionAssessment": {"forComponent": (1, 1), "rawCode": (1, 1), "conditionMeaning": (1, 1)},
        "SignalSummary": {"fromChannel": (1, 1), "sampleCount": (1, 1), "mean": (1, 1), "minimum": (1, 1), "maximum": (1, 1), "sourceMember": (1, 1)},
        "Channel": {"sampleRateHz": (1, 1), "unit": (1, 1), "quantity": (1, 1), "virtual": (0, 1)},
    }
    for class_name, checks in properties.items():
        shape = EX[f"{class_name}Shape"]
        shapes.add((shape, RDF.type, SH.NodeShape))
        shapes.add((shape, SH.targetClass, EX[class_name]))
        for name, (minimum, maximum) in checks.items():
            prop = BNode()
            shapes.add((shape, SH.property, prop))
            shapes.add((prop, SH.path, EX[name]))
            shapes.add((prop, SH.minCount, Literal(minimum)))
            shapes.add((prop, SH.maxCount, Literal(maximum)))
            if name in FIELDS:
                shapes.add((prop, SH.datatype, FIELDS[name][2]))
            else:
                shapes.add((prop, SH["class"], EX[OBJECTS[name][2]]))
    return shapes


QUERIES = {
    "01-severe-pump": """# 严重泵内泄漏出现在哪些周期？同时返回试验台稳定性标记。
PREFIX hyd: <https://example.org/hydraulics/uci447#>
SELECT ?row ?flag WHERE {
  ?tag hyd:forComponent hyd:Pump ; hyd:rawCode ?code .
  ?cycle hyd:hasAssessment ?tag ; hyd:rowNumber ?row ; hyd:stabilityFlag ?flag .
  FILTER(?code = 2)
} ORDER BY ?row
""",
    "02-pump-and-accumulator": """# 同一周期中出现严重泵内泄漏与蓄能器 90 bar 的周期。
PREFIX hyd: <https://example.org/hydraulics/uci447#>
SELECT ?row ?flag ?meanPS1 WHERE {
  ?pump hyd:forComponent hyd:Pump ; hyd:rawCode ?code .
  ?cycle hyd:hasAssessment ?pump, ?acc ; hyd:rowNumber ?row ;
         hyd:stabilityFlag ?flag ; hyd:hasSummary ?summary .
  ?acc hyd:forComponent ?component ; hyd:rawCode ?pressure .
  ?summary hyd:fromChannel ?channel ; hyd:mean ?meanPS1 .
  FILTER(?code = 2 && ?component = hyd:Accumulator && ?pressure = 90 && ?channel = hyd:PS1)
} ORDER BY ?row
""",
    "03-cycle-evidence": """# 周期 1 的监测结果如何回到文件？可把行号 1 换为 1–2205。
PREFIX hyd: <https://example.org/hydraulics/uci447#>
PREFIX prov: <http://www.w3.org/ns/prov#>
SELECT ?file (1 AS ?row) ?count ?average ?source WHERE {
  ?cycle hyd:rowNumber 1 ; hyd:hasSummary ?summary .
  ?summary hyd:sourceMember ?file ; hyd:sampleCount ?count ; hyd:mean ?average ;
           prov:wasDerivedFrom ?source .
} ORDER BY ?file
""",
}


def onto_model_yaml():
    type_map = {XSD.integer: "Integer", XSD.string: "String", XSD.boolean: "Boolean", XSD.decimal: "Decimal"}
    entities = [
        {"id": key, "alias": key, "name": label, "description": description, "lifecycle": [],
         "attributes": [{"name": p, "label": text, "type": type_map[datatype], "required": p != "virtual"}
                        for p, (text, parent, datatype) in FIELDS.items() if parent == key]}
        for key, (label, description) in CLASSES.items()
    ]
    relations = [{"id": key, "type": "ASSOCIATION", "sourceEntity": source,
                  "targetEntity": target, "targetRole": label}
                 for key, (label, source, target) in OBJECTS.items()]
    return yaml.safe_dump({"model_type": "OBJECT", "version": "1.0", "domain": DOMAIN,
                           "entities": entities, "relations": relations},
                          allow_unicode=True, sort_keys=False)


def checksum(path):
    with path.open("rb") as source_file:
        return hashlib.file_digest(source_file, "sha256").hexdigest()


def download_archive(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_suffix(".zip.part")
    try:
        with urlopen(DOWNLOAD_URL, timeout=60) as response, partial.open("wb") as target:
            shutil.copyfileobj(response, target)
        if checksum(partial) != ARCHIVE_SHA256:
            raise ValueError("下载包的 SHA-256 与项目记录不一致")
        partial.replace(path)
    finally:
        partial.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description="从 UCI 447 数据重建液压设备本体和离线展示。")
    parser.add_argument("--archive", type=Path, default=DEFAULT_ARCHIVE, help="UCI 原始 ZIP 路径")
    parser.add_argument("--download", action="store_true", help="仅在原始 ZIP 缺失时下载")
    parser.add_argument("--onto-model", type=Path, help="可选的 Onto-Model 源码目录，用于运行其工作区校验")
    args = parser.parse_args()
    if not args.archive.is_file():
        if not args.download:
            parser.error("找不到原始 UCI ZIP。请加 --download，或用 --archive 指定已有文件。")
        download_archive(args.archive)
    archive_hash = checksum(args.archive)
    if archive_hash != ARCHIVE_SHA256:
        parser.error("原始数据的 SHA-256 与项目记录不一致，请确认采用 UCI 447 下载包。")

    model_dir = ROOT / "model"
    model_dir.mkdir(exist_ok=True)
    with source_archive(args.archive) as archive:
        names = {Path(name).name: name for name in archive.namelist()}
        profiles = [tuple(map(int, line.split())) for line in archive.read(names["profile.txt"]).splitlines() if line.strip()]
        summaries = signal_summaries(archive, names)
    assert len(profiles) == 2205
    assert all(len(row) == 5 and row[-1] in (0, 1) for row in profiles)
    assert all(set(row[i] for row in profiles) <= set(component[3]) for i, component in enumerate(COMPONENTS))
    assert all(len(rows) == len(profiles) for rows in summaries.values())

    schema, facts = build_graph(profiles, summaries)
    shapes = build_shapes()
    for filename, rdf_graph in (("ontology.ttl", schema), ("instances.ttl", facts), ("shapes.ttl", shapes)):
        turtle = rdf_graph.serialize(format="turtle")
        (model_dir / filename).write_text(turtle.rstrip() + "\n", encoding="utf-8")
    checked = Graph().parse(model_dir / "instances.ttl", format="turtle")
    assert len(checked) == len(facts)
    conforms, _, report = validate(checked, shacl_graph=Graph().parse(model_dir / "shapes.ttl", format="turtle"))
    if not conforms:
        raise ValueError(report)
    print(f"SHACL passed for {len(checked)} triples", flush=True)
    expected_severe = [i for i, row in enumerate(profiles, 1) if row[2] == 2]
    expected_both = [i for i, row in enumerate(profiles, 1) if row[2:4] == (2, 90)]
    queries = ROOT / "queries"
    queries.mkdir(exist_ok=True)
    for name, source in QUERIES.items():
        (queries / f"{name}.rq").write_text(source, encoding="utf-8")
    for query, expected in (("01-severe-pump", expected_severe), ("02-pump-and-accumulator", expected_both)):
        assert [int(row.row) for row in checked.query(QUERIES[query])] == expected
        print(f"{query}: {len(expected)} matching cycles", flush=True)
    assert [(str(row.file), int(row["count"])) for row in checked.query(QUERIES["03-cycle-evidence"])] == [
        (f"{channel}.txt", CHANNELS[channel][2] * DURATION) for channel in sorted(SELECTED_CHANNELS)
    ]

    workspace = ROOT / "onto-model"
    workspace.mkdir(exist_ok=True)
    (workspace / "m1-object-model.yaml").write_text(onto_model_yaml(), encoding="utf-8")
    object_model = yaml.safe_load((workspace / "m1-object-model.yaml").read_text(encoding="utf-8"))
    entity_ids = {entity["id"] for entity in object_model["entities"]}
    assert entity_ids == set(CLASSES)
    assert len(object_model["relations"]) == len(OBJECTS)
    assert all(rel["sourceEntity"] in entity_ids and rel["targetEntity"] in entity_ids for rel in object_model["relations"])
    onto_outcome = "YAML 结构及端点检查通过。"
    if args.onto_model:
        backend = args.onto_model.resolve() / "backend"
        if not (backend / "services/workspace_service.py").is_file():
            parser.error("--onto-model 应指向 Onto-Model 源码根目录。")
        sys.path.insert(0, str(backend))
        from services.workspace_service import WorkspaceService
        opened = WorkspaceService().open_workspace(str(workspace))
        assert opened["validation"] == {"errors": [], "warnings": []}, opened["validation"]
        onto_outcome = "已使用 Onto-Model 读取工作区，0 错误、0 警告。"

    result = {
        "classes": CLASSES, "relations": OBJECTS, "components": COMPONENTS,
        "channels": {name: CHANNELS[name] for name in SELECTED_CHANNELS},
        "profiles": profiles,
        "means": [[float(summaries[ch][i][1]) for ch in SELECTED_CHANNELS] for i in range(len(profiles))],
        "sha256": archive_hash,
        "counts": {"cycles": len(profiles), "assessment": len(profiles) * 4,
                   "summary": len(profiles) * 4, "signals": len(CHANNELS),
                   "facts": len(facts), "schema": len(schema),
                   "severe": len(expected_severe), "both": len(expected_both),
                   "stability": Counter(row[-1] for row in profiles)},
        "example": {"row": expected_both[0], "profile": profiles[expected_both[0] - 1]},
    }
    visual = ROOT / "visualization"
    template = (visual / "template.html").read_text(encoding="utf-8")
    payload = json.dumps(result, ensure_ascii=False, separators=(",", ":")).replace("<", r"\u003c")
    (visual / "index.html").write_text(template.replace("__DATA__", payload), encoding="utf-8")
    counts = result["counts"]
    report = "\n".join([
        "液压设备状态监测本体 · 校验结果",
        onto_outcome,
        "Turtle 回读、SHACL 校验、三条 SPARQL 查询通过。",
        f"类 {len(CLASSES)}，对象关系类型 {len(OBJECTS)}，实例三元组 {counts['facts']}。",
        f"周期 {counts['cycles']}，部件工况标签 {counts['assessment']}，信号摘要 {counts['summary']}。",
        f"严重泵内泄漏 {counts['severe']} 个周期，其中蓄能器为 90 bar 的有 {counts['both']} 个。",
        f"原始 UCI ZIP SHA-256 {archive_hash}",
        "",
    ])
    (model_dir / "validation.txt").write_text(report, encoding="utf-8")
    print(report)


if __name__ == "__main__":
    main()
