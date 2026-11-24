(() => {
  "use strict";
  const data = JSON.parse(document.getElementById("hyd447-data").textContent);
  const filter = document.getElementById("hy-filter");
  const cycle = document.getElementById("hy-cycle");
  const status = document.getElementById("hy-state");
  const assessments = document.getElementById("hy-assessments");
  const signals = document.getElementById("hy-signals");
  const filterFns = {
    all: () => true,
    severe: profile => profile[2] === 2,
    both: profile => profile[2] === 2 && profile[3] === 90
  };

  function element(tag, value, className) {
    const node = document.createElement(tag);
    if (value != null) node.textContent = value;
    if (className) node.className = className;
    return node;
  }

  function row(values) {
    const item = element("tr");
    item.append(...values.map(value => element("td", value)));
    return item;
  }

  function displayValue(code, unit) {
    return unit === "等级" ? `等级 ${code}` : `${code} ${unit}`;
  }

  function stability(flag) {
    return flag === 0 ? "稳定（0）" : "可能尚未稳定（1）";
  }

  function snapshot(number) {
    return {
      number,
      profile: data.profiles[number - 1],
      means: data.means[number - 1],
      components: data.components.map(([id, name, unit, meanings], index) => {
        const code = data.profiles[number - 1][index];
        return {id, name, code, meaning: meanings[code], display: displayValue(code, unit)};
      })
    };
  }

  function renderEvidence() {
    const sample = snapshot(Number(cycle.value));
    status.textContent = `周期 ${sample.number} · 60 秒 · ${stability(sample.profile[4])} · 筛选命中 ${cycle.options.length} 个周期`;
    assessments.replaceChildren(...sample.components.map(component =>
      row([component.name, component.display, component.meaning])));
    signals.replaceChildren(...Object.entries(data.channels).map(([id, [quantity, unit]], index) =>
      row([`${id} · ${quantity}`, `${sample.means[index].toFixed(4)} ${unit}`, `${id}.txt · 第 ${sample.number} 行`])));
    document.dispatchEvent(new CustomEvent("hydraulic:cycle", {detail: sample}));
  }

  function applyFilter(preferred) {
    const predicate = filterFns[filter.value];
    const options = data.profiles.flatMap((profile, index) =>
      predicate(profile) ? [new Option(String(index + 1), String(index + 1))] : []);
    cycle.replaceChildren(...options);
    if (options.some(option => option.value === String(preferred))) cycle.value = String(preferred);
    renderEvidence();
  }

  const panels = ["graph", "evidence", "sandbox"];
  function showPanel(panel) {
    for (const id of panels) {
      const active = id === panel;
      document.getElementById(`tab-${id}`).setAttribute("aria-pressed", String(active));
      document.getElementById(`panel-${id}`).hidden = !active;
    }
    document.dispatchEvent(new CustomEvent("hydraulic:panel", {detail: panel}));
  }

  for (const id of panels) document.getElementById(`tab-${id}`).addEventListener("click", () => showPanel(id));
  filter.addEventListener("change", () => applyFilter(cycle.value));
  cycle.addEventListener("change", renderEvidence);
  const requested = Number(new URLSearchParams(location.search).get("cycle"));
  const initial = Number.isInteger(requested) && requested > 0 && requested <= data.profiles.length
    ? requested : data.example.row;
  window.HydraulicApp = {
    data, element, displayValue, stability, showPanel,
    current: () => snapshot(Number(cycle.value))
  };
  applyFilter(initial);
  const view = new URLSearchParams(location.search).get("view");
  if (panels.includes(view) && view !== "graph") {
    window.addEventListener("load", () => showPanel(view), {once: true});
  }
})();
