const state = {
  charts: new Map(),
  filters: null,
  data: null,
  sellerPage: 1,
  productPage: 1,
  multi: new Map(),
};

const PAGE_SIZE = 15;

const palette = {
  page: "#0B1220",
  panel: "#111C2E",
  field: "#17243A",
  border: "#28364D",
  text: "#E6EDF7",
  muted: "#94A3B8",
  blue: "#38BDF8",
  red: "#F87171",
  green: "#34D399",
  purple: "#A78BFA",
  grid: "rgba(40, 54, 77, .52)",
};

Chart.defaults.color = palette.muted;
Chart.defaults.borderColor = palette.grid;
Chart.defaults.font.family = 'Inter, "Segoe UI", system-ui, sans-serif';
Chart.defaults.font.size = 12;

const money = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 0 });
const moneyExact = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const integer = new Intl.NumberFormat("ru-RU");
const percent = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const millions = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 0, maximumFractionDigits: 1 });

function moneyMillions(value) {
  return `${millions.format(Number(value) / 1_000_000)} млн ₽`;
}

function asNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizePercent(value) {
  const number = asNumber(value);
  if (number === null) return null;
  return Math.abs(number) <= 1 ? number * 100 : number;
}

function formatMonth(value) {
  const [year, month] = String(value).split("-").map(Number);
  const names = ["янв.", "фев.", "мар.", "апр.", "май", "июн.", "июл.", "авг.", "сен.", "окт.", "ноя.", "дек."];
  return month >= 1 && month <= 12 ? `${names[month - 1]} ${String(year).slice(-2)}` : String(value);
}

function shortLabel(value, limit = 34) {
  const text = String(value ?? "Без названия");
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function selectedValues(id) {
  return [...document.getElementById(id).selectedOptions].map((option) => option.value);
}

function setNotice(message, isError = false) {
  const node = document.getElementById("notice");
  node.textContent = message;
  node.classList.toggle("error", isError);
}

function markAnalytic(number, value) {
  const element = document.querySelector(`[data-analytic-element="${number}"]`);
  if (element) element.dataset.signature = JSON.stringify(value);
}

async function fetchJSON(url) {
  const response = await fetch(url);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail || `Ошибка HTTP ${response.status}`);
  return body;
}

function fillSelect(id, rows) {
  const select = document.getElementById(id);
  select.replaceChildren(...rows.map((row) => {
    const option = document.createElement("option");
    option.value = row.id;
    option.textContent = row.name;
    return option;
  }));
}

function updateMultiSummary(id) {
  const control = state.multi.get(id);
  if (!control) return;
  const selected = [...control.select.selectedOptions];
  const text = selected.length === 0
    ? control.allLabel
    : selected.length === 1
      ? selected[0].textContent
      : `Выбрано: ${selected.length}`;
  control.summary.textContent = text;
  control.trigger.title = text;
  const selectedSet = new Set(selected.map((option) => option.value));
  control.checkboxes.forEach((checkbox) => { checkbox.checked = selectedSet.has(checkbox.value); });
}

function closeMulti(id, returnFocus = false) {
  const control = state.multi.get(id);
  if (!control || control.menu.hidden) return;
  control.menu.hidden = true;
  control.trigger.setAttribute("aria-expanded", "false");
  control.search.value = "";
  control.optionLabels.forEach((label) => { label.hidden = false; });
  if (returnFocus) control.trigger.focus();
}

function closeAllMultis(exceptId = null) {
  state.multi.forEach((_, id) => {
    if (id !== exceptId) closeMulti(id);
  });
}

function openMulti(id) {
  const control = state.multi.get(id);
  if (!control) return;
  closeAllMultis(id);
  control.menu.hidden = false;
  control.trigger.setAttribute("aria-expanded", "true");
  control.search.focus();
}

