(() => {
  "use strict";
  const get = id => document.getElementById(id);
  const roleName = {engineer:"工程师", supervisor:"审批人", technician:"维修人员"};
  const selection = get("case");
  const notice = get("notice");
  let session = null;
  let detail;
  let pending;
  let busy = false;

  function element(tag, text) {
    const item = document.createElement(tag);
    if (text != null) item.textContent = text;
    return item;
  }

  async function api(path, token, body) {
    const options = {headers:{Authorization:`Bearer ${token}`}};
    if (body) {
      options.method = "POST";
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    const response = await fetch(path, options);
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.message), {http:response.status, code:data.code});
    return data;
  }

  function time(value) {
    return value ? value.replace("T", " ").slice(0, 19) + " UTC" : "—";
  }

  function render() {
    const {case:item, stageLabel, order, revision, next, audit} = detail;
    get("stage").textContent = stageLabel;
    const field = detail.mode === "read-only";
    get("order").textContent = field ? detail.orderLabel : `${order ?? "未建立工单"} · 版本 ${revision}`;
    const observation = item.observation;
    const sample = observation?.uci;
    const rows = [
      ["告警", item.id], [field ? "告警时刻" : "场景时刻", time(item.at)], ["安装位", item.position],
      ["告警时资产", item.asset ?? "缺失"], ["安装记录", item.installation ?? "缺失"],
      ["证据质量", item.message], ["测点", observation?.tag ?? "缺失"],
      ["原始文件", sample ? `${sample.file} · 第 ${sample.row} 行` : "缺失"],
      ["压力摘要", sample && item.quality === "QUALIFIED" ? `${sample.mean} ${sample.sourceUnit}` : "无合格读数"]
    ];
    if (field) {
      rows.splice(6);
      rows.push(["告警来源", `maintenance.json · 告警数组第 ${item.sourceRow} 条`]);
    }
    get("evidence").replaceChildren(...rows.flatMap(([key, value]) =>
      [element("dt", key), element("dd", value)]));

    const references = get("field-references");
    const orders = get("field-orders");
    references.hidden = orders.hidden = !field;
    if (field) {
      references.replaceChildren(...item.references.map(ref => {
        const reading = ref.eligible ? ` · ${ref.value} ${ref.unit}（原 ${ref.reportedValue} ${ref.reportedUnit}）` : "";
        const origin = ref.sourceRow ? ` · historian.json 第 ${ref.sourceRow} 条` : "";
        return element("li", `${ref.id} · ${ref.message}${reading}${origin}`);
      }));
      orders.replaceChildren(...item.orders.map(row => {
        const retest = row.retest ? ` · 复测 ${row.retest.id}，${row.retest.value} ${row.retest.unit}` : "";
        return element("li", `${row.id} · ${row.result}${retest}`);
      }));
    }

    const action = get("action");
    action.replaceChildren();
    if (field) {
      action.append(element("p", "当前为只读快照。"));
    } else if (next && !next.allowed) {
      action.append(element("p", `下一步为「${next.label}」，请由${roleName[next.role]}登录后操作。`));
    } else if (next) {
      const form = element("form");
      let retest;
      if (next.action === "retest") {
        const label = element("label", "复测记录");
        label.className = "field";
        retest = element("select");
        retest.replaceChildren(...next.retests.map(item => new Option(
          `UCI 第 ${item.cycle} 周期 · ${time(item.at)}`, item.id)));
        label.append(retest);
        form.append(label);
      }
      const button = element("button", next.label);
      button.className = "primary";
      form.append(button);
      form.addEventListener("submit", event => {
        event.preventDefault();
        perform(next.action, retest?.value);
      });
      action.append(form);
    } else if (detail.stage === "review" || detail.stage === "maintained") {
      action.append(element("p", "等待合格证据或新的复测记录。"));
    }

    const list = audit.map(event => {
      const tr = element("tr");
      tr.append(...[
        event.label,
        event.source === "seed" ? `${event.actor}（样例）` :
          event.source === "import" ? event.actor : `${event.actor} · ${roleName[event.role]}`,
        time(event.scenarioAt), time(event.recordedAt)
      ].map(value => element("td", value)));
      return tr;
    });
    if (!list.length) {
      const row = element("tr");
      const cell = element("td", "尚无操作记录。");
      cell.colSpan = 4;
      row.append(cell);
      list.push(row);
    }
    get("audit").replaceChildren(...list);
  }

  async function openCase(id) {
    detail = await api(`/api/cases/${encodeURIComponent(id)}`, session.token);
    selection.value = id;
    render();
  }

  async function run(task) {
    if (busy) return;
    busy = true;
    notice.textContent = "";
    const controls = [...document.querySelectorAll("button, select, input")];
    for (const control of controls) control.disabled = true;
    try {
      await task();
    } catch (error) {
      if (detail) selection.value = detail.case.id;
      notice.textContent = error.message;
    } finally {
      for (const control of controls) control.disabled = false;
      busy = false;
    }
  }

  function perform(action, retest) {
    return run(async () => {
      const {revision, case:{id}} = detail;
      const key = JSON.stringify([session.viewer.id, id, revision, action, retest]);
      if (pending?.key !== key) {
        pending = {key, requestId:crypto.randomUUID()};
      }
      try {
        const response = await api(`/api/cases/${encodeURIComponent(id)}/actions`, session.token,
          {action, retest, revision, requestId:pending.requestId});
        detail = response.detail;
        pending = null;
        render();
        notice.textContent = response.idempotent ? "该操作已记录，服务端返回了当前状态。" : "操作已写入数据库。";
      } catch (error) {
        if (error.http) pending = null;
        if (error.code === "REVISION_CONFLICT") await openCase(id);
        throw error;
      }
    });
  }

  get("login").addEventListener("submit", event => {
    event.preventDefault();
    const token = get("token").value.trim();
    get("token").value = "";
    run(async () => {
      const summary = await api("/api/cases", token);
      const currentId = selection.value;
      session = {token, viewer:summary.viewer};
      get("session-identity").textContent = `${summary.viewer.id} · ${roleName[summary.viewer.role]}`;
      const field = summary.mode === "read-only";
      get("data-mode").textContent = field ? (summary.isSample ? "合成导入样例 · 只读核验" : "导入工作台 · 只读核验") :
        "本地服务端回放。测点证据来自 UCI，资产、工单及场景时刻为演示数据。";
      get("event-time-heading").textContent = field ? "来源时刻" : "场景时刻";
      get("audit-note").textContent = field ? "下列操作和人员来自导入的维修记录。" :
        "场景时刻用于回放排序，入库时刻由本地服务记录。";
      const intake = get("intake-summary");
      intake.hidden = !field;
      if (field) {
        const totals = summary.qualitySummary;
        intake.textContent = `批次 ${summary.batchId} · ${totals.qualifiedAlarms} 起有合格证据 · ${totals.blockedAlarms} 起待补证据 · ${totals.verifiedClosed} 张结案已核验`;
      }
      const plant = summary.plant;
      get("plant").textContent = [plant.name, plant.area, plant.center, plant.unit, summary.position.id].join(" → ");
      selection.replaceChildren(...summary.cases.map(item => new Option(item.label, item.id)));
      const id = summary.cases.some(item => item.id === currentId) ? currentId : summary.cases[0]?.id;
      if (!id) throw new Error("此快照没有回放案例。");
      await openCase(id);
      get("workspace").hidden = false;
    });
  });
  selection.addEventListener("change", () => run(() => openCase(selection.value)));
  get("refresh").addEventListener("click", () => run(() => openCase(selection.value)));
})();
