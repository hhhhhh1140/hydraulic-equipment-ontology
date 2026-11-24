(() => {
  "use strict";
  const {data, element, current, displayValue, stability, showPanel} = window.HydraulicApp;
  const {policies, rules, run} = window.HydraulicSimulation;
  const byId = id => document.getElementById(id);
  const horizon = byId("sandbox-horizon");
  const time = byId("sandbox-time");
  const stepButton = byId("sandbox-step");
  const endButton = byId("sandbox-end");
  const resetButton = byId("sandbox-reset");
  const plans = [byId("plan-a"), byId("plan-b")];
  const units = Object.fromEntries(data.components.map(([id, , unit]) => [id, unit]));
  let step = 0;

  function renderPlan(panel, name, policy, sample) {
    const result = run(sample.profile, policy, step);
    const table = element("table", null, "table");
    const head = element("thead");
    const headRow = element("tr");
    headRow.append(...["部件", "模拟工况值", "处理状态"].map(label => {
      const th = element("th", label);
      th.scope = "col";
      return th;
    }));
    head.append(headRow);
    const body = element("tbody");
    for (const state of result.states) {
      const row = element("tr");
      row.append(element("td", state.name), element("td", displayValue(state.value, units[state.id])),
        element("td", state.status));
      body.append(row);
    }
    table.append(head, body);
    const log = element("ol");
    for (const event of result.events) {
      log.append(element("li", `第 ${event.step} 步 · ${event.description}（${event.rule}）`));
    }
    panel.replaceChildren(element("h3", `方案 ${name} · ${policies[policy].label}`),
      element("p", `未恢复 ${result.remaining} 项 · 严重工况 ${result.severe} 项 · 完成维护 ${result.completed} 项`),
      element("p", `累计严重部件步数 ${result.cumulativeSevere}`, "muted small"),
      table, element("h4", "行动记录"),
      result.events.length ? log : element("p", "尚无行动", "muted small"));
  }

  function render() {
    const sample = current();
    byId("sandbox-baseline").textContent = `周期 ${sample.number} · 60 秒 · ${stability(sample.profile[4])}`;
    byId("sandbox-measured").textContent = sample.components.map(item =>
      `${item.name} ${item.display}（${item.meaning}）`).join(" · ");
    time.textContent = `第 ${step} / ${horizon.value} 步`;
    stepButton.disabled = endButton.disabled = step >= Number(horizon.value);
    resetButton.disabled = step === 0;
    renderPlan(byId("sandbox-a"), "A", plans[0].value, sample);
    renderPlan(byId("sandbox-b"), "B", plans[1].value, sample);
  }

  function reset() {
    step = 0;
    render();
  }

  for (const plan of plans) {
    plan.replaceChildren(...Object.entries(policies).map(([id, policy]) => new Option(policy.label, id)));
    plan.addEventListener("change", reset);
  }
  plans[0].value = "hold";
  plans[1].value = "pump";
  horizon.addEventListener("change", reset);
  byId("sandbox-pick-cycle").addEventListener("click", () => showPanel("evidence"));
  resetButton.addEventListener("click", reset);
  stepButton.addEventListener("click", () => {step++; render();});
  endButton.addEventListener("click", () => {step = Number(horizon.value); render();});
  document.addEventListener("hydraulic:cycle", reset);
  const priorities = Object.values(policies).filter(policy => policy.rank.length).map(policy =>
    `${policy.label}：${policy.rank.map(id => data.components.find(component => component[0] === id)[1]).join(" → ")}。`);
  byId("sandbox-rules").replaceChildren(...[...rules, ...priorities].map(rule => element("li", rule)));
  render();
})();