function setupMultiSelect(id, allLabel) {
  const select = document.getElementById(id);
  const trigger = document.getElementById(`${id}-trigger`);
  const summary = document.getElementById(`${id}-summary`);
  const menu = document.getElementById(`${id}-menu`);
  const search = document.getElementById(`${id}-search`);
  const optionsHost = document.getElementById(`${id}-options`);
  const clear = document.getElementById(`${id}-clear`);
  const checkboxes = [];
  const optionLabels = [...select.options].map((option) => {
    const label = document.createElement("label");
    label.className = "multi-option";
    label.setAttribute("role", "option");
    label.setAttribute("aria-selected", "false");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = option.value;
    checkbox.setAttribute("aria-label", option.textContent);
    const text = document.createElement("span");
    text.textContent = option.textContent;
    checkbox.addEventListener("change", () => {
      option.selected = checkbox.checked;
      label.setAttribute("aria-selected", String(checkbox.checked));
      updateMultiSummary(id);
    });
    checkboxes.push(checkbox);
    label.append(checkbox, text);
    return label;
  });
  optionsHost.replaceChildren(...optionLabels);
  state.multi.set(id, { select, trigger, summary, menu, search, clear, allLabel, checkboxes, optionLabels });

  trigger.addEventListener("click", () => {
    if (menu.hidden) openMulti(id); else closeMulti(id, true);
  });
  trigger.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      openMulti(id);
    }
  });
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMulti(id, true);
    }
  });
  search.addEventListener("input", () => {
    const query = search.value.trim().toLocaleLowerCase("ru-RU");
    optionLabels.forEach((label) => {
      label.hidden = query !== "" && !label.textContent.toLocaleLowerCase("ru-RU").includes(query);
    });
  });
  search.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      const first = optionLabels.find((label) => !label.hidden)?.querySelector("input");
      if (first) {
        event.preventDefault();
        first.focus();
      }
    }
  });
  clear.addEventListener("click", () => {
    [...select.options].forEach((option) => { option.selected = false; });
    optionLabels.forEach((label) => label.setAttribute("aria-selected", "false"));
    updateMultiSummary(id);
    search.focus();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!menu.hidden && !event.composedPath().includes(document.querySelector(`[data-multiselect="${id}"]`))) closeMulti(id);
  });
  updateMultiSummary(id);
}

function setKpis(kpi) {
  const put = (id, value) => { document.getElementById(id).textContent = value; };
  put("kpi-return-amount", kpi.return_amount === null ? "нет данных" : money.format(asNumber(kpi.return_amount)));
  put("kpi-money-rate", normalizePercent(kpi.return_rate_money_pct) === null ? "—" : `${percent.format(normalizePercent(kpi.return_rate_money_pct))}%`);
  put("kpi-return-positions", kpi.return_positions === null ? "—" : integer.format(kpi.return_positions));
  put("kpi-qty-rate", normalizePercent(kpi.return_rate_qty_pct) === null ? "—" : `${percent.format(normalizePercent(kpi.return_rate_qty_pct))}%`);
  put("data-missing-price", integer.format(kpi.missing_price_positions || 0));
  markAnalytic(1, kpi.return_amount);
  markAnalytic(2, kpi.return_rate_money_pct);
  markAnalytic(3, kpi.return_positions);
  markAnalytic(4, kpi.return_rate_qty_pct);
}

function destroyChart(id) {
  const current = state.charts.get(id);
  if (current) current.destroy();
}

function makeChart(id, config) {
  destroyChart(id);
  const emptyState = {
    id: `emptyState-${id}`,
    afterDraw(chart) {
      const hasData = chart.data.datasets.some((dataset) => dataset.data.some((value) => asNumber(value) !== null));
      if (hasData) return;
      const { ctx, chartArea } = chart;
      ctx.save();
      ctx.fillStyle = palette.muted;
      ctx.font = '500 14px Inter, "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("Нет данных", (chartArea.left + chartArea.right) / 2, (chartArea.top + chartArea.bottom) / 2);
      ctx.restore();
    },
  };
  config.plugins = [...(config.plugins || []), emptyState];
  const chart = new Chart(document.getElementById(id), config);
  state.charts.set(id, chart);
}

