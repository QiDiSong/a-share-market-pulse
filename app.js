/* =========================================================
   量能脉搏 · A股实时看板
   ========================================================= */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const nf0 = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const nf2 = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const REFRESH_MS = 5000;

  const state = {
    data: null,
    loading: false,
    paused: false,
    nextRefreshAt: 0,
    lastSuccessAt: 0,
    failures: 0,
  };

  const charts = {};

  const sectorState = {
    items: [],
    selectedCode: null,
    hoveredCode: null,
    maxAbs: 3,
    lastWidth: 0,
    lastHeight: 0,
    resizeFrame: 0,
  };

  /* ---------- Formatting ---------- */

  function num(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  function fmtInt(value) {
    const v = num(value);
    return v === null ? '—' : nf0.format(v);
  }

  function fmt(value, digits = 2) {
    const v = num(value);
    if (v === null) return '—';
    return new Intl.NumberFormat('zh-CN', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(v);
  }

  function fmtSigned(value, digits = 0) {
    const v = num(value);
    if (v === null) return '—';
    const sign = v > 0 ? '+' : v < 0 ? '−' : '';
    return sign + new Intl.NumberFormat('zh-CN', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(Math.abs(v));
  }

  function fmtSignedPct(value, digits = 2) {
    const v = num(value);
    if (v === null) return '—';
    return `${fmtSigned(v, digits)}%`;
  }

  function fmtPct(value, digits = 1) {
    const v = num(value);
    return v === null ? '—' : `${nf1.format(v)}%`;
  }

  function amountParts(yuan) {
    const v = num(yuan);
    if (v === null) return { main: '—', unit: '', detail: '— 亿元' };
    const yi = v / 1e8;
    if (yi >= 10000) {
      return {
        main: (yi / 10000).toFixed(2),
        unit: '万亿',
        detail: `${nf0.format(Math.round(yi))} 亿元`,
      };
    }
    return {
      main: nf0.format(Math.round(yi)),
      unit: '亿',
      detail: `${nf0.format(Math.round(yi))} 亿元`,
    };
  }

  function amountShort(yuan) {
    const v = num(yuan);
    if (v === null) return '—';
    const yi = v / 1e8;
    if (Math.abs(yi) >= 10000) return `${(yi / 10000).toFixed(2)}万亿`;
    if (Math.abs(yi) >= 100) return `${nf0.format(Math.round(yi))}亿`;
    return `${nf1.format(yi)}亿`;
  }

  function amountDelta(yuan) {
    const v = num(yuan);
    if (v === null) return '—';
    const yi = v / 1e8;
    if (Math.abs(yi) >= 10000) return `${fmtSigned(yi / 10000, 2)} 万亿`;
    return `${fmtSigned(yi, 0)} 亿元`;
  }

  function amountYi(yuan) {
    const v = num(yuan);
    return v === null ? '—' : `${nf0.format(Math.round(v / 1e8))} 亿`;
  }

  function trendClass(value, tolerance = 0.00001) {
    const v = num(value);
    if (v === null) return 'is-neutral';
    if (v > tolerance) return 'is-positive';
    if (v < -tolerance) return 'is-negative';
    return 'is-neutral';
  }

  function setTrend(el, value, tolerance = 0.00001) {
    if (!el) return;
    el.classList.remove('is-positive', 'is-negative', 'is-neutral');
    el.classList.add(trendClass(value, tolerance));
  }

  function shortDate(dateStr, dot = true) {
    if (!dateStr) return '—';
    const parts = String(dateStr).split('-');
    if (parts.length < 3) return dateStr;
    return dot ? `${parts[1]}.${parts[2]}` : `${parts[1]}月${parts[2]}日`;
  }

  function chineseDate(dateStr) {
    if (!dateStr) return '—';
    const parts = String(dateStr).split('-');
    if (parts.length < 3) return dateStr;
    return `${parts[0]}年${parts[1]}月${parts[2]}日`;
  }

  function asOfClock(asOf) {
    if (!asOf || !String(asOf).includes(' ')) return '—';
    return String(asOf).split(' ')[1];
  }

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value;
  }

  /* ---------- Header & summary ---------- */

  function setChip(el, label, cls) {
    if (!el) return;
    el.textContent = label;
    el.classList.remove('is-up', 'is-down', 'chip-neutral');
    if (cls) el.classList.add(cls);
  }

  function renderHeader(data) {
    const session = data.session || {};
    const tradeDate = data.tradeDate || '';
    const asOf = asOfClock(data.asOf);
    const isTrading = Boolean(session.isTrading);

    const pill = $('sessionPill');
    pill.dataset.state = session.state || 'closed';
    setText('sessionText', session.label || '休市');

    setText('headerDate', tradeDate ? `${tradeDate.replaceAll('-', '.')} · ${data.tradeWeekday || ''}` : '—');
    let subText;
    if (isTrading) {
      subText = `交易中 · 行情截至 ${asOf}`;
    } else if (session.state === 'break') {
      subText = `午间休市 · 最近交易日 ${data.latestDateLabel || ''}`.trim();
    } else {
      subText = session.note || session.label || '等待开盘';
    }
    setText('headerSub', subText);

    setText('asOfTime', asOf);
    const sameDay = tradeDate && session.today === tradeDate;
    setText(
      'asOfDate',
      tradeDate
        ? `${chineseDate(tradeDate)} ${data.tradeWeekday || ''}${sameDay ? '' : ' · 最近交易日'}`
        : '—'
    );

    let liveMode = 'LAST';
    if (isTrading) liveMode = 'LIVE';
    else if (session.state === 'break') liveMode = 'PAUSE';
    else if (session.state === 'preopen') liveMode = 'PRE';

    const liveBadge = $('liveBadge');
    if (liveBadge) liveBadge.classList.toggle('is-closed', !isTrading);
    setText('liveLabel', liveMode);

    const liveChip = document.querySelector('.live-chip');
    if (liveChip) liveChip.classList.toggle('is-closed', !isTrading);
    setText('turnoverLiveLabel', liveMode);

    const markets = data.markets || {};
    renderTape('tapeShValue', 'tapeShPct', markets.sh);
    renderTape('tapeSzValue', 'tapeSzPct', markets.sz);
    renderTape('tapeCybValue', 'tapeCybPct', markets.cyb);

    const index = data.index || {};
    setText('indexValue', fmt(index.value, 2));
    const changeEl = $('indexChange');
    if (changeEl) {
      changeEl.textContent = `${fmtSigned(index.change, 2)} · ${fmtSignedPct(index.changePct, 2)}`;
      setTrend(changeEl, index.changePct);
    }
    setText('preClose', fmt(index.preClose, 2));
  }

  function renderTape(valueId, pctId, market) {
    if (!market) return;
    setText(valueId, fmt(market.value, 2));
    const pctEl = $(pctId);
    if (!pctEl) return;
    pctEl.textContent = fmtSignedPct(market.changePct, 2);
    setTrend(pctEl, market.changePct);
  }

  function renderBreadth(data) {
    const b = data.breadth || {};
    setText('upCount', fmtInt(b.up));
    setText('downCount', fmtInt(b.down));
    setText('flatCount', fmtInt(b.flat));
    setText('upShare', b.upPct === null || b.upPct === undefined ? '—' : `${nf1.format(b.upPct)}%`);
    setText('downShare', b.downPct === null || b.downPct === undefined ? '—' : `${nf1.format(b.downPct)}%`);
    setText('upDownRatio', b.ratio === null || b.ratio === undefined ? '—' : fmt(b.ratio, 2));

    const sh = data.markets?.sh || {};
    const sz = data.markets?.sz || {};
    setText('shBreadth', `${fmtInt(sh.up)} ↑ / ${fmtInt(sh.down)} ↓`);
    setText('szBreadth', `${fmtInt(sz.up)} ↑ / ${fmtInt(sz.down)} ↓`);

    const upSeg = $('upSegment');
    const flatSeg = $('flatSegment');
    const downSeg = $('downSegment');
    if (upSeg) upSeg.style.width = `${b.upPct || 0}%`;
    if (flatSeg) flatSeg.style.width = `${b.flatPct || 0}%`;
    if (downSeg) downSeg.style.width = `${b.downPct || 0}%`;

    setText('upMix', b.upPct === null || b.upPct === undefined ? '—' : `${nf1.format(b.upPct)}%`);
    setText('flatMix', b.flatPct === null || b.flatPct === undefined ? '—' : `${nf1.format(b.flatPct)}%`);
    setText('downMix', b.downPct === null || b.downPct === undefined ? '—' : `${nf1.format(b.downPct)}%`);
    setText('breadthTotal', `共 ${fmtInt(b.total)} 只`);

    const mood = $('breadthMood');
    if (!num(b.up) || !num(b.down)) {
      setChip(mood, '等待行情', 'chip-neutral');
    } else if (b.up > b.down * 1.35) {
      setChip(mood, '多方占优', 'is-up');
    } else if (b.down > b.up * 1.35) {
      setChip(mood, '空方占优', 'is-down');
    } else {
      setChip(mood, '多空拉锯', 'chip-neutral');
    }
  }

  function renderTurnover(data) {
    const t = data.turnover || {};
    const parts = amountParts(t.current);
    setText('turnoverBig', parts.main);
    setText('turnoverUnit', parts.unit);
    setText('turnoverYi', parts.detail);

    const deltaEl = $('turnoverDelta');
    if (deltaEl) {
      deltaEl.textContent = num(t.delta) === null ? '—' : amountDelta(t.delta);
      setTrend(deltaEl, t.delta);
    }
    const pctEl = $('turnoverDeltaPct');
    if (pctEl) {
      pctEl.textContent = num(t.deltaPct) === null ? '—' : fmtSignedPct(t.deltaPct, 1);
      setTrend(pctEl, t.deltaPct);
    }

    setText('shTurnover', amountYi(t.currentSh));
    setText('szTurnover', amountYi(t.currentSz));

    const current = num(t.current) || 0;
    const shPct = current > 0 ? ((num(t.currentSh) || 0) / current) * 100 : 50;
    const szPct = current > 0 ? ((num(t.currentSz) || 0) / current) * 100 : 50;
    const shBar = $('shSplitBar');
    const szBar = $('szSplitBar');
    if (shBar) shBar.style.width = `${shPct}%`;
    if (szBar) szBar.style.width = `${szPct}%`;

    const progress = num(t.prevFull) && current ? (current / t.prevFull) * 100 : null;
    setText('dayProgressPct', progress === null ? '—' : `${nf1.format(progress)}%`);
    const progressBar = $('dayProgressBar');
    if (progressBar) progressBar.style.width = `${progress === null ? 0 : Math.min(100, progress)}%`;
    setText(
      'prevFullNote',
      num(t.prevFull) === null ? '上一交易日全天 —' : `上一交易日全天 ${amountShort(t.prevFull)}`
    );
  }

  function renderDelta(data) {
    const t = data.turnover || {};
    const delta = num(t.delta);
    const pct = num(t.deltaPct);

    let label = '量能持平';
    let cls = 'chip-neutral';
    if (delta !== null && delta > 0) {
      label = '放量';
      cls = 'is-up';
    } else if (delta !== null && delta < 0) {
      label = '缩量';
      cls = 'is-down';
    }
    setChip($('deltaChip'), label, cls);

    const big = $('deltaBig');
    if (big) {
      const value = delta === null ? '—' : fmtSigned(delta / 1e8, 0);
      big.innerHTML = `${value}<small>亿元</small>`;
      setTrend(big, delta);
    }
    const pctEl = $('deltaPct');
    if (pctEl) {
      pctEl.textContent = pct === null ? '—' : fmtSignedPct(pct, 1);
      setTrend(pctEl, pct);
    }
  }

  function renderLimits(data) {
    const limits = data.limits || {};
    const up = num(limits.up);
    const down = num(limits.down);
    setText('limitUp', up === null ? '—' : fmtInt(up));
    setText('limitDown', down === null ? '—' : fmtInt(down));
    setText('poolDateLabel', `东方财富口径 · ${shortDate(limits.date || data.tradeDate)}`);
    setText('limitRatio', up === null || down === null ? '—' : `${fmtInt(up)} : ${fmtInt(down)}`);

    const borderRed = document.querySelector('.limit-border .red');
    const borderGreen = document.querySelector('.limit-border .green');
    const total = (up || 0) + (down || 0);
    if (borderRed && borderGreen) {
      const redWidth = total > 0 ? ((up || 0) / total) * 100 : 50;
      const greenWidth = total > 0 ? ((down || 0) / total) * 100 : 50;
      borderRed.style.width = `${redWidth}%`;
      borderGreen.style.width = `${greenWidth}%`;
    }
  }

  function renderStructure(data) {
    const t = data.turnover || {};
    setText('structTotal', fmtInt((num(t.currentSh) || 0) / 1e8 + (num(t.currentSz) || 0) / 1e8));
    setText('structSh', amountYi(t.currentSh));
    setText('structSz', amountYi(t.currentSz));

    const total = (num(t.currentSh) || 0) + (num(t.currentSz) || 0);
    const shPct = total > 0 ? ((num(t.currentSh) || 0) / total) * 100 : 50;
    const szPct = total > 0 ? ((num(t.currentSz) || 0) / total) * 100 : 50;
    setText('structShPct', `${nf1.format(shPct)}%`);
    setText('structSzPct', `${nf1.format(szPct)}%`);
    const shBar = $('structShBar');
    const szBar = $('structSzBar');
    if (shBar) shBar.style.width = `${shPct}%`;
    if (szBar) szBar.style.width = `${szPct}%`;

    const shDelta = num(t.currentSh) !== null && num(t.prevSameTimeSh) !== null
      ? t.currentSh - t.prevSameTimeSh
      : null;
    const szDelta = num(t.currentSz) !== null && num(t.prevSameTimeSz) !== null
      ? t.currentSz - t.prevSameTimeSz
      : null;
    const shDeltaPct = shDelta !== null && num(t.prevSameTimeSh)
      ? (shDelta / t.prevSameTimeSh) * 100
      : null;
    const szDeltaPct = szDelta !== null && num(t.prevSameTimeSz)
      ? (szDelta / t.prevSameTimeSz) * 100
      : null;

    const structDeltaEl = $('structDelta');
    if (structDeltaEl) {
      structDeltaEl.textContent = amountDelta(t.delta);
      setTrend(structDeltaEl, t.delta);
    }
    const shDeltaEl = $('structShDelta');
    if (shDeltaEl) {
      shDeltaEl.textContent = amountDelta(shDelta);
      setTrend(shDeltaEl, shDelta);
    }
    const szDeltaEl = $('structSzDelta');
    if (szDeltaEl) {
      szDeltaEl.textContent = amountDelta(szDelta);
      setTrend(szDeltaEl, szDelta);
    }
    const shDeltaPctEl = $('structShDeltaPct');
    if (shDeltaPctEl) {
      shDeltaPctEl.textContent = fmtSignedPct(shDeltaPct, 1);
      setTrend(shDeltaPctEl, shDeltaPct);
    }
    const szDeltaPctEl = $('structSzDeltaPct');
    if (szDeltaPctEl) {
      szDeltaPctEl.textContent = fmtSignedPct(szDeltaPct, 1);
      setTrend(szDeltaPctEl, szDeltaPct);
    }

    setText('prevFullDate', data.prevTradeDateLabel || '—');
    setText('prevFull', num(t.prevFull) === null ? '—' : fmtInt(t.prevFull / 1e8));
    setText('prevFullSh', amountYi(t.prevFullSh));
    setText('prevFullSz', amountYi(t.prevFullSz));

    setText('legendToday', shortDate(data.tradeDate));
    setText('legendPrev', shortDate(data.prevTradeDate));
    setText('todayTotalFoot', amountShort(t.current));
    setText('prevSameFoot', amountShort(t.prevSameTime));
    const deltaFoot = $('deltaFoot');
    if (deltaFoot) {
      deltaFoot.textContent = amountDelta(t.delta);
      setTrend(deltaFoot, t.delta);
    }
  }

  /* ---------- Sector heatmap ---------- */

  function sectorColor(changePct, maxAbs) {
    if (Math.abs(changePct) < 0.005) return 'rgb(42, 49, 59)';
    const t = Math.min(1, Math.pow(Math.abs(changePct) / Math.max(3, maxAbs), 0.78));
    if (changePct > 0) {
      const red = Math.round(43 + 147 * t);
      const green = Math.round(25 + 33 * t);
      const blue = Math.round(29 + 25 * t);
      return `rgb(${red}, ${green}, ${blue})`;
    }
    const red = Math.round(18 + 8 * t);
    const green = Math.round(42 + 95 * t);
    const blue = Math.round(35 + 67 * t);
    return `rgb(${red}, ${green}, ${blue})`;
  }

  function worstAspect(row, side) {
    if (!row.length) return Infinity;
    const total = row.reduce((sum, node) => sum + node.area, 0);
    const maxArea = Math.max(...row.map((node) => node.area));
    const minArea = Math.min(...row.map((node) => node.area));
    const side2 = side * side;
    return Math.max(
      (side2 * maxArea) / (total * total),
      (total * total) / (side2 * minArea)
    );
  }

  function squarify(nodes, width, height) {
    const rects = [];
    let remaining = nodes.slice();
    let x = 0;
    let y = 0;
    let w = width;
    let h = height;

    while (remaining.length) {
      const side = Math.min(w, h);
      const row = [];
      let previousWorst = Infinity;
      let index = 0;
      while (index < remaining.length) {
        const candidate = [...row, remaining[index]];
        const candidateWorst = worstAspect(candidate, side);
        if (row.length === 0 || candidateWorst <= previousWorst) {
          row.push(remaining[index]);
          previousWorst = candidateWorst;
          index += 1;
        } else {
          break;
        }
      }
      if (!row.length) {
        row.push(remaining[0]);
        index = 1;
      }

      const rowArea = row.reduce((sum, node) => sum + node.area, 0);
      if (w >= h) {
        const rowWidth = rowArea / h;
        let offsetY = y;
        row.forEach((node) => {
          const nodeHeight = node.area / rowWidth;
          rects.push({ item: node.item, x, y: offsetY, w: rowWidth, h: nodeHeight });
          offsetY += nodeHeight;
        });
        x += rowWidth;
        w -= rowWidth;
      } else {
        const rowHeight = rowArea / w;
        let offsetX = x;
        row.forEach((node) => {
          const nodeWidth = node.area / rowHeight;
          rects.push({ item: node.item, x: offsetX, y, w: nodeWidth, h: rowHeight });
          offsetX += nodeWidth;
        });
        y += rowHeight;
        h -= rowHeight;
      }
      remaining = remaining.slice(row.length);
    }
    return rects;
  }

  function syncSectorTileState() {
    const map = $('sectorMap');
    if (!map) return;
    map.querySelectorAll('.sector-tile').forEach((tile) => {
      tile.classList.toggle('is-selected', tile.dataset.code === sectorState.selectedCode);
      tile.classList.toggle('is-hovered', tile.dataset.code === sectorState.hoveredCode);
    });
  }

  function updateSectorDetail(code) {
    const item = sectorState.items.find((entry) => entry.code === code);
    if (!item) {
      setText('sectorDetailName', '悬停 / 点击方块查看');
      setText('sectorDetailPct', '—');
      setText('sectorDetailMeta', '');
      setText('sectorDetailLeader', '');
      return;
    }
    const pctEl = $('sectorDetailPct');
    setText('sectorDetailName', item.group ? `${item.group} · ${item.name}` : item.name);
    if (pctEl) {
      pctEl.textContent = fmtSignedPct(item.changePct, 2);
      setTrend(pctEl, item.changePct);
    }
    setText(
      'sectorDetailMeta',
      `总市值 ${amountShort(item.marketCap)} · 成交额 ${amountShort(item.turnover)} · ${item.up} 涨 / ${item.down} 跌`
    );
    setText(
      'sectorDetailLeader',
      item.leader
        ? `领涨 ${item.leader} ${fmtSignedPct(item.leaderChangePct, 2)}`
        : '领涨股 —'
    );
  }

  function setSectorHover(code) {
    sectorState.hoveredCode = code;
    syncSectorTileState();
    updateSectorDetail(code || sectorState.selectedCode);
  }

  function selectSector(code) {
    if (!sectorState.items.some((item) => item.code === code)) return;
    sectorState.selectedCode = code;
    sectorState.hoveredCode = null;
    syncSectorTileState();
    updateSectorDetail(code);
  }

  function drawSectorMap() {
    const map = $('sectorMap');
    if (!map || !sectorState.items.length) return;
    const width = map.clientWidth;
    const height = map.clientHeight;
    if (width < 12 || height < 12) return;
    sectorState.lastWidth = width;
    sectorState.lastHeight = height;

    const totalCap = sectorState.items.reduce(
      (sum, item) => sum + Math.max(0, item.marketCap),
      0
    );
    if (!totalCap) return;
    const scale = (width * height) / totalCap;
    const nodes = sectorState.items
      .map((item) => ({ item, area: Math.max(0.01, item.marketCap * scale) }))
      .sort((a, b) => b.area - a.area);
    const rects = squarify(nodes, width, height);

    const fragment = document.createDocumentFragment();
    rects.forEach(({ item, x, y, w, h }) => {
      const minSide = Math.min(w, h);
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'sector-tile';
      tile.dataset.code = item.code;
      tile.style.left = `${x + 1}px`;
      tile.style.top = `${y + 1}px`;
      tile.style.width = `${Math.max(1, w - 2)}px`;
      tile.style.height = `${Math.max(1, h - 2)}px`;
      tile.style.background = sectorColor(item.changePct, sectorState.maxAbs);
      if (minSide >= 70 && w >= 105 && h >= 64) {
        tile.classList.add('size-large');
      } else if (minSide < 28) {
        tile.classList.add('size-tiny');
      } else if (minSide < 46) {
        tile.classList.add('size-small');
      }
      if (w < 30 || h < 25) tile.classList.add('is-name-hidden');
      if (item.code === sectorState.selectedCode) tile.classList.add('is-selected');
      if (item.code === sectorState.hoveredCode) tile.classList.add('is-hovered');

      const name = document.createElement('span');
      name.className = 'sector-tile-name';
      name.textContent = item.name;
      const pct = document.createElement('span');
      pct.className = 'sector-tile-pct';
      pct.textContent = fmtSignedPct(item.changePct, 2);
      tile.append(name, pct);
      if (item.group && (tile.classList.contains('size-large') || tile.classList.contains('size-small'))) {
        const group = document.createElement('span');
        group.className = 'sector-tile-group';
        group.textContent = item.group;
        tile.insertBefore(group, name);
      }
      tile.setAttribute(
        'aria-label',
        `${item.group ? `${item.group} · ` : ''}${item.name}，涨跌幅 ${fmtSignedPct(item.changePct, 2)}，总市值 ${amountShort(item.marketCap)}，${item.up} 家上涨，${item.down} 家下跌`
      );
      fragment.appendChild(tile);
    });
    map.replaceChildren(fragment);

    if (sectorState.hoveredCode) {
      updateSectorDetail(sectorState.hoveredCode);
    } else {
      updateSectorDetail(sectorState.selectedCode);
    }
  }

  function renderSectorMovers(containerId, items, kind) {
    const container = $(containerId);
    if (!container) return;
    container.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('li');
      empty.className = 'is-empty';
      empty.textContent = kind === 'gainers' ? '暂无上涨行业' : '暂无下跌行业';
      container.appendChild(empty);
      return;
    }
    items.forEach((item, index) => {
      const li = document.createElement('li');
      li.dataset.code = item.code;
      const rank = document.createElement('span');
      rank.className = 'rank';
      rank.textContent = String(index + 1).padStart(2, '0');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = item.group ? `${item.group}·${item.name}` : item.name;
      const pct = document.createElement('b');
      pct.textContent = fmtSignedPct(item.changePct, 2);
      setTrend(pct, item.changePct);
      li.append(rank, name, pct);
      container.appendChild(li);
    });
  }

  function renderSectorAllList(items) {
    const container = $('sectorAllList');
    if (!container) return;
    container.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('li');
      empty.className = 'is-empty';
      empty.textContent = '暂无行业数据';
      container.appendChild(empty);
      return;
    }
    [...items]
      .sort((a, b) => b.changePct - a.changePct)
      .forEach((item) => {
        const li = document.createElement('li');
        li.dataset.code = item.code;
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = item.group ? `${item.group}·${item.name}` : item.name;
        const pct = document.createElement('b');
        pct.textContent = fmtSignedPct(item.changePct, 2);
        setTrend(pct, item.changePct);
        li.append(name, pct);
        container.appendChild(li);
      });
  }

  function resetSectorCard(message = '板块数据暂未更新') {
    sectorState.items = [];
    sectorState.selectedCode = null;
    sectorState.hoveredCode = null;
    const map = $('sectorMap');
    if (map) map.replaceChildren();
    const empty = $('sectorEmpty');
    if (empty) {
      empty.innerHTML = `<span class="chart-loader" aria-hidden="true"></span>${message}`;
      empty.classList.remove('is-hidden');
    }
    setChip($('sectorMood'), '等待行情', 'chip-neutral');
    setText('sectorMoodNote', '等待板块行情');
    setText('sectorWeightedPct', '—');
    const weighted = $('sectorWeightedPct');
    if (weighted) weighted.className = '';
    setText('sectorUpCount', '—');
    setText('sectorDownCount', '—');
    setText('sectorFlatCount', '—');
    setText('sectorAsOf', '—');
    setText('sectorDetailName', '悬停 / 点击方块查看');
    setText('sectorDetailPct', '—');
    setText('sectorDetailMeta', '');
    setText('sectorDetailLeader', '');
    renderSectorMovers('sectorGainers', [], 'gainers');
    renderSectorMovers('sectorLosers', [], 'losers');
    renderSectorAllList([]);
    setText('sectorAllCount', '— SECTORS');
  }

  /* ---------- 涨跌分布 ---------- */

  function distBarColor(bucket, index, sameDirCount) {
    if (bucket.dir === 'flat') return 'rgba(255, 255, 255, 0.2)';
    const t = sameDirCount > 1 ? index / (sameDirCount - 1) : 0.5;
    const alpha = (0.42 + t * 0.53).toFixed(2);
    return bucket.dir === 'up'
      ? `rgba(255, 88, 82, ${alpha})`
      : `rgba(38, 205, 152, ${alpha})`;
  }

  function resetDistribution(message = '涨跌分布暂未更新') {
    const chart = $('distChart');
    if (chart) chart.replaceChildren();
    const empty = $('distEmpty');
    if (empty) {
      empty.innerHTML = `<span class="chart-loader" aria-hidden="true"></span>${message}`;
      empty.classList.remove('is-hidden');
    }
    setText('distMedian', '—');
    setText('distMean', '—');
    setText('distUp', '—');
    setText('distDown', '—');
  }

  function renderDistribution(data) {
    const dist = data?.distribution;
    if (!dist || !Array.isArray(dist.buckets) || !dist.buckets.length) {
      resetDistribution();
      return;
    }
    const chart = $('distChart');
    if (!chart) return;
    const maxCount = Math.max(1, dist.maxCount || 1);

    // 同一方向的柱子按「离零点越远颜色越深」着色
    const upIndexes = new Map();
    const downIndexes = new Map();
    const upTotal = dist.buckets.filter((b) => b.dir === 'up').length;
    const downTotal = dist.buckets.filter((b) => b.dir === 'down').length;
    let upSeen = 0;
    let downSeen = 0;
    dist.buckets.forEach((bucket) => {
      if (bucket.dir === 'up') upIndexes.set(bucket.label, upSeen++);
      if (bucket.dir === 'down') downIndexes.set(bucket.label, downTotal - 1 - downSeen++);
    });

    const fragment = document.createDocumentFragment();
    dist.buckets.forEach((bucket) => {
      const col = document.createElement('div');
      col.className = 'dist-col';
      col.title = `${bucket.label}：${bucket.count} 只（${bucket.pct}%）`;

      const count = document.createElement('span');
      count.className = 'dist-count';
      const countValue = document.createElement('b');
      countValue.textContent = nf0.format(bucket.count);
      const countPct = document.createElement('em');
      countPct.textContent = `${bucket.pct}%`;
      count.append(countValue, countPct);

      const area = document.createElement('div');
      area.className = 'dist-bar-area';
      const bar = document.createElement('div');
      bar.className = 'dist-bar';
      bar.style.height = `${Math.max(1.5, (bucket.count / maxCount) * 100)}%`;
      bar.style.background = distBarColor(
        bucket,
        bucket.dir === 'up' ? upIndexes.get(bucket.label) : downIndexes.get(bucket.label),
        bucket.dir === 'up' ? upTotal : downTotal
      );
      area.appendChild(bar);

      const label = document.createElement('span');
      label.className = 'dist-label';
      label.textContent = bucket.label;

      col.append(count, area, label);
      fragment.appendChild(col);
    });
    chart.replaceChildren(fragment);

    setText('distMedian', dist.medianLabel || '—');
    setText('distMean', fmtSignedPct(dist.meanPct, 2));
    const meanEl = $('distMean');
    if (meanEl) setTrend(meanEl, dist.meanPct);
    setText('distUp', fmtInt(dist.upCount));
    setText('distDown', fmtInt(dist.downCount));

    const empty = $('distEmpty');
    if (empty) empty.classList.add('is-hidden');
  }

  function renderSectors(data) {
    const sectors = data?.sectors;
    if (!sectors || !Array.isArray(sectors.items) || !sectors.items.length) {
      resetSectorCard();
      return;
    }
    sectorState.items = sectors.items;
    sectorState.maxAbs = Math.max(
      3,
      ...sectors.items.map((item) => Math.abs(item.changePct))
    );
    if (!sectors.items.some((item) => item.code === sectorState.selectedCode)) {
      sectorState.selectedCode = sectors.items[0].code;
    }
    if (!sectors.items.some((item) => item.code === sectorState.hoveredCode)) {
      sectorState.hoveredCode = null;
    }

    setText('sectorUpCount', fmtInt(sectors.upCount));
    setText('sectorDownCount', fmtInt(sectors.downCount));
    setText('sectorFlatCount', fmtInt(sectors.flatCount));
    setText(
      'sectorMoodNote',
      `${fmtInt(sectors.upCount)} 个上涨 · ${fmtInt(sectors.downCount)} 个下跌`
    );
    const weighted = $('sectorWeightedPct');
    if (weighted) {
      weighted.textContent = fmtSignedPct(sectors.weightedChangePct, 2);
      setTrend(weighted, sectors.weightedChangePct);
    }

    let moodLabel = '涨跌分化';
    let moodClass = 'chip-neutral';
    if (sectors.upCount === sectors.items.length) {
      moodLabel = '全线飘红';
      moodClass = 'is-up';
    } else if (sectors.downCount === sectors.items.length) {
      moodLabel = '全线飘绿';
      moodClass = 'is-down';
    } else if (sectors.upCount > sectors.downCount * 1.5) {
      moodLabel = '红盘占优';
      moodClass = 'is-up';
    } else if (sectors.downCount > sectors.upCount * 1.5) {
      moodLabel = '绿盘占优';
      moodClass = 'is-down';
    }
    setChip($('sectorMood'), moodLabel, moodClass);

    const gainers = sectors.items
      .filter((item) => item.changePct > 0)
      .sort((a, b) => b.changePct - a.changePct)
      .slice(0, 3);
    const losers = sectors.items
      .filter((item) => item.changePct < 0)
      .sort((a, b) => a.changePct - b.changePct)
      .slice(0, 3);
    renderSectorMovers('sectorGainers', gainers, 'gainers');
    renderSectorMovers('sectorLosers', losers, 'losers');
    renderSectorAllList(sectors.items);
    setText('sectorAllCount', `${sectors.items.length} SECTORS`);
    setText('sectorAsOf', asOfClock(data.asOf));

    const empty = $('sectorEmpty');
    if (empty) empty.classList.add('is-hidden');
    drawSectorMap();
  }

  function initSectorHeatmap() {
    const map = $('sectorMap');
    if (!map) return;

    map.addEventListener('pointerover', (event) => {
      const tile = event.target.closest('.sector-tile');
      if (!tile || !map.contains(tile)) return;
      setSectorHover(tile.dataset.code);
    });
    map.addEventListener('pointerleave', () => {
      setSectorHover(null);
    });
    map.addEventListener('focusin', (event) => {
      const tile = event.target.closest('.sector-tile');
      if (tile) setSectorHover(tile.dataset.code);
    });
    map.addEventListener('focusout', (event) => {
      if (!map.contains(event.relatedTarget)) setSectorHover(null);
    });
    map.addEventListener('click', (event) => {
      const tile = event.target.closest('.sector-tile');
      if (tile) selectSector(tile.dataset.code);
    });

    document.querySelectorAll('.sector-movers-list, .sector-all-list').forEach((list) => {
      list.addEventListener('click', (event) => {
        const item = event.target.closest('li[data-code]');
        if (item) selectSector(item.dataset.code);
      });
      list.addEventListener('pointerover', (event) => {
        const item = event.target.closest('li[data-code]');
        if (item) setSectorHover(item.dataset.code);
      });
      list.addEventListener('pointerleave', () => {
        setSectorHover(null);
      });
    });

    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(() => {
        if (!sectorState.items.length) return;
        const width = map.clientWidth;
        const height = map.clientHeight;
        if (Math.abs(width - sectorState.lastWidth) < 1 && Math.abs(height - sectorState.lastHeight) < 1) {
          return;
        }
        if (sectorState.resizeFrame) cancelAnimationFrame(sectorState.resizeFrame);
        sectorState.resizeFrame = requestAnimationFrame(() => {
          sectorState.resizeFrame = 0;
          drawSectorMap();
        });
      });
      observer.observe(map);
    }
  }

  /* ---------- SVG chart primitives ---------- */

  const SVG_NS = 'http://www.w3.org/2000/svg';

  function svgEl(tag, attrs = {}) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value !== null && value !== undefined) node.setAttribute(key, String(value));
    }
    return node;
  }

  function addSvg(parent, tag, attrs = {}, text = null) {
    const node = svgEl(tag, attrs);
    if (text !== null) node.textContent = text;
    parent.appendChild(node);
    return node;
  }

  function chartFrame(svg, width, height, rightGutter = null, prefix = 'chart') {
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.replaceChildren();
    const gutter = rightGutter ?? (width < 460 ? 49 : 59);
    const plot = {
      left: 11,
      right: Math.max(80, width - gutter),
      top: 14,
      bottom: Math.max(50, height - 25),
    };
    const defs = addSvg(svg, 'defs');
    const clipId = `${prefix}-clip`;
    const clip = addSvg(defs, 'clipPath', { id: clipId });
    addSvg(clip, 'rect', {
      x: plot.left,
      y: plot.top,
      width: Math.max(0, plot.right - plot.left),
      height: Math.max(0, plot.bottom - plot.top),
    });
    return { plot, defs, clipId, prefix };
  }

  function xScale(plot, length) {
    const span = Math.max(1, plot.right - plot.left);
    return (index) => plot.left + (index / Math.max(1, length - 1)) * span;
  }

  function yScale(plot, min, max) {
    const span = Math.max(1e-9, max - min);
    return (value) => plot.bottom - ((value - min) / span) * (plot.bottom - plot.top);
  }

  function addYAxis(svg, plot, y, min, max, formatter, count = 4) {
    for (let i = 0; i <= count; i += 1) {
      const value = max - ((max - min) * i) / count;
      const py = y(value);
      addSvg(svg, 'line', {
        x1: plot.left,
        y1: py.toFixed(2),
        x2: plot.right,
        y2: py.toFixed(2),
        class: 'axis-grid',
      });
      addSvg(svg, 'text', {
        x: plot.right + 7,
        y: (py + 3).toFixed(2),
        class: 'axis-text',
        'text-anchor': 'start',
      }, formatter(value));
    }
  }

  function xTickList(width) {
    if (width < 570) {
      return [
        { i: 0, label: '09:30', anchor: 'start' },
        { i: 120, label: '11:30 / 13:00', anchor: 'middle' },
        { i: 240, label: '15:00', anchor: 'end' },
      ];
    }
    return [
      { i: 0, label: '09:30', anchor: 'start' },
      { i: 60, label: '10:30', anchor: 'middle' },
      { i: 120, label: '11:30 / 13:00', anchor: 'middle' },
      { i: 180, label: '14:00', anchor: 'middle' },
      { i: 240, label: '15:00', anchor: 'end' },
    ];
  }

  function addXAxis(svg, plot, x, width, height) {
    const ticks = xTickList(width);
    ticks.forEach((tick) => {
      addSvg(svg, 'line', {
        x1: x(tick.i).toFixed(2),
        y1: plot.top,
        x2: x(tick.i).toFixed(2),
        y2: plot.bottom,
        class: 'axis-grid',
        'stroke-opacity': '0.48',
      });
      addSvg(svg, 'text', {
        x: x(tick.i).toFixed(2),
        y: height - 8,
        class: 'axis-text',
        'text-anchor': tick.anchor,
      }, tick.label);
    });
    addSvg(svg, 'line', {
      x1: plot.left,
      y1: plot.bottom,
      x2: plot.right,
      y2: plot.bottom,
      class: 'axis-base',
    });
  }

  function makeLineGradient(defs, plot, id, color, topOpacity, bottomOpacity) {
    const grad = addSvg(defs, 'linearGradient', {
      id,
      gradientUnits: 'userSpaceOnUse',
      x1: 0,
      y1: plot.top,
      x2: 0,
      y2: plot.bottom,
    });
    addSvg(grad, 'stop', { offset: '0%', 'stop-color': color, 'stop-opacity': topOpacity });
    addSvg(grad, 'stop', { offset: '100%', 'stop-color': color, 'stop-opacity': bottomOpacity });
    return `url(#${id})`;
  }

  function pointsFromSeries(series, x, y, maxIndex = series.length - 1) {
    const points = [];
    for (let i = 0; i <= Math.min(maxIndex, series.length - 1); i += 1) {
      const value = series[i];
      if (!Number.isFinite(value)) continue;
      points.push({ i, x: x(i), y: y(value), value });
    }
    return points;
  }

  function linePath(points) {
    if (!points.length) return '';
    return points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ');
  }

  function areaPath(points, baseY) {
    if (!points.length) return '';
    const first = points[0];
    const last = points[points.length - 1];
    const segments = points.map((point) => `L${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ');
    return `M${first.x.toFixed(2)} ${baseY.toFixed(2)} ${segments} L${last.x.toFixed(2)} ${baseY.toFixed(2)} Z`;
  }

  function addCursorLayer(svg, plot) {
    const group = addSvg(svg, 'g', { 'pointer-events': 'none' });
    const line = addSvg(group, 'line', {
      x1: 0, y1: plot.top, x2: 0, y2: plot.bottom,
      class: 'cursor-line', visibility: 'hidden',
    });
    return { group, line };
  }

  function setCursorVisible(item, visible) {
    item.setAttribute('visibility', visible ? 'visible' : 'hidden');
  }

  function formatAxisIndex(value) {
    return fmt(value, 2);
  }

  function formatAxisAmount(value) {
    const v = num(value) || 0;
    if (v === 0) return '0';
    const yi = v / 1e8;
    if (Math.abs(yi) >= 10000) return `${(yi / 10000).toFixed(1)}万亿`;
    if (Math.abs(yi) >= 1000) return `${nf0.format(Math.round(yi))}亿`;
    return `${Math.round(yi)}亿`;
  }

  function formatAxisDelta(value) {
    const v = num(value) || 0;
    const yi = Math.round(v / 1e8);
    const sign = yi > 0 ? '+' : yi < 0 ? '−' : '';
    return sign + nf0.format(Math.abs(yi));
  }

  function tipValueClass(value) {
    return trendClass(value);
  }

  /* ---------- Index chart ---------- */

  function drawIndexChart(svg, data, width, height) {
    const times = data.series?.times || [];
    const values = data.series?.index || [];
    const latest = Math.min(data.series?.latestIndex ?? 0, times.length - 1);
    const preClose = num(data.index?.preClose);
    if (!times.length || latest < 0 || !preClose) return null;

    const observed = values.slice(0, latest + 1).filter((v) => Number.isFinite(v));
    if (!observed.length) return null;

    const frame = chartFrame(svg, width, height, null, 'index');
    const { plot, defs } = frame;
    const x = xScale(plot, times.length);
    let maxDev = Math.max(...observed.map((v) => Math.abs(v - preClose)), preClose * 0.0015);
    const pad = maxDev * 1.18;
    const min = preClose - pad;
    const max = preClose + pad;
    const y = yScale(plot, min, max);

    addYAxis(svg, plot, y, min, max, formatAxisIndex);
    addXAxis(svg, plot, x, width, height);

    const seriesPoints = pointsFromSeries(values, x, y, latest);
    if (!seriesPoints.length) return null;

    const negative = (num(data.index?.changePct) || 0) < 0;
    const fillColor = negative ? '#2ed6a1' : '#ff625d';
    const fillUrl = makeLineGradient(defs, plot, 'index-area', fillColor, 0.17, 0.008);
    addSvg(svg, 'path', {
      d: areaPath(seriesPoints, plot.bottom),
      fill: fillUrl,
      'clip-path': `url(#${frame.clipId})`,
    });

    addSvg(svg, 'path', {
      d: linePath(seriesPoints),
      class: 'chart-line index',
      'clip-path': `url(#${frame.clipId})`,
    });

    const yPre = y(preClose);
    addSvg(svg, 'line', {
      x1: plot.left,
      y1: yPre.toFixed(2),
      x2: plot.right,
      y2: yPre.toFixed(2),
      class: 'preclose-line',
    });
    addSvg(svg, 'text', {
      x: plot.right - 3,
      y: Math.max(plot.top + 9, yPre - 6).toFixed(2),
      class: 'preclose-text',
      'text-anchor': 'end',
    }, `昨收 ${fmt(preClose, 2)}`);

    const lastPoint = seriesPoints[seriesPoints.length - 1];
    if (data.session?.isTrading) {
      addSvg(svg, 'circle', {
        cx: lastPoint.x.toFixed(2),
        cy: lastPoint.y.toFixed(2),
        r: 4.5,
        fill: '#e8c98a',
        opacity: 0.32,
        class: 'live-halo',
      });
    }
    addSvg(svg, 'circle', {
      cx: lastPoint.x.toFixed(2),
      cy: lastPoint.y.toFixed(2),
      r: 2.8,
      class: 'chart-endpoint index',
    });

    const cursor = addCursorLayer(svg, plot);
    const dot = addSvg(cursor.group, 'circle', {
      cx: 0, cy: 0, r: 3.4, class: 'cursor-dot index', visibility: 'hidden',
    });

    return {
      width,
      height,
      plot,
      maxIndex: latest,
      xForIndex: x,
      tipHTML(index) {
        const value = values[index];
        if (!Number.isFinite(value)) return '';
        const change = value - preClose;
        const pct = (change / preClose) * 100;
        const cur = data.series.currentTurnover?.[index];
        const prev = data.series.previousTurnover?.[index];
        const delta = data.series.turnoverDelta?.[index];
        return `
          <div class="tip-head"><span>${times[index]}</span><span>上证指数</span></div>
          <div class="tip-primary">
            <b>${fmt(value, 2)}</b>
            <span class="${tipValueClass(pct)}">${fmtSigned(change, 2)} · ${fmtSignedPct(pct, 2)}</span>
          </div>
          <div class="tip-grid">
            <span>本交易日累计</span><b>${amountShort(cur)}</b>
            <span>上一交易日同时段</span><b>${amountShort(prev)}</b>
          </div>
          <div class="tip-delta"><span>量能增减</span><b class="${tipValueClass(delta)}">${amountDelta(delta)}</b></div>
        `;
      },
      showCursor(index) {
        const value = values[index];
        const cx = x(index);
        const cy = Number.isFinite(value) ? y(value) : 0;
        cursor.line.setAttribute('x1', cx.toFixed(2));
        cursor.line.setAttribute('x2', cx.toFixed(2));
        dot.setAttribute('cx', cx.toFixed(2));
        dot.setAttribute('cy', cy.toFixed(2));
        setCursorVisible(cursor.line, true);
        setCursorVisible(dot, Number.isFinite(value));
      },
      hideCursor() {
        setCursorVisible(cursor.line, false);
        setCursorVisible(dot, false);
      },
    };
  }

  /* ---------- Delta chart ---------- */

  function drawDeltaChart(svg, data, width, height) {
    const times = data.series?.times || [];
    const current = data.series?.currentTurnover || [];
    const previous = data.series?.previousTurnover || [];
    const deltas = data.series?.turnoverDelta || [];
    const latest = Math.min(data.series?.latestIndex ?? 0, times.length - 1);
    const observed = deltas.slice(0, latest + 1).filter((v) => Number.isFinite(v));
    if (!times.length || !observed.length) return null;

    const lo = Math.min(0, ...observed);
    const hi = Math.max(0, ...observed);
    const spread = Math.max(hi - lo, 1e8);
    const min = lo - (lo < 0 ? spread * 0.09 : 0);
    const max = hi + (hi > 0 ? spread * 0.09 : 0);
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;

    const frame = chartFrame(svg, width, height, null, 'delta');
    const { plot, defs } = frame;
    const x = xScale(plot, times.length);
    const y = yScale(plot, min, max);
    const yZero = y(0);

    addYAxis(svg, plot, y, min, max, formatAxisDelta);
    addXAxis(svg, plot, x, width, height);

    const points = pointsFromSeries(deltas, x, y, latest);
    if (!points.length) return null;

    const area = areaPath(points, yZero);
    const positiveClip = addSvg(defs, 'clipPath', { id: 'delta-positive' });
    addSvg(positiveClip, 'rect', {
      x: plot.left, y: plot.top,
      width: plot.right - plot.left, height: Math.max(0, yZero - plot.top),
    });
    const negativeClip = addSvg(defs, 'clipPath', { id: 'delta-negative' });
    addSvg(negativeClip, 'rect', {
      x: plot.left, y: yZero,
      width: plot.right - plot.left, height: Math.max(0, plot.bottom - yZero),
    });

    const posFill = makeLineGradient(defs, { top: plot.top, bottom: yZero }, 'delta-pos-fill', '#ff625d', 0.26, 0.03);
    const negFill = makeLineGradient(defs, { top: yZero, bottom: plot.bottom }, 'delta-neg-fill', '#2ed6a1', 0.22, 0.025);

    addSvg(svg, 'path', {
      d: area, fill: posFill, 'clip-path': 'url(#delta-positive)',
    });
    addSvg(svg, 'path', {
      d: area, fill: negFill, 'clip-path': 'url(#delta-negative)',
    });

    const lineD = linePath(points);
    addSvg(svg, 'path', {
      d: lineD, class: 'chart-line positive',
      'clip-path': 'url(#delta-positive)',
    });
    addSvg(svg, 'path', {
      d: lineD, class: 'chart-line negative',
      'clip-path': 'url(#delta-negative)',
    });

    addSvg(svg, 'line', {
      x1: plot.left,
      y1: yZero.toFixed(2),
      x2: plot.right,
      y2: yZero.toFixed(2),
      class: 'axis-zero',
    });

    const lastPoint = points[points.length - 1];
    const lastDelta = observed[observed.length - 1];
    const endColor = lastDelta >= 0 ? '#ff625d' : '#2ed6a1';
    if (data.session?.isTrading) {
      addSvg(svg, 'circle', {
        cx: lastPoint.x.toFixed(2),
        cy: lastPoint.y.toFixed(2),
        r: 4.5,
        fill: endColor,
        opacity: 0.28,
        class: 'live-halo',
      });
    }
    addSvg(svg, 'circle', {
      cx: lastPoint.x.toFixed(2), cy: lastPoint.y.toFixed(2), r: 2.8,
      fill: endColor, stroke: '#0b1018', 'stroke-width': 1.5,
    });

    const cursor = addCursorLayer(svg, plot);
    const dot = addSvg(cursor.group, 'circle', {
      cx: 0, cy: 0, r: 3.4, class: 'cursor-dot', visibility: 'hidden',
    });

    return {
      width,
      height,
      plot,
      maxIndex: latest,
      xForIndex: x,
      tipHTML(index) {
        const delta = deltas[index];
        if (!Number.isFinite(delta)) return '';
        return `
          <div class="tip-head"><span>${times[index]}</span><span>较昨日同时段</span></div>
          <div class="tip-primary">
            <b class="${tipValueClass(delta)}">${fmtSigned(delta / 1e8, 0)}</b>
            <span class="is-neutral">亿元</span>
          </div>
          <div class="tip-grid">
            <span>本交易日累计</span><b>${amountShort(current[index])}</b>
            <span>上一交易日同时段</span><b>${amountShort(previous[index])}</b>
          </div>
          <div class="tip-delta"><span>变化幅度</span><b class="${tipValueClass(delta)}">${previous[index] ? fmtSignedPct((delta / previous[index]) * 100, 1) : '—'}</b></div>
        `;
      },
      showCursor(index) {
        const delta = deltas[index];
        const cx = x(index);
        const cy = Number.isFinite(delta) ? y(delta) : 0;
        cursor.line.setAttribute('x1', cx.toFixed(2));
        cursor.line.setAttribute('x2', cx.toFixed(2));
        dot.setAttribute('cx', cx.toFixed(2));
        dot.setAttribute('cy', cy.toFixed(2));
        dot.setAttribute('fill', delta >= 0 ? '#ff625d' : '#2ed6a1');
        setCursorVisible(cursor.line, true);
        setCursorVisible(dot, Number.isFinite(delta));
      },
      hideCursor() {
        setCursorVisible(cursor.line, false);
        setCursorVisible(dot, false);
      },
    };
  }

  /* ---------- Turnover chart ---------- */

  function drawTurnoverChart(svg, data, width, height) {
    const times = data.series?.times || [];
    const current = data.series?.currentTurnover || [];
    const previous = data.series?.previousTurnover || [];
    const latest = Math.min(data.series?.latestIndex ?? 0, times.length - 1);
    const observedCur = current.slice(0, latest + 1).filter((v) => Number.isFinite(v));
    const observedPrev = previous.filter((v) => Number.isFinite(v));
    const all = [...observedCur, ...observedPrev];
    if (!times.length || !all.length) return null;

    const max = Math.max(...all, 1) * 1.07;
    const min = 0;
    const frame = chartFrame(svg, width, height, null, 'turnover');
    const { plot, defs } = frame;
    const x = xScale(plot, times.length);
    const y = yScale(plot, min, max);

    addYAxis(svg, plot, y, min, max, formatAxisAmount);
    addXAxis(svg, plot, x, width, height);

    const curPoints = pointsFromSeries(current, x, y, latest);
    const prevPoints = pointsFromSeries(previous, x, y, previous.length - 1);

    if (curPoints.length) {
      const fillUrl = makeLineGradient(defs, plot, 'turnover-area', '#e8c98a', 0.16, 0.008);
      addSvg(svg, 'path', {
        d: areaPath(curPoints, plot.bottom),
        fill: fillUrl,
        'clip-path': `url(#${frame.clipId})`,
      });
    }

    if (prevPoints.length) {
      addSvg(svg, 'path', {
        d: linePath(prevPoints),
        class: 'chart-line previous',
      });
      const lastPrev = prevPoints[prevPoints.length - 1];
      addSvg(svg, 'circle', {
        cx: lastPrev.x.toFixed(2), cy: lastPrev.y.toFixed(2), r: 2.2,
        class: 'chart-endpoint previous',
      });
    }

    if (curPoints.length) {
      addSvg(svg, 'path', {
        d: linePath(curPoints),
        class: 'chart-line current',
        'clip-path': `url(#${frame.clipId})`,
      });
      const lastCur = curPoints[curPoints.length - 1];
      if (data.session?.isTrading) {
        addSvg(svg, 'circle', {
          cx: lastCur.x.toFixed(2), cy: lastCur.y.toFixed(2), r: 4.5,
          fill: '#e8c98a', opacity: 0.28, class: 'live-halo',
        });
      }
      addSvg(svg, 'circle', {
        cx: lastCur.x.toFixed(2), cy: lastCur.y.toFixed(2), r: 2.8,
        class: 'chart-endpoint current',
      });
    }

    const cursor = addCursorLayer(svg, plot);
    const dotCur = addSvg(cursor.group, 'circle', {
      cx: 0, cy: 0, r: 3.4, class: 'cursor-dot current', visibility: 'hidden',
    });
    const dotPrev = addSvg(cursor.group, 'circle', {
      cx: 0, cy: 0, r: 3.2, class: 'cursor-dot previous', visibility: 'hidden',
    });

    return {
      width,
      height,
      plot,
      maxIndex: latest,
      xForIndex: x,
      tipHTML(index) {
        const curVal = current[index];
        const prevVal = previous[index];
        if (!Number.isFinite(curVal) && !Number.isFinite(prevVal)) return '';
        const delta = Number.isFinite(curVal) && Number.isFinite(prevVal) ? curVal - prevVal : null;
        return `
          <div class="tip-head"><span>${times[index]}</span><span>累计成交额</span></div>
          <div class="tip-primary">
            <b>${amountShort(curVal)}</b>
            <span class="is-neutral">本交易日</span>
          </div>
          <div class="tip-grid">
            <span>上一交易日同时段</span><b>${amountShort(prevVal)}</b>
            <span>较上一交易日</span><b class="${tipValueClass(delta)}">${delta !== null && prevVal ? fmtSignedPct((delta / prevVal) * 100, 1) : '—'}</b>
          </div>
          <div class="tip-delta"><span>量能增减</span><b class="${tipValueClass(delta)}">${amountDelta(delta)}</b></div>
        `;
      },
      showCursor(index) {
        const cx = x(index);
        cursor.line.setAttribute('x1', cx.toFixed(2));
        cursor.line.setAttribute('x2', cx.toFixed(2));
        const curVal = current[index];
        const prevVal = previous[index];
        if (Number.isFinite(curVal)) {
          dotCur.setAttribute('cx', cx.toFixed(2));
          dotCur.setAttribute('cy', y(curVal).toFixed(2));
        }
        if (Number.isFinite(prevVal)) {
          dotPrev.setAttribute('cx', cx.toFixed(2));
          dotPrev.setAttribute('cy', y(prevVal).toFixed(2));
        }
        setCursorVisible(cursor.line, true);
        setCursorVisible(dotCur, Number.isFinite(curVal));
        setCursorVisible(dotPrev, Number.isFinite(prevVal));
      },
      hideCursor() {
        setCursorVisible(cursor.line, false);
        setCursorVisible(dotCur, false);
        setCursorVisible(dotPrev, false);
      },
    };
  }

  /* ---------- Chart pointer controller ---------- */

  function mountChart(shell, tip, empty, draw) {
    const svg = shell.querySelector('svg');
    if (!svg) return { update() {} };

    let geometry = null;
    let data = null;
    let active = null;
    let dragging = false;
    let pointerId = null;
    let lastWidth = 0;
    let lastHeight = 0;

    const setEmpty = (message) => {
      empty.innerHTML = message;
      empty.classList.remove('is-hidden');
    };

    const hideEmpty = () => empty.classList.add('is-hidden');

    function hideTip() {
      tip.classList.remove('visible');
      if (geometry) geometry.hideCursor();
      active = null;
    }

    function positionTip(index) {
      if (!geometry) return;
      const html = geometry.tipHTML(index);
      if (!html) {
        hideTip();
        return;
      }
      tip.innerHTML = html;
      tip.classList.add('visible');
      const x = geometry.xForIndex(index);
      const shellWidth = shell.clientWidth;
      const tipWidth = tip.offsetWidth;
      let left = x + 14;
      if (left + tipWidth > shellWidth - 8) left = x - tipWidth - 14;
      left = Math.max(8, Math.min(left, shellWidth - tipWidth - 8));
      tip.style.left = `${left}px`;
      tip.style.top = '10px';
    }

    function showAt(index) {
      if (!geometry) return;
      const clamped = Math.max(0, Math.min(index, geometry.maxIndex));
      active = clamped;
      geometry.showCursor(clamped);
      positionTip(clamped);
    }

    function indexFromEvent(event) {
      if (!geometry) return 0;
      const rect = shell.getBoundingClientRect();
      const localX = event.clientX - rect.left;
      const ratio = (localX - geometry.plot.left) / Math.max(1, geometry.plot.right - geometry.plot.left);
      const span = Math.max(1, (data?.series?.times?.length || 241) - 1);
      return Math.round(Math.max(0, Math.min(1, ratio)) * span);
    }

    function render() {
      if (!data) return;
      const width = shell.clientWidth;
      const height = shell.clientHeight;
      if (width < 60 || height < 60) return;
      try {
        const result = draw(svg, data, width, height);
        lastWidth = width;
        lastHeight = height;
        if (!result) {
          hideTip();
          setEmpty('暂无可绘制的行情数据');
          geometry = null;
          return;
        }
        geometry = result;
        hideEmpty();
        if (active !== null) {
          showAt(Math.min(active, geometry.maxIndex));
        } else if (geometry) {
          geometry.hideCursor();
        }
      } catch (error) {
        console.error('图表面板渲染失败', error);
        geometry = null;
        hideTip();
        setEmpty('图表暂时无法绘制');
      }
    }

    shell.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      dragging = true;
      pointerId = event.pointerId;
      shell.classList.add('is-dragging');
      try {
        shell.setPointerCapture(event.pointerId);
      } catch (error) {
        /* 某些浏览器在触摸时不允许捕获，不影响查看。 */
      }
      showAt(indexFromEvent(event));
    });

    shell.addEventListener('pointermove', (event) => {
      if (event.pointerType !== 'mouse' && !dragging) return;
      if (dragging && pointerId !== null && event.pointerId !== pointerId) return;
      showAt(indexFromEvent(event));
    });

    const release = (event) => {
      if (!dragging) return;
      dragging = false;
      shell.classList.remove('is-dragging');
      if (pointerId !== null && shell.hasPointerCapture?.(pointerId)) {
        try {
          shell.releasePointerCapture(pointerId);
        } catch (error) {
          /* noop */
        }
      }
      pointerId = null;
    };

    shell.addEventListener('pointerup', release);
    shell.addEventListener('pointercancel', () => {
      dragging = false;
      shell.classList.remove('is-dragging');
      pointerId = null;
      hideTip();
    });
    shell.addEventListener('pointerleave', (event) => {
      if (!dragging && event.pointerType === 'mouse') hideTip();
    });

    const observer = new ResizeObserver(() => {
      if (!data) return;
      const width = shell.clientWidth;
      const height = shell.clientHeight;
      if (Math.abs(width - lastWidth) < 1 && Math.abs(height - lastHeight) < 1) return;
      render();
    });
    observer.observe(shell);

    return {
      update(nextData) {
        data = nextData;
        render();
      },
    };
  }

  /* ---------- Data flow ---------- */

  function hideNotice() {
    const notice = $('notice');
    if (!notice) return;
    notice.hidden = true;
  }

  function showNotice(message, kind = 'warning', retry = true) {
    const notice = $('notice');
    if (!notice) return;
    notice.hidden = false;
    notice.dataset.kind = kind;
    setText('noticeText', message);
    const btn = $('noticeRetry');
    if (btn) btn.hidden = !retry;
  }

  function noticeForData(data) {
    if (data.stale) {
      const time = asOfClock(data.asOf);
      showNotice(`行情源暂时异常，已保留 ${time} 的上次成功数据，正在自动重试。`, 'warning', true);
      return;
    }
    const warnings = Array.isArray(data.warnings) ? data.warnings.filter(Boolean) : [];
    if (warnings.length) {
      showNotice(`${warnings[0]}，其余行情正常。`, 'warning', true);
      return;
    }
    hideNotice();
  }

  function renderAll(data) {
    renderHeader(data);
    renderBreadth(data);
    renderTurnover(data);
    renderDelta(data);
    renderLimits(data);
    renderStructure(data);
    renderDistribution(data);
    renderSectors(data);
    charts.index?.update(data);
    charts.delta?.update(data);
    charts.turnover?.update(data);
    noticeForData(data);
  }

  async function fetchData(manual = false) {
    if (state.loading) return;
    state.loading = true;
    const refreshBtn = $('refreshBtn');
    if (refreshBtn) {
      refreshBtn.disabled = true;
      refreshBtn.classList.add('is-loading');
      refreshBtn.setAttribute('aria-label', '正在刷新行情');
    }
    if (manual && state.data) {
      hideNotice();
    }
    updateRefreshUi();

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 14000);
    let failureMessage = '暂时无法获取行情数据';
    try {
      const response = await fetch(`/api/dashboard?t=${Date.now()}`, {
        cache: 'no-store',
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch (error) {
        throw new Error('行情服务返回了无法解析的数据');
      }
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || '行情服务暂时不可用');
      }
      state.data = payload;
      state.failures = 0;
      state.lastSuccessAt = Date.now();
      renderAll(payload);
    } catch (error) {
      state.failures += 1;
      if (error?.name === 'AbortError') {
        failureMessage = '行情请求超时，正在自动重试';
      } else if (!navigator.onLine) {
        failureMessage = '网络已断开，正在等待恢复';
      } else {
        failureMessage = `${failureMessage}（${error?.message || '连接失败'}）`;
      }
      if (state.data) {
        showNotice(`${failureMessage}，已保留上次成功数据。`, 'error', true);
      } else {
        showNotice(failureMessage, 'error', true);
      }
    } finally {
      window.clearTimeout(timeout);
      state.loading = false;
      if (refreshBtn) {
        refreshBtn.disabled = false;
        refreshBtn.classList.remove('is-loading');
        refreshBtn.setAttribute('aria-label', '立即刷新行情');
      }
      state.nextRefreshAt = Date.now() + REFRESH_MS;
      updateRefreshUi();
    }
  }

  function updateRefreshUi() {
    const countdown = $('countdown');
    const label = $('refreshLabel');
    if (!countdown) return;
    if (state.loading) {
      countdown.textContent = '刷新中';
      if (label) label.textContent = '行情刷新';
      return;
    }
    if (state.paused) {
      countdown.textContent = '已暂停';
      if (label) label.textContent = '自动刷新';
      return;
    }
    if (document.hidden) {
      countdown.textContent = '后台';
      if (label) label.textContent = '自动刷新';
      return;
    }
    const remaining = Math.max(0, Math.ceil((state.nextRefreshAt - Date.now()) / 1000));
    countdown.textContent = state.data ? `${remaining}s 后刷新` : '连接中';
    if (label) label.textContent = '自动刷新';
  }

  function tick() {
    updateRefreshUi();
    if (
      !state.paused &&
      !state.loading &&
      !document.hidden &&
      state.nextRefreshAt > 0 &&
      Date.now() >= state.nextRefreshAt
    ) {
      fetchData(false);
    }
  }

  function setPaused(paused) {
    state.paused = paused;
    document.body.dataset.paused = String(paused);
    const pauseBtn = $('pauseBtn');
    if (pauseBtn) {
      pauseBtn.setAttribute('aria-pressed', String(paused));
      pauseBtn.setAttribute('aria-label', paused ? '继续自动刷新' : '暂停自动刷新');
    }
    setText('pauseLabel', paused ? '继续' : '暂停');
    if (!paused) {
      state.nextRefreshAt = Date.now();
      if (!state.loading) fetchData(false);
    }
    updateRefreshUi();
  }

  function bindEvents() {
    $('refreshBtn')?.addEventListener('click', () => fetchData(true));
    $('noticeRetry')?.addEventListener('click', () => fetchData(true));
    $('pauseBtn')?.addEventListener('click', () => setPaused(!state.paused));

    document.addEventListener('keydown', (event) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const tag = event.target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || event.target?.isContentEditable) return;
      if (event.key.toLowerCase() === 'r') {
        event.preventDefault();
        fetchData(true);
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !state.paused && !state.loading) {
        if (Date.now() >= state.nextRefreshAt) fetchData(false);
      }
      updateRefreshUi();
    });

    window.addEventListener('online', () => {
      if (!state.paused) fetchData(false);
    });
  }

  function init() {
    document.body.dataset.paused = 'false';
    bindEvents();
    initSectorHeatmap();
    charts.index = mountChart($('indexChart'), $('indexTip'), $('indexChart').querySelector('.chart-empty'), drawIndexChart);
    charts.delta = mountChart($('deltaChart'), $('deltaTip'), $('deltaChart').querySelector('.chart-empty'), drawDeltaChart);
    charts.turnover = mountChart(
      $('turnoverChart'),
      $('turnoverTip'),
      $('turnoverChart').querySelector('.chart-empty'),
      drawTurnoverChart
    );
    updateRefreshUi();
    fetchData(false);
    window.setInterval(tick, 900);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
