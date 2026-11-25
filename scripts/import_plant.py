"""Validate an authorized three-file pressure and maintenance export for read-only review."""
import argparse
from collections import Counter
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from hashlib import sha256
import json
import os
from pathlib import Path
import tempfile

from pyshacl import validate

from build_industrial import MODEL, index, resolve_installation, validate_installations
from field_graph import field_graph

FORMAT_VERSION = "1.0.2"
SOURCES = ("assets.json", "historian.json", "maintenance.json")
TO_BAR = {"Pa":Decimal("0.00001"), "kPa":Decimal("0.01"),
          "MPa":Decimal("10"), "bar":Decimal("1")}
QUANTITIES = {"gaugePressure", "absolutePressure"}
ORDER_LABELS = {"planned":"计划中", "inProgress":"进行中", "closed":"结案已核验"}


def utc(value):
    """Preserve measurement order across offsets and the installation boundary."""
    if not isinstance(value, str) or "T" not in value:
        raise ValueError("需要带时区的 ISO 8601 时间")
    try:
        local = datetime.fromisoformat(value)
        if local.utcoffset() is None:
            raise ValueError("缺少时区")
        return local.astimezone(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")
    except (ValueError, OverflowError) as error:
        raise ValueError(f"无效时间：{value}") from error


def named_rows(records):
    # Keep the 1-based array position so a reviewer can find the original record.
    return list(enumerate(index(records).values(), 1))


def measure_value(value, unit, canonical):
    if type(value) not in (int, Decimal):
        raise ValueError("读数必须是 JSON 数字")
    try:
        number = Decimal(value)
        if not number.is_finite():
            raise ValueError("读数必须为有限值")
        converted = number * TO_BAR[unit] / TO_BAR[canonical]
        if not converted.is_finite() or abs(converted.adjusted()) > 308:
            raise ValueError("读数超出可交换的数值范围")
        return format(converted.normalize(), "f")
    except (InvalidOperation, ArithmeticError) as error:
        raise ValueError("无法转换读数") from error


def review(master, historian, maintenance):
    for source in (master, historian, maintenance):
        if not isinstance(source, dict) or type(source.get("schemaVersion")) is not int or source["schemaVersion"] != 1:
            raise ValueError("三个输入文件都须声明 schemaVersion 为 1")

    as_of = utc(maintenance["asOf"])
    plant = {key:master["plant"][key] for key in ("id", "name", "area", "center", "unit")}
    position = {key:master["position"][key] for key in ("id", "name")}
    index([plant, position])
    if not all(isinstance(value, str) and value.strip() for value in [*plant.values(), *position.values()]):
        raise ValueError("工厂层级及安装位必须是非空字符串")
    positions = {position["id"]}
    assets = index({"id":row["id"], "name":row["name"]} for row in master["assets"])
    installations = [{"id":record["id"], "position":record["position"], "asset":record["asset"],
                      "from":utc(record["from"]),
                      "until":utc(record["until"]) if record["until"] is not None else None}
                     for record in master["installations"]]
    validate_installations(installations, positions, assets)
    tags = index({key:row[key] for key in ("id", "position", "label", "quantity", "unit")}
                 for row in master["tags"])
    for tag in tags.values():
        if tag["position"] not in positions or tag["quantity"] not in QUANTITIES or tag["unit"] not in TO_BAR:
            raise ValueError(f"测点契约无效：{tag['id']}")

    issues = []
    observations = {}

    def report(file, row, ident, code, message, collection=None):
        collection = collection or ("measurements" if file == "historian.json" else "alarms")
        issues.append({"sourceFile":file, "sourceCollection":collection, "sourceRow":row, "recordId":ident,
                       "code":code, "message":message})

    for row, entry in named_rows(historian["measurements"]):
        ident = entry["id"]
        tag = tags.get(entry.get("tag"))
        try:
            at = utc(entry.get("at"))
        except ValueError:
            at = None
        installed = resolve_installation(installations, tag["position"], at) if at and tag else None
        code = message = None
        normalized = None
        if tag is None:
            code, message = "TAG_UNKNOWN", "测点不在台账中"
        elif at is None or at > as_of:
            code, message = "INVALID_MEASURE_TIME", "测点时间无效或晚于快照截止时刻"
        elif not installed:
            code, message = "NO_ACTIVE_INSTALLATION", "采集时没有有效安装记录"
        elif entry.get("quantity") != tag["quantity"] or entry.get("unit") not in TO_BAR:
            code, message = "INCOMPATIBLE_MEASUREMENT", "物理量或单位与测点契约不兼容"
        elif entry.get("quality") != "good":
            code, message = "BAD_HISTORIAN_QUALITY", "采集系统未标为 good"
        else:
            try:
                normalized = measure_value(entry.get("value"), entry["unit"], tag["unit"])
            except ValueError:
                code, message = "INVALID_MEASURE_VALUE", "无法读取或换算数值"
        if code:
            report("historian.json", row, ident, code, message)
        observations[ident] = {
            "id":ident, "tag":entry.get("tag"), "at":at, "sourceRow":row,
            "position":tag["position"] if tag else None,
            "installation":installed["id"] if installed else None, "asset":installed["asset"] if installed else None,
            "quantity":entry.get("quantity"), "reportedUnit":entry.get("unit"),
            "reportedValue":str(entry.get("value")) if entry.get("value") is not None else None,
            "value":normalized, "unit":tag["unit"] if tag else None,
            "quality":"QUALIFIED" if not code else code, "message":message or "证据通过校验"
        }

    alarms = {}
    for row, entry in named_rows(maintenance["alarms"]):
        ident = entry["id"]
        try:
            at = utc(entry.get("at"))
        except ValueError:
            at = None
        installed = resolve_installation(installations, entry.get("position"), at) if at and at <= as_of else None
        measurement_ids = entry.get("measurementIds", [])
        if not isinstance(measurement_ids, list) or not all(isinstance(ref, str) for ref in measurement_ids):
            raise ValueError(f"告警测点引用须是 ID 数组：{ident}")
        references = []
        if not installed:
            report("maintenance.json", row, ident, "ALARM_INSTALLATION", "告警缺少有效时间或安装关联")
        for ref in dict.fromkeys(measurement_ids):
            obs = observations.get(ref)
            if not obs:
                report("maintenance.json", row, ident, "MEASUREMENT_MISSING", f"缺少测点记录 {ref}")
                references.append({"id":ref, "message":"记录缺失", "eligible":False})
                continue
            eligible = False
            message = obs["message"]
            if obs["quality"] == "QUALIFIED":
                if installed and obs["installation"] == installed["id"] and obs["at"] <= at:
                    eligible = True
                else:
                    report("maintenance.json", row, ident, "MEASUREMENT_CONTEXT", f"{ref} 不属于告警发生时的安装记录或时间")
                    message = "安装归属或时间不符合告警"
            references.append({**obs, "eligible":eligible, "message":message})
        eligible = [obs for obs in references if obs["eligible"]]
        if not eligible:
            report("maintenance.json", row, ident, "ALARM_WITHOUT_EVIDENCE", "告警没有合格证据")
        alarms[ident] = {
            "id":ident, "label":entry.get("label") or ident, "position":entry.get("position"), "at":at,
            "sourceRow":row, "asset":installed["asset"] if installed else None,
            "installation":installed["id"] if installed else None, "quality":"QUALIFIED" if eligible else "BLOCKED",
            "message":f"{len(eligible)} 条证据通过校验" if eligible else "告警缺少合格证据",
            "references":references, "orders":[], "readAudit":[]
        }

    order_counts = Counter()
    for row, entry in named_rows(maintenance["workOrders"]):
        ident = entry["id"]
        alarm = alarms.get(entry.get("alarm"))
        status = entry.get("status")
        if not alarm or not alarm["asset"] or alarm["asset"] != entry.get("asset") or status not in ORDER_LABELS:
            code = "ORDER_CONTEXT"
            report("maintenance.json", row, ident, code, "工单状态无效或资产与告警发生时的安装归属不一致", "workOrders")
            order_counts["quarantined"] += 1
            if alarm:
                alarm["orders"].append({"id":ident, "status":status, "result":"待核验", "problem":code})
            continue
        if status != "closed":
            alarm["orders"].append({"id":ident, "status":status, "result":ORDER_LABELS[status]})
            order_counts["open"] += 1
            continue
        retest = observations.get(entry.get("retestId"))
        try:
            confirmed, approved, completed, closed = [utc(entry.get(name)) for name in
                ("confirmedAt", "approvedAt", "completedAt", "closedAt")]
            identified = all(isinstance(entry.get(key), str) and entry[key].strip()
                             for key in ("confirmedBy", "retestBy", "faultCode"))
            passes = (alarm["quality"] == "QUALIFIED" and identified
                      and retest is not None and retest["quality"] == "QUALIFIED"
                      and retest["installation"] == alarm["installation"]
                      and entry.get("retestResult") == "pass"
                      and alarm["at"] <= confirmed <= approved <= completed < retest["at"] <= closed <= as_of)
        except ValueError:
            passes = False
        if not passes:
            order_counts["quarantined"] += 1
            report("maintenance.json", row, ident, "ORDER_RETEST_INVALID", "结案缺少同一资产完工后的合格复测或时间顺序错误", "workOrders")
            alarm["orders"].append({"id":ident, "status":status, "result":"结案待核验", "problem":"ORDER_RETEST_INVALID"})
            continue
        order_counts["verifiedClosed"] += 1
        alarm["orders"].append({"id":ident, "status":status, "result":ORDER_LABELS[status],
                                "faultCode":entry["faultCode"], "confirmedAt":confirmed,
                                "confirmedBy":entry["confirmedBy"], "approvedAt":approved, "completedAt":completed,
                                "retest":retest, "retestBy":entry["retestBy"], "closedAt":closed, "sourceRow":row})
        alarm["readAudit"].extend([
            {"source":"import", "label":f"{ident} · 人工确认 {entry['faultCode']}",
             "actor":entry["confirmedBy"], "scenarioAt":confirmed},
            {"source":"import", "label":f"{ident} · 复测通过 · {retest['id']}",
             "actor":entry["retestBy"], "scenarioAt":retest["at"]},
            {"source":"import", "label":f"{ident} · 来源系统结案", "actor":"来源记录", "scenarioAt":closed}
        ])

    accepted = sum(obs["quality"] == "QUALIFIED" for obs in observations.values())
    ready = sum(alarm["quality"] == "QUALIFIED" for alarm in alarms.values())
    summary = {"measurements":len(observations), "acceptedMeasurements":accepted,
               "quarantinedMeasurements":len(observations)-accepted, "alarms":len(alarms),
               "qualifiedAlarms":ready, "blockedAlarms":len(alarms)-ready,
               "verifiedClosed":order_counts["verifiedClosed"], "openOrders":order_counts["open"],
               "quarantinedOrders":order_counts["quarantined"]}
    for alarm in alarms.values():
        alarm["readAudit"].sort(key=lambda event: event["scenarioAt"])
    snapshot = {"mode":"read-only", "schemaVersion":1, "isSample":master.get("isSample") is True, "plant":plant, "position":position, "assets":assets,
                "installations":installations, "tags":tags, "observations":observations,
                "cases":list(alarms.values()), "asOf":as_of, "summary":summary}
    return snapshot, {"summary":summary, "issues":issues,
                      "issueCounts":dict(sorted(Counter(issue["code"] for issue in issues).items()))}


def run(source_dir, output_dir):
    data, hashes = {}, {}
    for name in SOURCES:
        payload = (source_dir / name).read_bytes()
        hashes[name] = sha256(payload).hexdigest()
        data[name] = json.loads(payload, parse_float=Decimal, parse_constant=Decimal)
    snapshot, report = review(*(data[name] for name in SOURCES))
    batch_id = sha256(json.dumps([FORMAT_VERSION, hashes], sort_keys=True).encode()).hexdigest()[:16]
    metadata = {"batchId":batch_id, "formatVersion":FORMAT_VERSION, "sourceSha256":hashes}
    snapshot.update(metadata)
    report.update(metadata)
    graph = field_graph(snapshot)
    conforms, _, violations = validate(graph, shacl_graph=str(MODEL / "field-shapes.ttl"))
    if not conforms:
        raise ValueError(violations)
    output_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = output_dir / batch_id
    with tempfile.TemporaryDirectory(dir=output_dir) as temp:
        staging = Path(temp) / "batch"
        staging.mkdir(mode=0o700)
        for name, item in (("snapshot.json",snapshot), ("quality-report.json",report)):
            path = staging / name
            path.write_text(json.dumps(item, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            path.chmod(0o600)
        facts = staging / "field-facts.ttl"
        facts.write_text(graph.serialize(format="turtle").rstrip() + "\n", encoding="utf-8")
        facts.chmod(0o600)
        try:
            staging.rename(target)
        except OSError:
            if not target.is_dir() or sorted(path.name for path in target.iterdir()) != ["field-facts.ttl", "quality-report.json", "snapshot.json"]:
                raise
            for item in staging.iterdir():
                if item.read_bytes() != (target / item.name).read_bytes():
                    raise ValueError("同一批次已有不同产物，请检查文件完整性")
    return target, report


def main():
    parser = argparse.ArgumentParser(description="校验三份现场导出，生成只读快照和数据质量报告。")
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=Path(".runtime/plant-intake"))
    args = parser.parse_args()
    try:
        target, report = run(args.input, args.output)
    except (KeyError, TypeError, ValueError, OSError) as error:
        parser.exit(1, f"导入失败：{error}\n")
    print(f"批次 {report['batchId']}")
    print(json.dumps(report["summary"], ensure_ascii=False))
    print(f"产物目录 {target}")


if __name__ == "__main__":
    main()