function baseOptions({ horizontal = false, stacked = false, valueKind = "number" } = {}) {
  const tooltipFormatter = valueKind === "money"
    ? (value) => money.format(value)
    : valueKind === "percent"
      ? (value) => `${percent.format(value)}%`
      : (value) => integer.format(value);
  const axisFormatter = valueKind === "money" ? moneyMillions : tooltipFormatter;
  return {
    responsive: true,
    maintainAspectRatio: false,
    indexAxis: horizontal ? "y" : "x",
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: stacked, position: "bottom", labels: { usePointStyle: true, boxWidth: 8, color: palette.muted, padding: 16 } },
      tooltip: {
        backgroundColor: palette.field,
        borderColor: palette.border,
        borderWidth: 1,
        titleColor: palette.text,
        bodyColor: palette.text,
        padding: 10,
        callbacks: { label: (context) => `${context.dataset.label ? `${context.dataset.label}: ` : ""}${tooltipFormatter(context.parsed[horizontal ? "x" : "y"] ?? 0)}` },
      },
    },
    scales: horizontal ? {
      x: { beginAtZero: true, stacked, border: { color: palette.border }, grid: { color: palette.grid }, ticks: { color: palette.muted, callback: axisFormatter, maxTicksLimit: 6 } },
      y: { stacked, border: { color: palette.border }, grid: { display: false }, ticks: { color: palette.text, autoSkip: false } },
    } : {
      x: { stacked, border: { color: palette.border }, grid: { display: false }, ticks: { color: palette.muted, maxRotation: 0 } },
      y: { beginAtZero: true, stacked, border: { color: palette.border }, grid: { color: palette.grid }, ticks: { color: palette.muted, callback: axisFormatter, maxTicksLimit: 6 } },
    },
  };
}

function lineDataset(label, data, color, fill = false) {
  return {
    label,
    data,
    borderColor: color,
    backgroundColor: fill ? `${color}20` : color,
    fill,
    borderWidth: 2.5,
    pointRadius: 3,
    pointHoverRadius: 5,
    tension: .28,
  };
}

