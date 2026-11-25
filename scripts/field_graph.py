"""Export verified field evidence and work orders to the industrial OWL vocabulary."""
from decimal import Decimal

from rdflib import Graph, Literal, Namespace, RDF, RDFS
from rdflib.namespace import DCTERMS, PROV, XSD

from build_industrial import M, SOSA


def field_graph(snapshot):
    g = Graph(bind_namespaces="none")
    ns = Namespace(f"https://example.org/hydraulics/field/{snapshot['batchId']}/")
    for prefix, vocab in (("m",M), ("field",ns), ("prov",PROV), ("sosa",SOSA), ("xsd",XSD),
                          ("rdf",RDF), ("rdfs",RDFS), ("dct",DCTERMS)):
        g.bind(prefix, vocab)

    def node(kind, ident):
        return ns[f"{kind}/{ident}"]

    def put(subject, predicate, value, datatype=None):
        if value is not None:
            g.add((subject, predicate, Literal(value, datatype=datatype)))

    for filename, digest in snapshot["sourceSha256"].items():
        ref = node("source", filename)
        g.add((ref, RDF.type, PROV.Entity))
        put(ref, DCTERMS.identifier, filename)
        put(ref, M.sha256, digest)

    plant = snapshot["plant"]
    parent = None
    for kind, label in (("Site", plant["name"]), ("Area", plant["area"]),
                        ("WorkCenter", plant["center"]), ("WorkUnit", plant["unit"])):
        current = node(kind, plant["id"])
        g.add((current, RDF.type, M[kind]))
        put(current, RDFS.label, label)
        if parent:
            g.add((current, M.parent, parent))
        parent = current
    position = node("position", snapshot["position"]["id"])
    g.add((position, RDF.type, M.Position))
    g.add((position, M.parent, parent))
    put(position, RDFS.label, snapshot["position"]["name"])

    for asset in snapshot["assets"].values():
        subject = node("asset", asset["id"])
        g.add((subject, RDF.type, M.Asset))
        put(subject, RDFS.label, asset["name"])
        put(subject, DCTERMS.identifier, asset["id"])
    for record in snapshot["installations"]:
        subject = node("installation", record["id"])
        g.add((subject, RDF.type, M.Installation))
        g.add((subject, M.position, node("position", record["position"])))
        g.add((subject, M.asset, node("asset", record["asset"])))
        g.add((subject, PROV.wasDerivedFrom, node("source", "assets.json")))
        put(subject, M.validFrom, record["from"], XSD.dateTime)
        put(subject, M.validUntil, record["until"], XSD.dateTime)
    for tag in snapshot["tags"].values():
        subject = node("tag", tag["id"])
        g.add((subject, RDF.type, M.Tag))
        g.add((subject, RDF.type, SOSA.Sensor))
        g.add((subject, SOSA.observes, M[tag["quantity"]]))
        g.add((M[tag["quantity"]], RDF.type, SOSA.ObservableProperty))
        put(subject, RDFS.label, tag["label"])
        put(subject, M.expectedUnit, tag["unit"], XSD.string)

    for obs in snapshot["observations"].values():
        if obs["quality"] != "QUALIFIED":
            continue
        subject = node("observation", obs["id"])
        for kind in (M.FieldObservation, SOSA.Observation):
            g.add((subject, RDF.type, kind))
        g.add((subject, SOSA.madeBySensor, node("tag", obs["tag"])))
        g.add((subject, SOSA.observedProperty, M[obs["quantity"]]))
        g.add((subject, SOSA.hasFeatureOfInterest, node("asset", obs["asset"])))
        g.add((subject, M.installation, node("installation", obs["installation"])))
        g.add((subject, PROV.wasDerivedFrom, node("source", "historian.json")))
        put(subject, M.observedAt, obs["at"], XSD.dateTime)
        put(subject, M.sourceRow, obs["sourceRow"], XSD.integer)
        put(subject, M.reportedUnit, obs["reportedUnit"], XSD.string)
        put(subject, M.reportedValue, obs["reportedValue"], XSD.string)
        put(subject, M.standardUnit, obs["unit"], XSD.string)
        put(subject, M.reading, Decimal(obs["value"]), XSD.decimal)

    for alarm in snapshot["cases"]:
        subject = node("alarm", alarm["id"])
        g.add((subject, RDF.type, M.FieldAlarm))
        g.add((subject, PROV.wasDerivedFrom, node("source", "maintenance.json")))
        if alarm["installation"]:
            g.add((subject, M.installation, node("installation", alarm["installation"])))
        put(subject, M.observedAt, alarm["at"], XSD.dateTime)
        put(subject, M.sourceRow, alarm["sourceRow"], XSD.integer)
        put(subject, M.quality, alarm["quality"], XSD.string)
        put(subject, RDFS.label, alarm["label"])
        for ref in alarm["references"]:
            if ref["eligible"]:
                g.add((subject, M.evidence, node("observation", ref["id"])))
        for order in alarm["orders"]:
            if order["result"] != "结案已核验":
                continue
            record = node("order", order["id"])
            g.add((record, RDF.type, M.VerifiedFieldOrder))
            g.add((record, M.relatedAlarm, subject))
            g.add((record, M.asset, node("asset", alarm["asset"])))
            g.add((record, M.retestObservation, node("observation", order["retest"]["id"])))
            g.add((record, PROV.wasDerivedFrom, node("source", "maintenance.json")))
            put(record, DCTERMS.identifier, order["id"])
            put(record, M.sourceRow, order["sourceRow"], XSD.integer)
            put(record, M.fieldFaultCode, order["faultCode"], XSD.string)
            put(record, M.confirmedAt, order["confirmedAt"], XSD.dateTime)
            put(record, M.reviewer, order["confirmedBy"], XSD.string)
            put(record, M.approvedAt, order["approvedAt"], XSD.dateTime)
            put(record, M.completedAt, order["completedAt"], XSD.dateTime)
            put(record, M.closedAt, order["closedAt"], XSD.dateTime)
    return g
