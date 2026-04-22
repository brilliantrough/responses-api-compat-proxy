(function() {
  var statusEl = document.getElementById('monitor-status');
  var cardsEl = document.getElementById('global-cards');
  var providerBody = document.querySelector('#provider-table tbody');
  var trendBars = document.getElementById('trend-bars');
  var samples = [];
  var timer = null;

  function escapeHtml(value) {
    var div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
  }

  function fmtTime(value) {
    return value ? new Date(value).toLocaleTimeString() : '-';
  }

  function stateClass(state) {
    return state === 'closed' ? 'state-ok' : state === 'half_open' ? 'state-warn' : 'state-bad';
  }

  function fallbackTotal(stats) {
    var reasons = stats.fallbackReasons || {};
    return Object.keys(reasons).reduce(function(total, key) {
      return total + (Number(reasons[key]) || 0);
    }, 0);
  }

  function renderCards(data) {
    var stats = data.stats || {};
    var cards = [
      ['Active', data.activeRequests],
      ['Requests', stats.requestsTotal],
      ['JSON', stats.responsesJson],
      ['SSE', (stats.responsesSseNormalized || 0) + (stats.responsesSseRaw || 0)],
      ['Fallbacks', fallbackTotal(stats)],
      ['Cache H/M', (stats.cacheHits || 0) + '/' + (stats.cacheMisses || 0)],
      ['4xx/5xx', (stats.errors4xx || 0) + '/' + (stats.errors5xx || 0)],
      ['Updated', new Date().toLocaleTimeString()],
    ];
    cardsEl.innerHTML = cards.map(function(card) {
      return '<div class="card"><div class="card-label">' + escapeHtml(card[0]) + '</div><div class="card-value">' + escapeHtml(card[1]) + '</div></div>';
    }).join('');
  }

  function renderProviders(data) {
    providerBody.innerHTML = (data.endpointHealth || []).map(function(endpoint) {
      return '<tr>' +
        '<td><span class="dot ' + stateClass(endpoint.state) + '"></span>' + escapeHtml(endpoint.state) + '</td>' +
        '<td>' + escapeHtml(endpoint.name) + '</td>' +
        '<td>' + (endpoint.isFallback ? 'fallback' : 'primary') + '</td>' +
        '<td>' + escapeHtml(endpoint.remainingSeconds || 0) + 's</td>' +
        '<td>' + escapeHtml(endpoint.failureCount) + '</td>' +
        '<td>' + escapeHtml(endpoint.successCount) + '</td>' +
        '<td>' + escapeHtml(endpoint.lastFailureReason || '-') + '</td>' +
        '<td>' + escapeHtml(fmtTime(endpoint.lastSuccessAt)) + '</td>' +
        '<td class="url" title="' + escapeHtml(endpoint.url) + '">' + escapeHtml(endpoint.url) + '</td>' +
        '</tr>';
    }).join('');
  }

  function renderTrend() {
    var max = Math.max(1, ...samples.map(function(sample) {
      return sample.activeRequests || 0;
    }));
    trendBars.innerHTML = samples.map(function(sample) {
      var active = sample.activeRequests || 0;
      var height = Math.max(4, Math.round((active / max) * 48));
      return '<span style="height:' + height + 'px" title="active=' + active + '"></span>';
    }).join('');
  }

  async function poll() {
    if (document.hidden) return;
    try {
      var response = await fetch('/admin/monitor/stats', { cache: 'no-store' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var body = await response.json();
      samples.push(body);
      if (samples.length > 60) samples.shift();
      renderCards(body);
      renderProviders(body);
      renderTrend();
      statusEl.textContent = 'Last updated ' + new Date().toLocaleTimeString();
      statusEl.className = '';
    } catch (error) {
      statusEl.textContent = 'Monitor error: ' + error.message;
      statusEl.className = 'error';
    }
  }

  function schedule() {
    clearInterval(timer);
    if (!document.hidden) {
      poll();
      timer = setInterval(poll, 1000);
    } else {
      statusEl.textContent = 'Paused while tab is hidden';
    }
  }

  document.addEventListener('visibilitychange', schedule);
  schedule();
})();