function renderMonthly(rows) {
  const labels = rows.map((row) => formatMonth(row.month));
  const amounts = rows.map((row) => asNumber(row.return_amount));
  const rates = rows.map((row) => normalizePercent(row.return_rate_money_pct));
  const presentRates = rates.filter((value) => value !== null);
  const dataMin = presentRates.length ? Math.min(...presentRates) : 9;
  const dataMax = presentRates.length ? Math.max(...presentRates) : 15;
  const ratePad = Math.max(.35, (dataMax - dataMin) * .1);
  const rateMin = dataMin < 9 ? Math.max(0, dataMin - ratePad) : 9;
  const rateMax = dataMax > 15 ? dataMax + ratePad : 15;
  const barValueLabels = {
    id: "monthlyBarValueLabels",
    afterDatasetsDraw(chart) {
      const meta = chart.getDatasetMeta(0);
      chart.ctx.save();
      chart.ctx.fillStyle = palette.muted;
      chart.ctx.font = '500 10px Inter, "Segoe UI", system-ui, sans-serif';
      chart.ctx.textAlign = "center";
      chart.ctx.textBaseline = "bottom";
      meta.data.forEach((bar, index) => {
        const value = amounts[index];
        if (value === null) return;
        chart.ctx.fillText(`${millions.format(value / 1_000_000)} млн`, bar.x, bar.y - 5);
      });
      chart.ctx.restore();
    },
  };
  const comboOptions = baseOptions({ valueKind: "money" });
  comboOptions.plugins.legend = { display: true, position: "bottom", labels: { usePointStyle: true, boxWidth: 8, color: palette.muted, padding: 16 } };
  comboOptions.plugins.tooltip.callbacks.label = (context) => {
    const value = context.parsed.y;
    if (value === null) return `${context.dataset.label}: —`;
    const shown = context.dataset.yAxisID === "yRate" ? `${percent.format(value)}%` : moneyExact.format(value);
    return `${context.dataset.label}: ${shown}`;
  };
  comboOptions.layout = { padding: { top: 24 } };
  comboOptions.scales.y.beginAtZero = true;
  comboOptions.scales.y.grace = "12%";
  comboOptions.scales.yRate = {
    beginAtZero: false,
    min: rateMin,
    max: rateMax,
    position: "right",
    border: { color: palette.border },
    grid: { drawOnChartArea: false },
    title: { display: true, text: "%", color: palette.muted },
    ticks: { color: palette.muted, callback: (value) => `${percent.format(value)}%`, maxTicksLimit: 6 },
  };
  comboOptions.scales.y.title = { display: true, text: "млн ₽", color: palette.muted };
  makeChart("monthly-combo", {
    type: "bar",
    data: {
      labels,
      datasets: [
        { type: "bar", label: "Сумма возвратов, руб.", data: amounts, yAxisID: "y", backgroundColor: palette.blue, borderRadius: 3, barPercentage: .72 },
        { ...lineDataset("Доля возвратов, ₽  %", rates, palette.red), type: "line", yAxisID: "yRate", spanGaps: false },
      ],
    },
    options: comboOptions,
    plugins: [barValueLabels],
  });
  makeChart("monthly-status", {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Возвраты покупателей", data: rows.map((row) => asNumber(row.returned_amount)), backgroundColor: palette.blue },
        { label: "Невыкупы", data: rows.map((row) => asNumber(row.not_redeemed_amount)), backgroundColor: palette.purple },
        { label: "Потери при доставке", data: rows.map((row) => asNumber(row.lost_amount)), backgroundColor: palette.red },
      ],
    },
    options: baseOptions({ stacked: true, valueKind: "money" }),
  });
  markAnalytic(5, [rateMin, rateMax, ...rows.map((row) => [row.month, row.return_amount, normalizePercent(row.return_rate_money_pct)])]);
  markAnalytic(6, rows.map((row) => [row.month, row.returned_amount, row.not_redeemed_amount, row.lost_amount]));
}

function topRows(rows, key, limit) {
  return [...rows]
    .filter((row) => asNumber(row[key]) !== null)
    .sort((a, b) => asNumber(b[key]) - asNumber(a[key]))
    .slice(0, limit)
    .reverse();
}

function renderHorizontal(id, rows, labelKey, valueKey, label, color, valueKind, limit) {
  const top = topRows(rows, valueKey, limit);
  makeChart(id, {
    type: "bar",
    data: {
      labels: top.map((row) => shortLabel(row[labelKey])),
      datasets: [{ label, data: top.map((row) => asNumber(row[valueKey])), backgroundColor: color, borderRadius: 5, barPercentage: .72 }],
    },
    options: baseOptions({ horizontal: true, valueKind }),
  });
}

