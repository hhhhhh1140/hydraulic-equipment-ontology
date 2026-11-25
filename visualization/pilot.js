(() => {
  "use strict";
  const data = window.HydraulicPilotData;
  const flow = window.HydraulicPilotFlow;
  const {element, showCycle} = window.HydraulicApp;
  const get = id => document.getElementById(id);
  const selection = get("pilot-case");
  const message = get("pilot-message");
  const memory = new Map();

  function key(item) {
    return `hydraulic-pilot:v${data.rule.version}:${item.id}`;
  }

  function load(item) {
    if (memory.has(item.id)) return memory.get(item.id);
    try {
      const events = JSON.parse(localStorage.getItem(key(item)) ?? "[]");
      flow.replay(item, data.rule, events);
      return events;
    } catch {
      return [];
    }
  }

  function save(item, events) {
    try {
      localStorage.setItem(key(item), JSON.stringify(events));
    } catch {
      memory.set(item.id, events);
    }
  }

  function formatTime(value) {
    return value.replace("T", " ").slice(0, 16) + " UTC";
  }

  function addPair(list, label, text) {
    list.append(element("dt", label, "muted"), element("dd", text));
  }

  function render() {
    const item = data.cases.find(candidate => candidate.id === selection.value);
    const events = load(item);
    const state = flow.replay(item, data.rule, events);
    const observation = item.observation;
    const evidence = observation?.uci;
    const facts = get("pilot-facts");
    facts.replaceChildren();
    addPair(facts, "告警时刻", formatTime(item.at));
    addPair(facts, "告警时的实体资产", item.asset ?? "无法匹配");
    addPair(facts, "有效安装记录", item.installation ?? "缺失");
    addPair(facts, "测点", observation ? observation.tag : "缺失");
    addPair(facts, "证据质量", item.message);
    if (observation) addPair(facts, "单位", `上报 ${observation.unit} · 契约 ${observation.expectedUnit}`);
    if (evidence) {
      addPair(facts, "UCI 来源", `${evidence.file} · 第 ${evidence.row} 行`);
      addPair(facts, "实验室标签", `泵内泄漏等级 ${evidence.pumpCode} · 稳定标记 ${evidence.flag}`);
      if (item.quality === "QUALIFIED") {
        addPair(facts, "压力摘要", `${evidence.mean} ${evidence.sourceUnit}`);
      }
    }
    const link = get("pilot-uci");
    link.hidden = !evidence;
    link.onclick = evidence ? () => showCycle(evidence.cycle) : null;

    get("pilot-stage").textContent = `${flow.stages[state.stage]}${state.order ? " · " + state.order : ""}`;
    const log = get("pilot-log");
    log.replaceChildren(...state.events.map(event =>
      element("li", `${formatTime(event.at)} · ${event.label} · ${event.actor}`)));
    get("pilot-log-empty").hidden = state.events.length > 0;

    const actions = get("pilot-actions");
    actions.replaceChildren();
    const next = Object.entries(flow.schedule).find(([, step]) => step.from === state.stage);
    if (!next || (state.stage === "review" && !flow.canConfirm(item, data.rule))) {
      if (state.stage === "review") actions.append(element("p", "等待补齐合格证据，当前告警无法发起工单。", "muted"));
      return;
    }

    const [action, step] = next;
    let picker;
    if (action === "retest") {
      const tests = item.retests.filter(test => Date.parse(test.at) > Date.parse(state.events.at(-1).at));
      if (!tests.length) {
        actions.append(element("p", "等待新的复测记录。", "muted"));
        return;
      }
      const label = element("label", "复测记录", "field");
      picker = element("select");
      picker.replaceChildren(...tests.map(test => new Option(
        `UCI 第 ${test.cycle} 周期 · ${formatTime(test.at)}`, test.id)));
      label.append(picker);
      actions.append(label);
    }
    const button = element("button", step.label, "primary");
    button.type = "button";
    button.onclick = () => {
      const event = {action, ...(picker ? {retest:picker.value} : {})};
      try {
        const latest = load(item);
        flow.transition(item, data.rule, flow.replay(item, data.rule, latest), event);
        save(item, [...latest, event]);
        message.textContent = "";
        render();
      } catch (error) {
        message.textContent = error.message;
        render();
      }
    };
    actions.append(button);
  }

  const plant = data.plant;
  get("pilot-hierarchy").textContent = [plant.name, plant.area, plant.center, plant.unit, data.position.id].join(" → ");
  get("pilot-rule").textContent = `${data.rule.name} · ${data.rule.id} v${data.rule.version}`;
  selection.replaceChildren(...data.cases.map(item => new Option(item.label, item.id)));
  selection.addEventListener("change", () => {
    message.textContent = "";
    render();
  });
  get("pilot-window-end").textContent = `样例查询截止时间 ${formatTime(data.asOf)}`;
  get("pilot-history").replaceChildren(...data.closedQuery.map(row => {
    const tr = element("tr");
    const id = value => value.split("#").at(-1);
    const [asset, tag, faultRow, , order, retestRow, result] = row;
    tr.append(...[id(asset), id(tag), faultRow, id(order), retestRow, result === "pass" ? "通过" : result]
      .map(value => element("td", value)));
    return tr;
  }));
  render();
})();
