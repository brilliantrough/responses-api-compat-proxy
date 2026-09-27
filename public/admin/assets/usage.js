(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var palette = ['#6386ed', '#32ad96', '#a28be0', '#e5b256', '#df849b', '#62b7d4', '#9ea96a', '#8a9bb7', '#c0c9d8'];
  var outcomeNames = { success: '成功', failed: '失败', cancelled: '客户端取消', interrupted: '进程中断', pending: '进行中' };
  var outcomeColors = ['#60c5a5', '#ee8691', '#edc06f', '#ad96df', '#c6cfde'];
  var numeric = ['attempts','success','failed','cancelled','interrupted','pending','usageKnown','cacheKnown','inputKnown','outputKnown','cachedKnown','totalKnown','reasoningKnown','inputTokens','outputTokens','cachedInputTokens','totalTokens','reasoningTokens','cacheEligibleInput','cacheEligibleCached','uncachedInputTokens','unknownCacheInputTokens','durationMs','finished'];
  var data = null, selectedBucket = null, page = 0, sortKey = 'attempts', sortDirection = -1;
  var selected = { channel: null, model: null }, channelNames = new Map(), chartData = {}, tableRows = [];
  var timer, controller, sequence = 0;
  var focusedSegment = null;
  var preferenceKey = 'relay-usage:' + location.host;
  var controls = ['period','date-from','date-to','bucket','timezone','kind','auto-refresh','calls-metric','calls-stack','tokens-metric','tokens-stack','cache-stack'];
  var escape = function (value) { return String(value).replace(/[&<>"']/g, function (c) { return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]; }); };
  var number = function (n) { return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n); };
  var compact = function (n) { return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n); };
  var percent = function (n) { return n === null ? '—' : (n * 100).toFixed(1) + '%'; };
  function empty() { var row = {}; numeric.forEach(function (key) { row[key] = 0; }); return row; }
  function add(a, b) { numeric.forEach(function (key) { a[key] += b[key] || 0; }); return a; }
  function sum(rows) { return rows.reduce(add, empty()); }
  function rate(row) { return row.cacheEligibleInput > 0 ? row.cacheEligibleCached / row.cacheEligibleInput : null; }
  function successRate(row) { return row.success + row.failed ? row.success / (row.success + row.failed) : null; }
  function coverage(row) { return row.attempts - row.pending ? row.usageKnown / (row.attempts - row.pending) : null; }
  function dayString(time) { return new Date(time + Number($('timezone').value) * 60000).toISOString().slice(0, 10); }
  function formatTime(time, full) {
    var date = new Date(time + data.query.offset * 60000).toISOString();
    return full ? date.slice(0,10) + ' ' + date.slice(11,16) : date.slice(5,10) + (data.query.bucket === 'hour' ? ' ' + date.slice(11,13) + 'h' : '');
  }
  function applyPeriod() {
    var period = $('period').value;
    if (period === 'custom') return;
    var today = dayString(Date.now());
    var end = Date.parse(today + 'T00:00:00Z') - (period === 'yesterday' ? 86400000 : 0);
    $('date-to').value = new Date(end).toISOString().slice(0,10);
    $('date-from').value = new Date(end - (period === '7d' ? 6 : period === '30d' ? 29 : 0) * 86400000).toISOString().slice(0,10);
  }
  var offset = -new Date().getTimezoneOffset();
  if (offset !== 0 && offset !== 480) {
    var option = document.createElement('option'); option.value = offset;
    option.textContent = '本地 UTC' + (offset >= 0 ? '+' : '') + offset / 60;
    $('timezone').appendChild(option);
  }
  $('timezone').value = String(offset);
  try {
    var saved = JSON.parse(localStorage.getItem(preferenceKey) || 'null');
    if (saved) {
      controls.forEach(function (id) { if (saved[id] !== undefined) $(id).value = saved[id]; });
      ['channel','model'].forEach(function (key) { if (saved.selected && (saved.selected[key] === null || Array.isArray(saved.selected[key]))) selected[key] = saved.selected[key]; });
    }
  } catch (_) { /* Browser storage is optional. */ }
  function save() {
    var values = { selected: selected };
    controls.forEach(function (id) { values[id] = $(id).value; });
    try { localStorage.setItem(preferenceKey, JSON.stringify(values)); } catch (_) { /* Optional preferences. */ }
  }
  applyPeriod();

  ['channel','model'].forEach(function (key) {
    var copy = $(key + '-filter').cloneNode(true);
    copy.id = 'cache-' + key + '-filter';
    copy.querySelector('[id]').id = 'cache-' + key + '-selection';
    copy.querySelector('input[type=search]').setAttribute('aria-label', '缓存图搜索' + (key === 'channel' ? '渠道' : '模型'));
    $('cache-filters').appendChild(copy);
  });

  function renderOptions(key, values) {
    [key, 'cache-' + key].forEach(function (filterId) {
    var container = $(filterId + '-filter'), list = container.querySelector('.filter-options');
    var search = container.querySelector('input[type=search]').value.toLowerCase();
    list.replaceChildren();
    values.forEach(function (entry) {
      var label = document.createElement('label'), check = document.createElement('input'), text = document.createElement('span');
      check.type = 'checkbox'; check.value = entry.id; check.checked = selected[key] === null || selected[key].includes(entry.id);
      text.textContent = entry.name || entry.id;
      if (entry.name && entry.name !== entry.id) { var small = document.createElement('small'); small.textContent = ' · ' + entry.id; text.appendChild(small); }
      label.hidden = !(entry.id + ' ' + entry.name).toLowerCase().includes(search);
      label.append(check, text); list.appendChild(label);
      check.addEventListener('change', function () {
        if (selected[key] === null) selected[key] = values.map(function (value) { return value.id; });
        selected[key] = check.checked ? Array.from(new Set(selected[key].concat(entry.id))) : selected[key].filter(function (id) { return id !== entry.id; });
        updateSelectionLabel(key); selectedBucket = null; page = 0; save(); load();
      });
    });
    });
    updateSelectionLabel(key);
  }
  function updateSelectionLabel(key) { [key,'cache-'+key].forEach(function (id) { $(id + '-selection').textContent = selected[key] === null ? '全部' : selected[key].length ? selected[key].length + ' 个已选' : '未选择'; $(id+'-filter').classList.toggle('is-filtered',selected[key]!==null); }); }
  ['channel','model'].forEach(function (key) {
    [key,'cache-'+key].forEach(function (id) {
    var filter = $(id + '-filter');
    filter.querySelector('input[type=search]').addEventListener('input', function (event) {
      filter.querySelectorAll('.filter-options label').forEach(function (label) { label.hidden = !label.textContent.toLowerCase().includes(event.target.value.toLowerCase()); });
    });
    filter.querySelectorAll('[data-select]').forEach(function (button) {
      button.addEventListener('click', function () { selected[key] = button.dataset.select === 'all' ? null : []; selectedBucket = null; page = 0; save(); load(); });
    });
    });
  });
  document.addEventListener('click', function (event) { document.querySelectorAll('.multi-filter[open]').forEach(function (filter) { if (!filter.contains(event.target)) filter.open = false; }); });
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape') { document.querySelectorAll('.multi-filter').forEach(function (filter) { filter.open = false; }); clearChartFocus(); } });
  document.addEventListener('click', function (event) { if (focusedSegment && !event.composedPath().some(function(el) { return el.classList && el.classList.contains('usage-chart'); })) clearChartFocus(); });

  function clearChartFocus() {
    if (focusedSegment) { focusedSegment=null; selectedBucket=null; renderCharts(); renderTable(); }
    $('chart-tooltip').hidden=true;
  }
  function positionTooltip(x, y) {
    var tip=$('chart-tooltip'), margin=12, gap=16;
    // Measure at the viewport origin, never in the narrow space left over from its previous position.
    tip.style.left='0px'; tip.style.top='0px'; tip.hidden=false;
    var width=tip.offsetWidth, height=tip.offsetHeight;
    var left=x+gap+width<=innerWidth-margin?x+gap:x-gap-width;
    var top=y+gap+height<=innerHeight-margin?y+gap:y-gap-height;
    tip.style.left=Math.max(margin,Math.min(left,innerWidth-width-margin))+'px';
    tip.style.top=Math.max(margin,Math.min(top,innerHeight-height-margin))+'px';
  }
  function highlightSegments(id, index, seriesIndex) {
    var target=$(id+'-chart');
    target.querySelectorAll('.bar-segment').forEach(function(el) {
      var active=Number(el.dataset.index)===index && Number(el.dataset.series)===seriesIndex;
      el.classList.toggle('is-emphasized',active);
      el.classList.toggle('is-muted',seriesIndex!==null && !active);
      el.setAttribute('aria-pressed',String(!!focusedSegment && focusedSegment.chart===id && active));
    });
    $(id+'-legend').querySelectorAll('[data-series]').forEach(function(el) {
      el.classList.toggle('is-muted',seriesIndex!==null && Number(el.dataset.series)!==seriesIndex);
      el.classList.toggle('is-emphasized',Number(el.dataset.series)===seriesIndex);
    });
  }

  async function load() {
    clearTimeout(timer); if (controller) controller.abort(); controller = new AbortController();
    var current = ++sequence;
    applyPeriod();
    var shift = Number($('timezone').value) * 60000;
    var from = Date.parse($('date-from').value + 'T00:00:00Z') - shift;
    var to = Date.parse($('date-to').value + 'T00:00:00Z') + 86400000 - shift;
    $('usage-status').textContent = '读取统计…';
    $('usage-error').hidden = true;
    try {
      var params = new URLSearchParams({ from: from, to: to, bucket: $('bucket').value, offset: $('timezone').value, kind: $('kind').value });
      ['channel','model'].forEach(function (key) { (selected[key] || []).forEach(function (id) { params.append(key, id); }); });
      var response = await fetch('/admin/usage/stats?' + params, { signal: controller.signal });
      if (response.status === 404) throw new Error('当前实例尚未启用持久化统计，需升级并重启这个实例。');
      var body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error && body.error.message || 'HTTP ' + response.status);
      if (current !== sequence) return;
      data = body;
      if (selected.channel && !selected.channel.length || selected.model && !selected.model.length) { data.rows = []; data.requests = 0; }
      channelNames = new Map(); (data.channels || []).concat(data.configuredChannels || []).forEach(function (entry) { channelNames.set(entry.id, entry.name); });
      (selected.channel || []).forEach(function (id) { if (!channelNames.has(id)) channelNames.set(id, id); });
      renderOptions('channel', Array.from(channelNames, function (entry) { return { id: entry[0], name: entry[1] }; }));
      renderOptions('model', Array.from(new Set((data.models || []).concat(data.configuredModels || [], selected.model || []))).sort().map(function (id) { return { id: id }; }));
      $('usage-instance').textContent = data.instanceName;
      $('usage-status').textContent = '已更新 ' + new Date(data.generatedAt).toLocaleTimeString() + ' · ' + data.rows.length + ' 个聚合分组';
      $('storage-info').textContent = '数据库：' + data.database + '。首次记录：' + (data.firstRecordedAt ? formatTime(data.firstRecordedAt, true) : '暂无') + '。每个实例独立保存，不记录请求正文或凭据；无自动清理，重启保留历史。';
      if (data.writeError) { $('usage-error').textContent = '数据库写入异常，统计可能不完整：' + data.writeError; $('usage-error').hidden = false; }
      $('export-csv').disabled = false; render();
    } catch (error) {
      if (error.name === 'AbortError' || current !== sequence) return;
      $('usage-error').textContent = error.message;
      $('usage-error').hidden = false;
      $('usage-status').textContent = data ? '更新失败 · 下方保留上次成功结果' : '统计不可用';
      $('export-csv').disabled = true;
    } finally {
      if (current === sequence && Number($('auto-refresh').value)) timer = setTimeout(function () { if (!document.hidden) load(); else timer = setTimeout(load, Number($('auto-refresh').value)); }, Number($('auto-refresh').value));
    }
  }

  function renderKpis() {
    var total = sum(data.rows), known = total.attempts - total.pending;
    var items = [
      ['上游调用', compact(total.attempts), number(data.requests) + ' 个请求 · ' + number(total.pending) + ' 进行中', number(total.attempts)],
      ['成功率', percent(successRate(total)), number(total.success) + ' 成功 / ' + number(total.failed) + ' 失败', '取消 ' + total.cancelled + ' · 中断 ' + total.interrupted],
      ['输入 token', total.inputKnown ? compact(total.inputTokens) : '—', '含已缓存输入', number(total.inputTokens)],
      ['输出 token', total.outputKnown ? compact(total.outputTokens) : '—', total.outputTokens ? '输入 : 输出 = ' + (total.inputTokens / total.outputTokens).toFixed(1) + ' : 1' : '仅统计实际报告值', number(total.outputTokens)],
      ['缓存命中率', percent(rate(total)), (total.cachedKnown ? compact(total.cachedInputTokens) : '—') + ' 缓存 token · ' + total.cacheKnown + '/' + known + ' 覆盖', '缓存率分母 ' + number(total.cacheEligibleInput) + ' 输入 token'],
      ['Usage 覆盖', percent(coverage(total)), number(total.usageKnown) + ' / ' + number(known) + ' 已结束调用', '缺失 usage 不当作零 token'],
    ];
    $('usage-kpis').innerHTML = items.map(function (item) { return '<div class="usage-kpi" title="' + escape(item[3]) + '"><label>' + item[0] + '</label><strong>' + item[1] + '</strong><small>' + escape(item[2]) + '</small></div>'; }).join('');
    $('usage-empty').hidden = total.attempts > 0;
  }
  function buckets() {
    var q = data.query, step = q.bucket === 'hour' ? 3600000 : 86400000, shift = q.offset * 60000, values = [];
    for (var time = Math.floor((q.from + shift) / step) * step - shift; time < q.to; time += step) values.push(time);
    return values;
  }
  function seriesFor(dimension, metric, times) {
    var byTime = new Map(times.map(function (time) { return [time, []]; }));
    data.rows.forEach(function (row) { if (byTime.has(row.bucket)) byTime.get(row.bucket).push(row); });
    if (dimension === 'outcome') return Object.keys(outcomeNames).filter(function (key) { return metric === 'attempts' || key === metric; }).map(function (key) {
      return { name: outcomeNames[key], color: outcomeColors[Object.keys(outcomeNames).indexOf(key)], values: times.map(function (time) { return sum(byTime.get(time))[key]; }) };
    });
    if (dimension === 'composition') return [
      ['uncachedInputTokens','未缓存输入','#6785da'], ['cacheEligibleCached','缓存输入','#a9e4d1'], ['unknownCacheInputTokens','缓存状态未知的输入','#c8d1df'], ['outputTokens','输出','#ac97dc'],
    ].map(function (item) { return { name: item[1], color: item[2], cached: item[0] === 'cacheEligibleCached', values: times.map(function (time) { var row=sum(byTime.get(time)); var known=item[0]==='outputTokens'?row.outputKnown:item[0]==='unknownCacheInputTokens'?row.inputKnown:row.cacheKnown; return known?row[item[0]]:null; }) }; });
    var keyOf = function (row) { return dimension === 'total' ? '整体' : dimension === 'channel' ? row.channelId : row.model; };
    var totals = new Map();
    data.rows.forEach(function (row) { var key = keyOf(row); totals.set(key, (totals.get(key) || 0) + (metric === 'rate' ? row.cacheEligibleInput : row[metric])); });
    var keys = Array.from(totals.keys()).sort(function (a,b) { return totals.get(b) - totals.get(a); });
    var top = keys.slice(0,8), groups = top.map(function (key) { return [key]; });
    if (keys.length > 8) groups.push(keys.slice(8));
    return groups.map(function (group, index) {
      var name = index === 8 ? '其他 (' + group.length + ')' : dimension === 'channel' && channelNames.get(group[0]) !== group[0] ? (channelNames.get(group[0]) || group[0]) + ' · ' + group[0] : group[0];
      var colorKeys=dimension==='channel'?Array.from(channelNames.keys()).sort():Array.from(new Set((data.models||[]).concat(data.configuredModels||[]))).sort();
      var colorIndex=Math.max(0,colorKeys.indexOf(group[0]));
      var color=index===8?palette[8]:colorIndex<8?palette[colorIndex]:'hsl('+(colorIndex*137.5%360)+',52%,56%)';
      return { name: name, color: color, values: times.map(function (time) {
        var row = sum(byTime.get(time).filter(function (row) { return group.includes(keyOf(row)); }));
        var known={inputTokens:'inputKnown',outputTokens:'outputKnown',cachedInputTokens:'cachedKnown',totalTokens:'totalKnown',reasoningTokens:'reasoningKnown'}[metric];
        return metric === 'rate' ? rate(row) : known && !row[known] ? null : row[metric];
      }) };
    });
  }
  function drawChart(id, series, times, isLine) {
    var target = $(id + '-chart');
    var width = Math.max(300, target.clientWidth - 20), height = isLine ? 190 : 232;
    var left = 48, right = 12, top = 18, bottom = 30, plotW = width-left-right, plotH = height-top-bottom;
    var maximum = isLine ? 1 : Math.max(1, ...times.map(function (_, index) { return series.reduce(function (n,s) { return n + (s.values[index] || 0); }, 0); }));
    if (!isLine) { var magnitude = Math.pow(10, Math.floor(Math.log10(maximum))); maximum = Math.max(4,Math.ceil(Math.ceil(maximum / magnitude * 2) / 2 * magnitude / 4) * 4); }
    var slot = plotW / Math.max(1,times.length), barWidth = Math.max(.5, Math.min(42,slot * .72));
    var svg = '<svg viewBox="0 0 ' + width + ' ' + height + '" role="group" aria-label="' + (isLine ? '缓存命中率曲线' : '时间堆叠柱状图') + '"><defs>';
    series.forEach(function (s,i) { svg += '<linearGradient id="'+id+'-gradient-'+i+'" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="'+s.color+'" stop-opacity=".14"/><stop offset="100%" stop-color="'+s.color+'" stop-opacity="0"/></linearGradient>'; });
    svg += '<linearGradient id="'+id+'-cached" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#a5dfca"/><stop offset="55%" stop-color="#c7f1e3"/><stop offset="100%" stop-color="#9fddc9"/></linearGradient></defs>';
    for (var tick=0; tick<=4; tick++) {
      var y = top + plotH * tick/4, value = maximum * (1-tick/4);
      svg += '<line class="chart-grid-line" x1="'+left+'" x2="'+(width-right)+'" y1="'+y+'" y2="'+y+'"/><text x="'+(left-8)+'" y="'+(y+3)+'" text-anchor="end">'+(isLine ? Math.round(value*100)+'%' : compact(value))+'</text>';
    }
    if (isLine) {
      if (!series.length) series = [{ name: '暂无调用 · 补零', color: palette[0], values: times.map(function () { return null; }) }];
      series.forEach(function (s, si) {
        var path = '', previous;
        s.values.forEach(function (value,index) {
          value = value === null ? 0 : Math.max(0, Math.min(1, value));
          var x=left+slot*(index+.5), y=top+plotH*(1-value);
          path += previous ? 'C'+((previous.x+x)/2)+','+previous.y+' '+((previous.x+x)/2)+','+y+' '+x+','+y+' ' : 'M'+x+','+y+' ';
          previous = { x:x, y:y };
        });
        if (previous) svg += '<path d="'+path+'L'+previous.x+','+(top+plotH)+'L'+(left+slot*.5)+','+(top+plotH)+'Z" fill="url(#'+id+'-gradient-'+si+')"/>';
        svg += '<path class="cache-line" d="'+path+'" fill="none" stroke="'+s.color+'" stroke-width="2.3" stroke-linecap="round"/>';
        s.values.forEach(function (value,index) { svg += '<circle class="cache-dot" data-point="'+index+'" cx="'+(left+slot*(index+.5))+'" cy="'+(top+plotH*(1-Math.max(0,Math.min(1,value||0))))+'" r="3.7" fill="'+s.color+'" stroke="white" stroke-width="1.5"/>'; });
      });
    } else {
      times.forEach(function (_,index) {
        var accumulated=0;
        svg += '<g class="bar-stack" data-bar="'+index+'" style="transform-origin:'+(left+slot*(index+.5))+'px '+(top+plotH)+'px">';
        series.forEach(function (s,seriesIndex) {
          var value=s.values[index] || 0, barH=value/maximum*plotH;
          svg += '<rect class="bar-segment'+(s.cached?' cached-segment':'')+'" data-index="'+index+'" data-series="'+seriesIndex+'" tabindex="-1" role="button" aria-pressed="false" aria-label="'+escape(formatTime(times[index],true)+' · '+s.name+' '+number(value))+'" rx="1.5" x="'+(left+slot*(index+.5)-barWidth/2)+'" y="'+(top+plotH-(accumulated+value)/maximum*plotH)+'" width="'+barWidth+'" height="'+barH+'" fill="'+(s.cached?'url(#'+id+'-cached)':s.color)+'"/>';
          accumulated+=value;
        });
        svg += '</g>';
      });
    }
    var labelEvery=Math.max(1,Math.ceil(times.length/Math.max(2,Math.floor(plotW/80))));
    times.forEach(function (time,index) {
      var x=left+slot*(index+.5);
      if (index%labelEvery===0) svg += '<text x="'+x+'" y="'+(height-8)+'" text-anchor="middle">'+formatTime(time,false)+'</text>';
      var accessible = formatTime(time,true) + ': ' + series.map(function (s) { return s.name + ' ' + (isLine ? (s.values[index]===null?'0% 补零':percent(s.values[index])) : s.values[index]===null?'未知':number(s.values[index] || 0)); }).join('; ');
      svg += '<rect class="bucket-target'+(selectedBucket===time?' selected':'')+'" data-index="'+index+'" tabindex="'+(index===0?'0':'-1')+'" role="button" aria-label="'+escape(accessible)+'" x="'+(left+slot*index)+'" y="'+top+'" width="'+slot+'" height="'+plotH+'"/>';
    });
    svg += '</svg>';
    if (!isLine && !series.some(function (s) { return s.values.some(function (value) { return value > 0; }); })) svg += '<div class="chart-no-data">暂无数据</div>';
    target.innerHTML=svg;
    if (!isLine) {
      var firstBar=target.querySelector('.bar-stack');
      if(firstBar) target.querySelectorAll('.bucket-target').forEach(function(el) { firstBar.before(el); });
    }
    $(id+'-legend').innerHTML=series.map(function (s,i) { return '<span data-series="'+i+'"><i style="background:'+s.color+'"></i>'+escape(s.name)+'</span>'; }).join('');
    chartData[id]={ series:series, times:times, isLine:isLine };
    if (focusedSegment && focusedSegment.chart===id) {
      var index=times.indexOf(focusedSegment.time), seriesIndex=series.findIndex(function(s) {return s.name===focusedSegment.name;});
      if(index<0 || seriesIndex<0 || selectedBucket!==focusedSegment.time) focusedSegment=null;
      else highlightSegments(id,index,seriesIndex);
    }
  }
  function renderCharts() {
    if (!data) return;
    $('chart-tooltip').hidden=true;
    var times=buckets();
    drawChart('calls',seriesFor($('calls-stack').value,$('calls-metric').value,times),times,false);
    var composition=$('tokens-metric').value==='composition';
    $('tokens-stack').disabled=composition;
    drawChart('tokens',seriesFor(composition?'composition':$('tokens-stack').value,$('tokens-metric').value,times),times,false);
    drawChart('cache',seriesFor($('cache-stack').value,'rate',times),times,true);
  }
  ['calls','tokens','cache'].forEach(function (id) {
    var target=$(id+'-chart');
    function show(event) {
      var rect=event.target.closest('[data-index]'); if (!rect) return;
      var chart=chartData[id], index=Number(rect.dataset.index), tooltip=$('chart-tooltip');
      var seriesIndex=rect.dataset.series===undefined?null:Number(rect.dataset.series);
      var pinned=focusedSegment && focusedSegment.chart===id;
      if (pinned) { index=chart.times.indexOf(focusedSegment.time); seriesIndex=chart.series.findIndex(function(s){return s.name===focusedSegment.name;}); }
      target.querySelectorAll('.is-hovered').forEach(function (el) { el.classList.remove('is-hovered'); });
      target.querySelectorAll('[data-bar="'+index+'"],[data-point="'+index+'"]').forEach(function (el) { el.classList.add('is-hovered'); });
      if (!chart.isLine) highlightSegments(id,index,seriesIndex);
      tooltip.innerHTML='<strong>'+formatTime(chart.times[index],true)+(pinned?'<small>已聚焦 · 再次点击或 Esc 取消</small>':'')+'</strong>'+chart.series.map(function (s,i) { return '<div class="tooltip-series'+(seriesIndex===null?'':i===seriesIndex?' is-emphasized':' is-muted')+'"><span><i style="background:'+s.color+'"></i>'+escape(s.name)+'</span><b>'+(chart.isLine?(s.values[index]===null?'0% · 补零':percent(s.values[index])):s.values[index]===null?'—':number(s.values[index] || 0))+'</b></div>'; }).join('');
      var bounds=rect.getBoundingClientRect(), x=event.clientX || bounds.x+bounds.width/2, y=event.clientY || bounds.y+40;
      positionTooltip(x,y);
    }
    target.addEventListener('pointermove',show); target.addEventListener('focusin',show);
    function hide() { $('chart-tooltip').hidden=true; target.querySelectorAll('.is-hovered').forEach(function(el) { el.classList.remove('is-hovered'); }); if (!focusedSegment || focusedSegment.chart!==id) highlightSegments(id,null,null); }
    target.addEventListener('pointerleave',hide);
    target.addEventListener('focusout',hide);
    function choose(event) {
      var rect=event.target.closest('[data-index]'); if (!rect) return;
      var index=Number(rect.dataset.index), chart=chartData[id], time=chart.times[index];
      var seriesIndex=rect.dataset.series===undefined?null:Number(rect.dataset.series);
      if (seriesIndex!==null) {
        var name=chart.series[seriesIndex].name;
        var same=focusedSegment && focusedSegment.chart===id && focusedSegment.time===time && focusedSegment.name===name;
        focusedSegment=same?null:{chart:id,time:time,name:name}; selectedBucket=same?null:time;
      } else { focusedSegment=null; selectedBucket=selectedBucket===time?null:time; }
      page=0; renderCharts(); renderTable();
      var next=target.querySelector(seriesIndex===null?'.bucket-target[data-index="'+index+'"]':'.bar-segment[data-index="'+index+'"][data-series="'+seriesIndex+'"]');
      if (event.type==='keydown') next.focus({preventScroll:true});
      if (seriesIndex!==null && focusedSegment) {
        show({target:next,clientX:event.clientX,clientY:event.clientY});
      } else { highlightSegments(id,null,null); $('chart-tooltip').hidden=true; }
    }
    target.addEventListener('click',choose);
    target.addEventListener('keydown',function (event) {
      var rect=event.target.closest('[data-index]'); if (!rect) return;
      if (event.key==='ArrowLeft' || event.key==='ArrowRight') { event.preventDefault(); var next=target.querySelector('.bucket-target[data-index="'+(Number(rect.dataset.index)+(event.key==='ArrowLeft'?-1:1))+'"]'); if(next) { rect.tabIndex=-1; next.tabIndex=0; next.focus(); } }
      if (!chartData[id].isLine && (event.key==='ArrowUp' || event.key==='ArrowDown')) {
        event.preventDefault(); var segments=[...target.querySelectorAll('.bar-segment[data-index="'+rect.dataset.index+'"]')].filter(function(el){return Number(el.getAttribute('height'))>0;});
        var at=segments.indexOf(rect), nextSegment=segments[at<0?0:Math.max(0,Math.min(segments.length-1,at+(event.key==='ArrowUp'?1:-1)))];
        if(nextSegment) {rect.tabIndex=-1;nextSegment.tabIndex=0;nextSegment.focus();}
      }
      if (event.key==='Enter' || event.key===' ') { event.preventDefault(); choose(event); }
    });
  });
  function renderTable() {
    if (!data) return;
    var grouped=new Map();
    data.rows.forEach(function (row) {
      if (selectedBucket!==null && row.bucket!==selectedBucket) return;
      var key=JSON.stringify([row.channelId,row.model,row.kind]);
      if (!grouped.has(key)) grouped.set(key,Object.assign(empty(), { channelId:row.channelId, model:row.model, kind:row.kind }));
      add(grouped.get(key),row);
    });
    var search=$('detail-search').value.toLowerCase();
    tableRows=Array.from(grouped.values()).filter(function (row) { return ((channelNames.get(row.channelId)||'')+' '+row.channelId+' '+row.model).toLowerCase().includes(search); });
    function value(row) { if (sortKey==='channel') return channelNames.get(row.channelId)||row.channelId; if (sortKey==='cacheRate') return rate(row) ?? -1; if (sortKey==='successRate') return successRate(row) ?? -1; if (sortKey==='coverage') return coverage(row) ?? -1; if (sortKey==='latency') return row.finished ? row.durationMs/row.finished : -1; return row[sortKey]; }
    tableRows.sort(function (a,b) { var x=value(a),y=value(b); return (typeof x==='string' ? x.localeCompare(y) : x-y)*sortDirection; });
    page=Math.min(page,Math.max(0,Math.ceil(tableRows.length/25)-1));
    var token=function (row,key,known) { return row[known] ? number(row[key]) : '—'; };
    $('usage-table').querySelector('tbody').innerHTML=tableRows.slice(page*25,page*25+25).map(function (row) {
      var hit=rate(row);
      return '<tr><td>'+escape(channelNames.get(row.channelId)||row.channelId)+'<small>'+escape(row.model)+' · '+escape(row.kind)+'</small><small>'+escape(row.channelId)+'</small></td><td>'+number(row.attempts)+(row.pending?'<small>'+row.pending+' 进行中</small>':'')+'</td><td>'+number(row.success)+'</td><td class="'+(row.failed?'cell-failed':'')+'">'+number(row.failed)+'</td><td>'+number(row.cancelled)+' / '+number(row.interrupted)+'</td><td>'+percent(successRate(row))+'</td><td>'+token(row,'inputTokens','inputKnown')+'</td><td>'+token(row,'outputTokens','outputKnown')+'</td><td>'+token(row,'cachedInputTokens','cachedKnown')+'</td><td><span class="rate-cell"><span class="rate-track"><i style="width:'+(hit===null?0:hit*100)+'%"></i></span>'+percent(hit)+'</span><small>'+row.cacheKnown+'/'+(row.attempts-row.pending)+' 报告缓存</small></td><td>'+percent(coverage(row))+'<small>'+row.usageKnown+'/'+(row.attempts-row.pending)+'</small></td><td>'+(row.finished?(row.durationMs/row.finished/1000).toFixed(2)+'s':'—')+'</td></tr>';
    }).join('') || '<tr><td colspan="12" style="text-align:center;padding:24px;color:var(--text-tertiary)">没有匹配的调用记录</td></tr>';
    $('detail-count').textContent=tableRows.length+' 组';
    $('detail-scope').textContent=selectedBucket===null?'所选范围汇总 · 点击列标题排序':'时段聚焦：'+formatTime(selectedBucket,true)+' · '+(data.query.bucket==='hour'?'1 小时':'1 天');
    $('clear-bucket').hidden=selectedBucket===null;
    $('table-note').textContent='每页 25 组 · token 为已报告值之和';
    $('page-label').textContent=(page+1)+' / '+Math.max(1,Math.ceil(tableRows.length/25));
    $('prev-page').disabled=page===0; $('next-page').disabled=(page+1)*25>=tableRows.length;
    document.querySelectorAll('#usage-table th').forEach(function (th) { th.removeAttribute('aria-sort'); if (th.querySelector('button').dataset.sort===sortKey) th.setAttribute('aria-sort',sortDirection===1?'ascending':'descending'); });
  }
  function render() { renderKpis(); renderCharts(); renderTable(); }
  document.querySelectorAll('[data-sort]').forEach(function (button) { button.addEventListener('click',function () { sortDirection=sortKey===button.dataset.sort?-sortDirection:-1; sortKey=button.dataset.sort; renderTable(); }); });
  $('detail-search').addEventListener('input',function () { page=0; renderTable(); });
  $('prev-page').onclick=function () { page--; renderTable(); }; $('next-page').onclick=function () { page++; renderTable(); };
  $('clear-bucket').onclick=function () { selectedBucket=null; page=0; renderCharts(); renderTable(); };
  $('refresh').onclick=load;
  $('reset-filters').onclick=function () { selected={ channel:null, model:null }; selectedBucket=null; page=0; $('kind').value='all'; $('detail-search').value=''; save(); load(); };
  controls.forEach(function (id) { $(id).addEventListener('change',function () {
    focusedSegment=null;
    if (id==='date-from' || id==='date-to') $('period').value='custom';
    if (id==='period') { applyPeriod(); $('bucket').value=['today','yesterday'].includes($('period').value)?'hour':'day'; }
    save();
    if (id.startsWith('calls-') || id.startsWith('tokens-') || id==='cache-stack') renderCharts();
    else { selectedBucket=null; page=0; load(); }
  }); });
  $('export-csv').onclick=function () {
    var rows=[['channel_id','channel_name','model','kind','attempts','success','failed','cancelled','interrupted','pending','input_tokens','output_tokens','cached_input_tokens','reasoning_tokens','cache_rate','usage_coverage','average_ms']];
    tableRows.forEach(function (r) { rows.push([r.channelId,channelNames.get(r.channelId)||r.channelId,r.model,r.kind,r.attempts,r.success,r.failed,r.cancelled,r.interrupted,r.pending,r.inputKnown?r.inputTokens:'',r.outputKnown?r.outputTokens:'',r.cachedKnown?r.cachedInputTokens:'',r.reasoningKnown?r.reasoningTokens:'',rate(r)??'',coverage(r)??'',r.finished?r.durationMs/r.finished:'']); });
    var csv=rows.map(function (row) { return row.map(function (value) { var text=String(value); if (/^[=+\-@\t\r]/.test(text)) text="'"+text; return '"'+text.replace(/"/g,'""')+'"'; }).join(','); }).join('\r\n');
    var url=URL.createObjectURL(new Blob(['\ufeff'+csv],{ type:'text/csv;charset=utf-8' })), link=document.createElement('a');
    link.href=url; link.download='relay-usage-'+$('date-from').value+'-'+$('date-to').value+'.csv'; link.click(); setTimeout(function () { URL.revokeObjectURL(url); },1000);
  };
  var resizeTimer;
  window.addEventListener('resize',function () { clearTimeout(resizeTimer); resizeTimer=setTimeout(renderCharts,120); });
  document.addEventListener('visibilitychange',function () { if (!document.hidden && Number($('auto-refresh').value)) load(); });

  var uptimeData, uptimeTimer, uptimeController, uptimeRows = new Map(), uptimeScope = '';
  var uptimeReason = { available:'未进入熔断', failure_count:'仅失败次数达到阈值', failure_rate:'仅失败率超过阈值', breaker:'渠道普通熔断（各模型共享）', quota:'额度耗尽熔断', manual:'管理员熔断', no_breaker:'两项超限，但 No breaker 豁免普通熔断' };
  var uptimeModel = '';
  try { var pref=JSON.parse(localStorage.getItem(preferenceKey+':uptime')); if(pref) { uptimeModel=pref.model||''; if([6,24,72,168].includes(Number(pref.hours))) $('uptime-hours').value=pref.hours; } } catch (_) { /* Optional preferences. */ }
  function uptimeTime(t) { return new Date(t).toLocaleString([], { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }); }
  async function loadUptime() {
    clearTimeout(uptimeTimer);
    if (uptimeController) uptimeController.abort();
    var control = uptimeController = new AbortController();
    try {
      var params=new URLSearchParams({ hours:$('uptime-hours').value });
      if(uptimeModel) params.set('model',uptimeModel);
      var response=await fetch('/admin/uptime?'+params, { signal:control.signal });
      if ([404,501].includes(response.status)) { $('uptime').hidden=true; return; }
      if(response.status===400 && uptimeModel) { uptimeModel=''; return loadUptime(); }
      var body=await response.json();
      if(!response.ok || !body.ok) throw new Error(body.error && body.error.message || 'Uptime 读取失败');
      uptimeData=body; uptimeModel=body.model; $('uptime').hidden=false;
      var modelSelect=$('uptime-model');
      if(JSON.stringify([...modelSelect.options].map(function(o){return o.value;}))!==JSON.stringify(body.models)) {
        modelSelect.replaceChildren(); body.models.forEach(function(model){modelSelect.add(new Option(model,model));});
      }
      modelSelect.value=body.model;
      $('uptime-status').textContent=body.writeError?'历史写入异常：'+body.writeError:'服务端持续采样 · '+new Date(body.generatedAt).toLocaleTimeString();
      renderUptime();
    } catch(error) {
      if(error.name==='AbortError') return;
      $('uptime').hidden=false; $('uptime-status').textContent='更新失败：'+error.message;
    } finally { if(control===uptimeController) uptimeTimer=setTimeout(loadUptime,60000); }
  }
  function renderUptime() {
    var d=uptimeData, history=$('uptime-history'), count=Math.round((d.to-d.from)/d.intervalMs), width=count*4;
    var scroll=history.scrollLeft, atEnd=history.scrollWidth-history.clientWidth-scroll<16, scope=d.model+':'+d.hours;
    uptimeRows=new Map(d.rows.map(function(row){return [JSON.stringify([row.channelId,row.bucket]),row];}));
    var current=new Map(d.current.map(function(row){return [row.channelId,row];}));
    history.innerHTML='<div class="uptime-timeline" style="--uptime-width:'+width+'px">'+d.channels.map(function(channel) {
      var rows=d.rows.filter(function(row){return row.channelId===channel.id;}), live=current.get(channel.id);
      var availability=rows.length?(rows.filter(function(row){return row.state!=='red';}).length/rows.length):null;
      var cells='';
      for(var i=0;i<count;i++) {
        var time=d.from+i*d.intervalMs, row=uptimeRows.get(JSON.stringify([channel.id,time]));
        cells+='<rect class="uptime-cell uptime-'+(row?row.state:'unknown')+'" x="'+(i*4)+'" y="4" width="2.7" height="22" rx="1" data-slot="'+i+'" data-channel="'+escape(channel.id)+'" tabindex="'+(i===count-1?'0':'-1')+'" role="img" aria-label="'+escape(uptimeTime(time)+' '+channel.name+' '+(row?uptimeReason[row.reason]:'未采样'))+'"/>';
      }
      return '<div class="uptime-row"><div class="uptime-label"><strong title="'+escape(channel.id)+'">'+escape(channel.name)+'</strong><span class="uptime-availability" title="可用采样率 · '+rows.length+'/'+count+' 已采样">'+percent(availability)+'</span><small><i class="uptime-'+(live?live.state:'unknown')+'"></i>'+escape(live?uptimeReason[live.reason]:'等待状态')+'</small></div><div class="uptime-track"><svg viewBox="0 0 '+width+' 30" aria-label="'+escape(channel.name)+' 三分钟状态历史" role="group">'+cells+'</svg></div></div>';
    }).join('')+'<div class="uptime-axis"><span>'+uptimeTime(d.from)+'</span><span>'+uptimeTime(d.to-d.intervalMs)+' · 现在</span></div></div>';
    history.scrollLeft=scope!==uptimeScope||atEnd?history.scrollWidth:scroll;
    uptimeScope=scope;
  }
  function showUptime(event) {
    var cell=event.target.closest('[data-slot]'); if(!cell || !uptimeData)return;
    var time=uptimeData.from+Number(cell.dataset.slot)*uptimeData.intervalMs;
    var row=uptimeRows.get(JSON.stringify([cell.dataset.channel,time])), tip=$('chart-tooltip');
    var channel=uptimeData.channels.find(function(c){return c.id===cell.dataset.channel;});
    tip.innerHTML='<strong>'+escape(channel.name)+' · '+escape(uptimeData.model)+'</strong><div>'+uptimeTime(time)+' — '+uptimeTime(time+uptimeData.intervalMs)+'</div>'+(row?'<div><span>采样 '+uptimeTime(row.sampledAt)+'</span><b>'+uptimeReason[row.reason]+'</b></div><div><span>模型窗口 '+row.windowMs/60000+' 分钟 · 成功 / 失败</span><b>'+row.successes+' / '+row.failures+'</b></div><div><span>失败率</span><b>'+percent(row.failures+row.successes?row.failures/(row.failures+row.successes):null)+'</b></div><div><span>阈值（两项同时满足）</span><b>≥'+row.failureThreshold+' 次 &amp; &gt;'+percent(row.rateThreshold)+'</b></div>':'<div>未采样 · 启用前、停机或渠道配置已变更</div>');
    var b=cell.getBoundingClientRect();
    positionTooltip(event.clientX||b.x,event.clientY||b.y);
  }
  $('uptime-history').addEventListener('pointermove',showUptime);
  $('uptime-history').addEventListener('focusin',showUptime);
  ['pointerleave','focusout','scroll'].forEach(function(event){$('uptime-history').addEventListener(event,function(){$('chart-tooltip').hidden=true;});});
  $('uptime-history').addEventListener('keydown',function(event){
    var cell=event.target.closest('[data-slot]'); if(!cell)return;
    var index=Number(cell.dataset.slot), count=(uptimeData.to-uptimeData.from)/uptimeData.intervalMs;
    if(event.key==='ArrowLeft')index--; else if(event.key==='ArrowRight')index++; else if(event.key==='Home')index=0; else if(event.key==='End')index=count-1; else return;
    event.preventDefault(); var next=cell.parentElement.querySelector('[data-slot="'+Math.max(0,Math.min(count-1,index))+'"]');
    cell.tabIndex=-1; next.tabIndex=0; next.focus(); next.scrollIntoView({block:'nearest',inline:'nearest'});
  });
  ['uptime-model','uptime-hours'].forEach(function(id){$(id).addEventListener('change',function(){uptimeModel=$('uptime-model').value; try{localStorage.setItem(preferenceKey+':uptime',JSON.stringify({model:uptimeModel,hours:$('uptime-hours').value}));}catch(_){} loadUptime();});});
  $('uptime-latest').onclick=function(){$('uptime-history').scrollTo({left:$('uptime-history').scrollWidth,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});};
  loadUptime();
  load();
}());