function renderCuts(data) {
  const benchmark = normalizePercent(data.kpi.return_rate_money_pct);
  const rows = [...data.categories]
    .filter((row) => normalizePercent(row.return_rate_money_pct) !== null)
    .sort((a, b) => normalizePercent(b.return_rate_money_pct) - normalizePercent(a.return_rate_money_pct));
  const benchmarkLine = {
    id: "benchmarkLine",
    afterDatasetsDraw(chart, _args, options) {
      if (options.value === null) return;
      const x = chart.scales.x.getPixelForValue(options.value);
      const { top, bottom } = chart.chartArea;
      chart.ctx.save();
      chart.ctx.beginPath();
      chart.ctx.setLineDash([5, 4]);
      chart.ctx.lineWidth = 1.5;
      chart.ctx.strokeStyle = palette.blue;
      chart.ctx.moveTo(x, top);
      chart.ctx.lineTo(x, bottom);
      chart.ctx.stroke();
      const label = `Общая доля: ${percent.format(options.value)}%`;
      chart.ctx.setLineDash([]);
      chart.ctx.fillStyle = palette.blue;
      chart.ctx.font = '600 11px Inter, "Segoe UI", system-ui, sans-serif';
      chart.ctx.textBaseline = "top";
      const width = chart.ctx.measureText(label).width;
      const labelX = Math.min(Math.max(x + 6, chart.chartArea.left), chart.chartArea.right - width);
      chart.ctx.fillText(label, labelX, top + 4);
      chart.ctx.restore();
    },
  };
  const categoryLabels = {
    id: "categoryValueLabels",
    afterDatasetsDraw(chart) {
      const meta = chart.getDatasetMeta(0);
      chart.ctx.save();
      chart.ctx.fillStyle = palette.text;
      chart.ctx.font = '600 11px Inter, "Segoe UI", system-ui, sans-serif';
      chart.ctx.textBaseline = "middle";
      meta.data.forEach((bar, index) => {
        const value = normalizePercent(rows[index].return_rate_money_pct);
        const label = `${percent.format(value)}%`;
        const width = chart.ctx.measureText(label).width;
        const fitsRight = bar.x + 7 + width <= chart.chartArea.right;
        chart.ctx.textAlign = fitsRight ? "left" : "right";
        chart.ctx.fillText(label, fitsRight ? bar.x + 7 : bar.x - 7, bar.y);
      });
      chart.ctx.restore();
    },
  };
  const options = baseOptions({ horizontal: true, valueKind: "percent" });
  options.plugins.legend.display = false;
  options.plugins.benchmarkLine = { value: benchmark };
  options.layout = { padding: { top: 18, right: 20 } };
  options.scales.x.grace = "12%";
  makeChart("category-rate", {
    type: "bar",
    data: {
      labels: rows.map((row) => shortLabel(row.category_name, 42)),
      datasets: [{
        label: "Доля возвратов",
        data: rows.map((row) => normalizePercent(row.return_rate_money_pct)),
        backgroundColor: rows.map((row) => {
          const rate = normalizePercent(row.return_rate_money_pct);
          if (rate > benchmark) return palette.red;
          if (rate < benchmark) return palette.green;
          return palette.blue;
        }),
        borderRadius: 3,
        barPercentage: .7,
      }],
    },
    options,
    plugins: [benchmarkLine, categoryLabels],
  });
  markAnalytic(7, [benchmark, ...rows.map((row) => [row.category_id, normalizePercent(row.return_rate_money_pct)])]);
}

