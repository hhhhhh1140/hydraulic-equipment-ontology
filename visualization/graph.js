(() => {
  "use strict";
  const {data, element, current, showPanel} = window.HydraulicApp;
  const byId = id => document.getElementById(id);
  const palette = {
    HydraulicRig: "rig", HydraulicCircuit: "circuit", OilTank: "tank", Component: "component",
    Channel: "channel", TestCycle: "cycle", ConditionAssessment: "assessment", SignalSummary: "summary"
  };
  const sources = {
    schema: {label: "本体定义", color: "design"},
    structure: {label: "UCI 数据说明", color: "schema"},
    profile: {label: "原始工况与周期", color: "assessment"},
    computed: {label: "信号摘要", color: "summary", dashed: true}
  };
  const sourceUrl = "https://doi.org/10.24432/C5CW21";
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
  const scope = byId("graph-scope");
  const query = byId("graph-query");
  const hops = byId("graph-hops");
  const edgeLabels = byId("graph-labels");
  const message = byId("graph-search-status");
  const params = new URLSearchParams(location.search);
  let selected = null;
  let focus = null;
  let dataset;
  let enabled;

  function schemaGraph() {
    return {
      nodes: Object.entries(data.classes).map(([id, [label, description]]) =>
        ({id, label, type: id, lines: [description]})),
      edges: Object.entries(data.relations).map(([relation, [, from, to]]) =>
        ({from, to, relation, source: "schema"}))
    };
  }

  function instanceGraph(sample) {
    const {number, components, means, profile} = sample;
    const nodes = [];
    const edges = [];
    const add = (id, label, type, ...lines) => nodes.push({id, label, type, lines});
    const link = (from, relation, to, source) => edges.push({from, to, relation, source});
    const cycleId = `Cycle${String(number).padStart(4, "0")}`;

    add("Rig447", "液压试验台", "HydraulicRig", "UCI 447 实验设备");
    add("SharedOilTank", "共用油箱", "OilTank", "连接两个液压回路");
    for (const [id, label] of [["WorkingCircuit", "工作回路"], ["CoolingCircuit", "冷却过滤回路"]]) {
      add(id, label, "HydraulicCircuit");
      link("Rig447", "hasCircuit", id, "structure");
      link(id, "sharesTank", "SharedOilTank", "structure");
    }

    add(cycleId, `周期 ${number}`, "TestCycle", "60 秒", `稳定性：${window.HydraulicApp.stability(profile[4])}`,
      `来源：profile.txt · 第 ${number} 行`);
    link(cycleId, "onRig", "Rig447", "profile");

    for (const component of components) {
      const {id, name, display, meaning} = component;
      const tagId = `${cycleId}-${id}`;
      add(id, name, "Component", `周期 ${number}：${meaning} · ${display}`);
      add(tagId, `${name}工况`, "ConditionAssessment", display, meaning, `来源：profile.txt · 第 ${number} 行`);
      link("Rig447", "hasComponent", id, "structure");
      link(cycleId, "hasAssessment", tagId, "profile");
      link(tagId, "forComponent", id, "profile");
    }

    for (const [id, [quantity, unit, rate, virtual]] of Object.entries(data.channelMetadata)) {
      add(id, `${id} · ${quantity}`, "Channel", `${unit} · ${rate} Hz`, virtual === true ? "虚拟通道" : "");
      link("Rig447", "hasChannel", id, "structure");
    }
    Object.entries(data.channels).forEach(([id, [, unit, rate]], index) => {
      const summaryId = `${cycleId}-${id}`;
      add(summaryId, `${id} 摘要`, "SignalSummary", `均值 ${means[index].toFixed(4)} ${unit}`,
        `${rate * 60} 个样点`, `来源：${id}.txt · 第 ${number} 行`);
      link(cycleId, "hasSummary", summaryId, "computed");
      link(summaryId, "fromChannel", id, "computed");
    });
    return {nodes, edges};
  }

  function checkbox(container, dimension, id, name, color, dashed = false) {
    const label = element("label", null, "check");
    const input = element("input");
    input.type = "checkbox";
    input.checked = enabled[dimension].has(id);
    input.addEventListener("change", () => {
      if (input.checked) enabled[dimension].add(id);
      else enabled[dimension].delete(id);
      render();
    });
    label.append(input);
    if (color) {
      const swatch = element("span", null, dimension === "types" ? "dot" : `edge-key${dashed ? " dashed" : ""}`);
      swatch.style.setProperty("--swatch", css(color));
      swatch.setAttribute("aria-hidden", "true");
      label.append(swatch);
    }
    label.append(document.createTextNode(name));
    container.append(label);
  }

  function setDataset(keepFilters = false) {
    dataset = scope.value === "schema" ? schemaGraph() : instanceGraph(current());
    dataset.byId = new Map(dataset.nodes.map(node => [node.id, node]));
    if (!dataset.byId.has(selected)) selected = null;
    if (!dataset.byId.has(focus)) focus = null;
    const keys = {
      types: new Set(dataset.nodes.map(node => node.type)),
      sources: new Set(dataset.edges.map(edge => edge.source)),
      relations: new Set(dataset.edges.map(edge => edge.relation))
    };
    if (!keepFilters) enabled = keys;
    for (const dimension of Object.keys(keys)) byId(`graph-${dimension}`).replaceChildren();
    for (const type of keys.types) checkbox(byId("graph-types"), "types", type, data.classes[type][0], palette[type]);
    for (const source of keys.sources) {
      const {label, color, dashed} = sources[source];
      checkbox(byId("graph-sources"), "sources", source, label, color, dashed);
    }
    for (const relation of keys.relations) {
      checkbox(byId("graph-relations"), "relations", relation, data.relations[relation][0]);
    }
    byId("graph-names").replaceChildren(...dataset.nodes.map(node => new Option(node.id, node.label)));
    byId("graph-cycle").textContent = scope.value === "schema" ? "8 个类与它们的对象关系" : `实测周期 ${current().number} · 60 秒`;
    render();
  }

  const networkRoot = byId("network");
  if (!window.vis?.Network) {
    byId("graph-error").hidden = false;
    return;
  }
  const nodes = new vis.DataSet();
  const edges = new vis.DataSet();
  const network = new vis.Network(networkRoot, {nodes, edges}, {
    autoResize: true,
    layout: {randomSeed: 447},
    nodes: {shape:"dot", borderWidth:1, font:{size:13, color:css("text"), strokeWidth:3, strokeColor:css("bg")}},
    edges: {
      arrows:{to:{enabled:true, scaleFactor:.55}}, font:{size:10, color:css("muted"), strokeWidth:3, strokeColor:css("bg"), align:"horizontal"},
      smooth:{enabled:true, type:"continuous", roundness:.17}, width:1.15
    },
    physics: {solver:"forceAtlas2Based", forceAtlas2Based:{gravitationalConstant:-56, springLength:105, springConstant:.075},
      stabilization:{iterations:185, fit:false}},
    interaction:{hover:true, tooltipDelay:200, navigationButtons:true}
  });
  let renderId = 0;

  function activeGraph() {
    const available = new Set(dataset.nodes.filter(node => enabled.types.has(node.type)).map(node => node.id));
    let visibleEdges = dataset.edges.filter(edge =>
      available.has(edge.from) && available.has(edge.to) && enabled.sources.has(edge.source) && enabled.relations.has(edge.relation));
    const distance = Number(hops.value);
    if (distance && focus && available.has(focus)) {
      let neighborhood = new Set([focus]);
      for (let i = 0; i < distance; i++) {
        const previous = neighborhood;
        neighborhood = new Set(previous);
        for (const edge of visibleEdges) {
          if (previous.has(edge.from)) neighborhood.add(edge.to);
          if (previous.has(edge.to)) neighborhood.add(edge.from);
        }
      }
      visibleEdges = visibleEdges.filter(edge => neighborhood.has(edge.from) && neighborhood.has(edge.to) &&
        (distance !== 1 || edge.from === focus || edge.to === focus));
      return {visibleNodes: dataset.nodes.filter(node => neighborhood.has(node.id)), visibleEdges};
    }
    return {visibleNodes:dataset.nodes.filter(node => available.has(node.id)), visibleEdges};
  }

  function render() {
    const {visibleNodes, visibleEdges} = activeGraph();
    const id = ++renderId;
    const radial = Number(hops.value) === 1 && visibleNodes.some(node => node.id === focus);
    edges.clear();
    nodes.clear();
    const layout = new Map();
    if (radial) {
      const ring = visibleNodes.filter(node => node.id !== focus);
      const radius = Math.max(120, ring.length * 16);
      layout.set(focus, {x:0, y:0});
      ring.forEach((node, i) => {
        const angle = i * Math.PI * 2 / ring.length - Math.PI / 2;
        layout.set(node.id, {x:radius * Math.cos(angle), y:radius * Math.sin(angle)});
      });
    }
    const degree = new Map();
    for (const edge of visibleEdges) {
      degree.set(edge.from, 1 + (degree.get(edge.from) || 0));
      degree.set(edge.to, 1 + (degree.get(edge.to) || 0));
    }
    nodes.add(visibleNodes.map(node => ({
      id:node.id, label:node.label, title:node.label, ...(layout.get(node.id) || {}),
      size:node.id === focus ? 24 : 9 + Math.min(14, (degree.get(node.id) || 0)),
      color:css(palette[node.type])
    })));
    const labels = edgeLabels.checked || visibleNodes.length <= 9;
    edges.add(visibleEdges.map((edge, index) => ({
      id:index, from:edge.from, to:edge.to, label:labels ? data.relations[edge.relation][0] : undefined,
      dashes:!!sources[edge.source].dashed, color:{color:css(sources[edge.source].color), opacity:.85},
      title:`${data.relations[edge.relation][0]} · ${sources[edge.source].label}`
    })));
    byId("graph-stats").textContent = `显示 ${nodes.length} 个节点 · ${edges.length} 条关系`;
    byId("graph-empty").hidden = nodes.length > 0;
    if (selected && nodes.get(selected)) network.selectNodes([selected]);
    showDetail();
    if (radial || !nodes.length) {
      network.setOptions({physics:false});
      if (nodes.length) network.fit({animation:false});
    } else {
      network.setOptions({physics:true});
      network.stabilize(185);
      network.once("stabilizationIterationsDone", () => {
        if (id === renderId) {
          network.setOptions({physics:false});
          network.fit({animation:false});
          networkRoot.dataset.ready = "1";
        }
      });
    }
    if (radial || !nodes.length) networkRoot.dataset.ready = "1";
  }

  function choose(id, reveal = true) {
    selected = id;
    focus = id;
    if (Number(hops.value)) render();
    else {
      network.selectNodes([id]);
      showDetail();
    }
    if (reveal) byId("graph-detail").scrollIntoView({block:"nearest"});
  }

  function showDetail() {
    const panel = byId("graph-detail");
    const item = selected && dataset.byId.get(selected);
    if (!item || !nodes.get(item.id)) {
      panel.textContent = "选择图上的节点，或搜索实体以查看入边、出边和数据来源。";
      return;
    }
    panel.replaceChildren(element("p", item.label, "node-name"),
      element("p", data.classes[item.type][0], "muted"));
    for (const line of item.lines.filter(Boolean)) panel.append(element("p", line));
    const eligible = activeGraph().visibleEdges;
    for (const [kind, own, other] of [["出边", "from", "to"], ["入边", "to", "from"]]) {
      const related = eligible.filter(edge => edge[own] === item.id);
      panel.append(element("h4", `${kind}（${related.length}）`));
      if (!related.length) continue;
      const list = element("ul");
      for (const edge of related) {
        const li = element("li");
        const opposite = dataset.byId.get(edge[other]);
        const target = element("button", opposite.label, "link-button");
        target.type = "button";
        target.addEventListener("click", () => choose(opposite.id));
        const predicate = data.relations[edge.relation][0];
        if (kind === "出边") li.append(`${predicate} → `, target);
        else li.append(target, ` → ${predicate}`);
        li.append(element("small", ` · ${sources[edge.source].label}`, "muted"));
        list.append(li);
      }
      panel.append(list);
    }
    if (scope.value === "instances") {
      const source = element("a", "原始数据来源");
      source.href = sourceUrl;
      source.target = "_blank";
      source.rel = "noopener";
      const evidence = element("button", `查看周期 ${current().number} 的证据`, "link-button");
      evidence.type = "button";
      evidence.addEventListener("click", () => showPanel("evidence"));
      const footer = element("p");
      footer.append(source, " · ", evidence);
      panel.append(footer);
    }
  }

  function matches(term) {
    const needle = term.trim().toLowerCase();
    if (!needle) return null;
    return dataset.nodes.find(node => node.id.toLowerCase() === needle || node.label.toLowerCase() === needle) ||
      dataset.nodes.find(node => node.label.toLowerCase().includes(needle));
  }

  byId("graph-search").addEventListener("submit", event => {
    event.preventDefault();
    const match = matches(query.value);
    if (!match || !enabled.types.has(match.type)) {
      message.textContent = match ? "该类型已被筛除。" : "当前图谱未找到该实体。";
      return;
    }
    message.textContent = "";
    choose(match.id);
    if (hops.value === "0" && nodes.get(match.id)) network.focus(match.id, {scale:1.2, animation:false});
  });
  scope.addEventListener("change", () => {
    selected = focus = null;
    message.textContent = query.value = "";
    setDataset();
  });
  hops.addEventListener("change", render);
  edgeLabels.addEventListener("change", render);
  byId("graph-fit").addEventListener("click", () => { if (nodes.length) network.fit({animation:false}); });
  network.on("click", event => {
    if (event.nodes[0]) choose(event.nodes[0]);
  });
  document.addEventListener("hydraulic:cycle", () => { if (scope.value === "instances") setDataset(true); });
  document.addEventListener("hydraulic:panel", event => {
    if (event.detail === "graph" && nodes.length) {
      requestAnimationFrame(() => { network.redraw(); network.fit({animation:false}); });
    }
  });

  const initialHops = params.get("hops");
  if (params.get("scope") === "schema") scope.value = "schema";
  setDataset();
  const initial = matches(params.get("focus") || "");
  if (initial) {
    hops.value = ["0", "1", "2"].includes(initialHops) ? initialHops : "1";
    choose(initial.id, false);
  }
})();