function renderPriceGroups(rows) {
  const rates = rows.map((row) => normalizePercent(row.return_rate_positions_pct));
  const valueLabels = {
    id: "priceGroupValueLabels",
    afterDatasetsDraw(chart) {
      const meta = chart.getDatasetMeta(0);
      chart.ctx.save();
      chart.ctx.fillStyle = palette.text;
      chart.ctx.font = '600 11px Inter, "Segoe UI", system-ui, sans-serif';
      chart.ctx.textAlign = "center";
      chart.ctx.textBaseline = "bottom";
      meta.data.forEach((bar, index) => {
        const value = rates[index];
        if (value === null) return;
        chart.ctx.fillText(`${percent.format(value)}%`, bar.x, bar.y - 6);
      });
      chart.ctx.restore();
    },
  };
  const options = baseOptions({ valueKind: "percent" });
  options.plugins.legend.display = false;
  options.plugins.tooltip.callbacks.title = (items) => rows[items[0]?.dataIndex]?.group_name || "";
  options.plugins.tooltip.callbacks.label = (context) => {
    const row = rows[context.dataIndex];
    const rate = normalizePercent(row.return_rate_positions_pct);
    return [
      `Всего позиций: ${integer.format(row.total_positions)}`,
      `Возвращённых позиций: ${integer.format(row.return_positions)}`,
      `Доля возвратов по позициям: ${rate === null ? "—" : `${percent.format(rate)}%`}`,
      `Сумма возвратов: ${row.return_amount === null ? "—" : moneyExact.format(asNumber(row.return_amount))}`,
    ];
  };
  options.layout = { padding: { top: 24 } };
  options.scales.y.beginAtZero = true;
  options.scales.y.grace = "15%";
  options.scales.y.title = { display: true, text: "%", color: palette.muted };
  makeChart("price-groups", {
    type: "bar",
    data: {
      labels: rows.map((row) => row.group_name),
      datasets: [{
        label: "Доля возвратов по позициям, %",
        data: rates,
        backgroundColor: palette.blue,
        borderRadius: 3,
        barPercentage: .68,
      }],
    },
    options,
    plugins: [valueLabels],
  });
  const invalid = rows.find((row) => row.group_key === "invalid");
  const note = document.getElementById("price-group-note");
  note.textContent = invalid
    ? `Некорректная цена после скидки: ${integer.format(invalid.total_positions)} позиций`
    : "Отрицательных цен после скидки не обнаружено";
  note.classList.toggle("warning", Boolean(invalid));
  markAnalytic(10, rows.map((row) => [
    row.group_key,
    row.total_positions,
    row.return_positions,
    normalizePercent(row.return_rate_positions_pct),
    row.return_amount,
  ]));
}

function cell(text, className = "") {
  const node = document.createElement("td");
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function entityCell(name, id, className = "") {
  const node = document.createElement("td");
  node.className = `entity-cell text-cell ${className}`.trim();
  const title = document.createElement("div");
  title.className = "entity-name";
  title.textContent = name;
  const meta = document.createElement("small");
  meta.className = "entity-id";
  meta.textContent = id === null || id === undefined ? "ID —" : `ID ${id}`;
  node.append(title, meta);
  return node;
}

function emptyRow(columns) {
  const row = document.createElement("tr");
  const item = cell("Нет данных для выбранного среза", "empty-cell");
  item.colSpan = columns;
  row.append(item);
  return row;
}

function renderSellerTable() {
  const rows = state.data?.sellers || [];
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  state.sellerPage = Math.min(state.sellerPage, pages);
  const start = (state.sellerPage - 1) * PAGE_SIZE;
  const body = document.getElementById("seller-rows");
  const visible = rows.slice(start, start + PAGE_SIZE);
  body.replaceChildren(...(visible.length ? visible.map((item) => {
    const row = document.createElement("tr");
    row.append(
      entityCell(item.seller_name, item.seller_id),
      cell(integer.format(item.total_positions), "num-cell"),
      cell(integer.format(item.return_positions), "num-cell"),
      cell(item.return_amount === null ? "—" : money.format(asNumber(item.return_amount)), "num-cell key-col"),
      cell(normalizePercent(item.return_rate_money_pct) === null ? "—" : `${percent.format(normalizePercent(item.return_rate_money_pct))}%`, "num-cell"),
    );
    return row;
  }) : [emptyRow(5)]));
  document.getElementById("seller-summary").textContent = `${integer.format(rows.length)} продавцов · сортировка по сумме возвратов`;
  document.getElementById("seller-page").textContent = `${state.sellerPage} / ${pages}`;
  document.getElementById("seller-prev").disabled = state.sellerPage <= 1;
  document.getElementById("seller-next").disabled = state.sellerPage >= pages;
  markAnalytic(8, [rows.length, rows[0]?.seller_id, rows.reduce((sum, row) => sum + row.total_positions, 0), rows.reduce((sum, row) => sum + row.return_positions, 0)]);
}

function renderProductTable() {
  const rows = state.data?.products || [];
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  state.productPage = Math.min(state.productPage, pages);
  const start = (state.productPage - 1) * PAGE_SIZE;
  const body = document.getElementById("product-rows");
  const visible = rows.slice(start, start + PAGE_SIZE);
  body.replaceChildren(...(visible.length ? visible.map((item) => {
    const row = document.createElement("tr");
    row.append(
      entityCell(item.product_name, item.product_id, "product-name"),
      cell(item.category_name, "text-cell"),
      entityCell(item.seller_name, item.seller_id),
      cell(integer.format(item.total_positions), "num-cell"),
      cell(integer.format(item.return_positions), "num-cell"),
      cell(normalizePercent(item.return_rate_positions_pct) === null ? "—" : `${percent.format(normalizePercent(item.return_rate_positions_pct))}%`, "num-cell key-col"),
      cell(item.return_amount === null ? "—" : money.format(asNumber(item.return_amount)), "num-cell"),
    );
    return row;
  }) : [emptyRow(7)]));
  document.getElementById("product-summary").textContent = `${integer.format(rows.length)} товаров · порог ≥ 20 позиций за выбранный период`;
  document.getElementById("product-page").textContent = `${state.productPage} / ${pages}`;
  document.getElementById("product-prev").disabled = state.productPage <= 1;
  document.getElementById("product-next").disabled = state.productPage >= pages;
  markAnalytic(9, [rows.length, rows[0]?.product_id, rows[0]?.seller_id, rows.reduce((sum, row) => sum + row.total_positions, 0), rows.reduce((sum, row) => sum + row.return_positions, 0), rows.length ? Math.min(...rows.map((row) => row.total_positions)) : null]);
}

async function loadDashboard() {
  const button = document.getElementById("apply");
  button.disabled = true;
  setNotice("Считаем показатели…");
  const params = new URLSearchParams({
    date_from: document.getElementById("date-from").value,
    date_to: document.getElementById("date-to").value,
  });
  selectedValues("categories").forEach((id) => params.append("category_id", id));
  selectedValues("sellers").forEach((id) => params.append("seller_id", id));
  try {
    const data = await fetchJSON(`/api/dashboard?${params}`);
    state.data = data;
    state.sellerPage = 1;
    state.productPage = 1;
    setKpis(data.kpi);
    renderMonthly(data.monthly);
    renderCuts(data);
    renderPriceGroups(data.price_groups || []);
    renderSellerTable();
    renderProductTable();
    setNotice(data.empty ? "Для выбранного среза данных нет." : `Готово · ${integer.format(data.kpi.total_positions)} позиций в выбранном срезе`);
  } catch (error) {
    setNotice(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function resetFilters() {
  document.getElementById("date-from").value = state.filters.date_min;
  document.getElementById("date-to").value = state.filters.date_max;
  [...document.querySelectorAll("select option")].forEach((option) => { option.selected = false; });
  state.multi.forEach((_, id) => updateMultiSummary(id));
  closeAllMultis();
  return loadDashboard();
}

async function init() {
  try {
    state.filters = await fetchJSON("/api/filters");
    document.getElementById("date-from").value = state.filters.date_min;
    document.getElementById("date-to").value = state.filters.date_max;
    fillSelect("categories", state.filters.categories);
    fillSelect("sellers", state.filters.sellers);
    setupMultiSelect("categories", "Все категории");
    setupMultiSelect("sellers", "Все продавцы");
    document.getElementById("apply").addEventListener("click", loadDashboard);
    document.getElementById("reset").addEventListener("click", resetFilters);
    document.getElementById("seller-prev").addEventListener("click", () => { state.sellerPage -= 1; renderSellerTable(); });
    document.getElementById("seller-next").addEventListener("click", () => { state.sellerPage += 1; renderSellerTable(); });
    document.getElementById("product-prev").addEventListener("click", () => { state.productPage -= 1; renderProductTable(); });
    document.getElementById("product-next").addEventListener("click", () => { state.productPage += 1; renderProductTable(); });
    await loadDashboard();
  } catch (error) {
    setNotice(error.message, true);
  }
}

init();
