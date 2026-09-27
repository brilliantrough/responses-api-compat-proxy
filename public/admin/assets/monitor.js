(function() {
  var statusEl = document.getElementById('monitor-status');
  var cardsEl = document.getElementById('global-cards');
  var routeBody = document.querySelector('#route-table tbody');
  var channelBody = document.querySelector('#channel-table tbody');
  var trendBars = document.getElementById('trend-bars');
  var samples = [];
  var timer = null;
  var expandedChannels = {};
  var expandedModels = {};
  var controllingChannel = null;

  function effectiveState(record, channel) {
    if (!record) return null;
    if (channel && (channel.manualRemainingSeconds > 0 || channel.quotaRemainingSeconds > 0)) return 'open';
    return channel && channel.disableCooldown ? 'closed' : record.state;
  }

  function manualBadge(record) {
    return record && record.manualRemainingSeconds > 0
      ? '<span class="quota-badge">人工熔断 ' + escapeHtml(record.manualRemainingSeconds) + 's</span>' : '';
  }

  function escapeHtml(value) {
    var div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtTime(value) {
    return value ? new Date(value).toLocaleTimeString() : '-';
  }

  function stateClass(state) {
    return state === 'closed' ? 'state-ok' : state === 'half_open' ? 'state-warn' : state === 'open' ? 'state-bad' : '';
  }

  function stateBadge(state) {
    return '<span class="state-badge ' + stateClass(state) + '">' + escapeHtml(state || '-') + '</span>';
  }

  function cooldown(record) {
    var remainingSeconds = Number(record && record.remainingSeconds) || 0;
    return remainingSeconds > 0 ? remainingSeconds + 's' : '-';
  }

  function fmtQuotaRemaining(seconds) {
    var s = Number(seconds) || 0;
    if (s <= 0) return '';
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    if (h > 0) return h + 'h' + (m > 0 ? m + 'm' : '');
    if (m > 0) return m + 'm';
    return s + 's';
  }

  function quotaBadge(record) {
    var seconds = Number(record && record.quotaRemainingSeconds) || 0;
    if (seconds <= 0) return '';
    return '<span class="quota-badge" title="Upstream reported quota exhaustion; channel is skipped until this cooldown expires (last quota failure: ' + fmtTime(record.lastQuotaFailureAt) + ', total quota failures: ' + statCount(record.quotaFailureCount) + ')">quota ' + escapeHtml(fmtQuotaRemaining(seconds)) + '</span>';
  }

  function channelQuotaRemaining(snapshot, channelId) {
    var record = (snapshot.channels || []).find(function(entry) {
      return entry.channelId === channelId;
    });
    return Number(record && record.quotaRemainingSeconds) || 0;
  }

  function channelQuotaRecord(snapshot, channelId) {
    return (snapshot.channels || []).find(function(entry) {
      return entry.channelId === channelId;
    }) || null;
  }

  function statCount(value) {
    var count = Number(value);
    return Number.isFinite(count) && count >= 0 ? count : 0;
  }

  function requestStats(record) {
    if (!record) {
      return {
        attempts: '<span class="stat-empty">-</span>',
        split: '<span class="stat-empty">-</span>',
        rate: '<span class="stat-empty">-</span>',
      };
    }
    var successes = statCount(record.successCount);
    var failures = statCount(record.totalFailures);
    var attempts = successes + failures;
    var rate = attempts > 0 ? ((successes / attempts) * 100).toFixed(1) + '%' : '-';
    return {
      attempts: '<span class="stat-attempts">' + escapeHtml(attempts) + '</span>',
      split: '<span class="stat-split"><span class="stat-success">' + escapeHtml(successes) + '</span>' +
        '<span class="stat-divider"> / </span><span class="stat-failure">' + escapeHtml(failures) + '</span></span>',
      rate: '<span class="' + (attempts > 0 ? 'stat-rate' : 'stat-empty') + '">' + escapeHtml(rate) + '</span>',
    };
  }

  function breakerStat(record, threshold) {
    if (!record) return '<span class="stat-empty">-</span>';
    if (typeof record.windowFailures === 'number') {
      var rate = record.windowFailureRate == null ? '-' : (record.windowFailureRate * 100).toFixed(1) + '%';
      return '<div class="stat-breaker"><span class="mono">S ' + escapeHtml(record.windowSuccesses) +
        ' / F ' + escapeHtml(record.windowFailures) + ' · ' + escapeHtml(rate) + '</span>' +
        (record.disableCooldown ? '<span>No breaker · 额度/人工仍生效</span>' : '') + '</div>';
    }
    var consecutiveFailures = statCount(record.failureCount);
    var parsedThreshold = Number(threshold);
    var thresholdLabel = Number.isFinite(parsedThreshold) && parsedThreshold >= 0 ? parsedThreshold : '-';
    var probes = statCount(record.halfOpenProbeInFlight);
    var quotaCount = statCount(record.quotaFailureCount);
    return '<div class="stat-breaker">' + stateBadge(record.state) +
      '<span class="stat-breaker-count mono" title="Consecutive failures / threshold to open the breaker (resets to 0 on any success)">consec ' + escapeHtml(consecutiveFailures) + '/' + escapeHtml(thresholdLabel) + '</span>' +
      (quotaCount > 0 ? '<span class="stat-quota-count mono" title="Total quota-exhaustion failures since proxy start">quota&times;' + escapeHtml(quotaCount) + '</span>' : '') +
      (probes > 0 ? '<span class="stat-probe" title="Half-open probe requests in flight">probe&times;' + escapeHtml(probes) + '</span>' : '') +
      '</div>';
  }

  function aggregateStats(records) {
    if (!records || records.length === 0) {
      return requestStats(null);
    }
    var summed = records.reduce(function(acc, record) {
      acc.successCount += statCount(record && record.successCount);
      acc.totalFailures += statCount(record && record.totalFailures);
      return acc;
    }, { successCount: 0, totalFailures: 0 });
    return requestStats(summed);
  }

  function modelName(canonicalModel) {
    var value = canonicalModel == null ? '' : String(canonicalModel);
    var compactVersion = '';
    var model = value;
    if (value.startsWith('compact-v2:')) {
      compactVersion = 'v2';
      model = value.slice('compact-v2:'.length);
    } else if (value.startsWith('compact:')) {
      compactVersion = 'v1';
      model = value.slice('compact:'.length);
    }
    if (!compactVersion) return escapeHtml(value);
    return '<span class="stat-compact-label"><span class="stat-compact-tag"><span class="stat-compact-dot"></span>compact ' +
      compactVersion + '</span><span class="stat-compact-separator">&middot;</span><span>' + escapeHtml(model) + '</span></span>';
  }

  function channelMetaById(data) {
    var meta = {};
    (data.configuredChannelDetails || []).forEach(function(channel) {
      if (channel && channel.id) {
        meta[channel.id] = { id: channel.id, name: channel.name || channel.id };
      }
    });
    (data.configuredChannels || []).forEach(function(channelId) {
      if (!meta[channelId]) {
        meta[channelId] = { id: channelId, name: channelId };
      }
    });
    return meta;
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
      ['Active requests', data.activeRequests, 'In flight right now'],
      ['Total requests', stats.requestsTotal, 'Since this instance started'],
      ['JSON responses', stats.responsesJson, 'Non-streaming responses'],
      ['SSE responses', (stats.responsesSseNormalized || 0) + (stats.responsesSseRaw || 0), 'Normalized + raw streams'],
      ['Fallbacks / retries', data.breakerControlAvailable ? (stats.channelSwitches || 0) + ' / ' + (stats.sameChannelRetries || 0) : fallbackTotal(stats), 'Channel switches / same-channel retries'],
      ['Response cache', (stats.cacheHits || 0) + ' / ' + (stats.cacheMisses || 0), 'Hits / misses'],
      ['HTTP errors', (stats.errors4xx || 0) + ' / ' + (stats.errors5xx || 0), 'Client 4xx / server 5xx'],
      ['Last updated', new Date().toLocaleTimeString(), 'Refreshes every second'],
    ];
    cardsEl.innerHTML = cards.map(function(card) {
      return '<div class="card"><div class="card-label">' + escapeHtml(card[0]) + '</div><div class="card-value">' + escapeHtml(card[1]) + '</div><div class="card-note">' + escapeHtml(card[2]) + '</div></div>';
    }).join('');
    document.getElementById('monitor-instance').textContent = data.instanceName || 'Proxy instance';
    document.getElementById('monitor-route-count').textContent = (data.configuredModelRoutes || []).length + ' models';
    document.getElementById('monitor-channel-count').textContent = (data.configuredChannels || []).length + ' channels';
  }

  function findModelChannelHealth(snapshot, channelId, canonicalModel) {
    return (snapshot.modelChannels || []).find(function(r) {
      return r.channelId === channelId && r.canonicalModel === canonicalModel;
    });
  }

  function chipClassForState(state) {
    if (state === 'closed') return 'route-chip-ok';
    if (state === 'half_open') return 'route-chip-warn';
    if (state === 'open') return 'route-chip-bad';
    return '';
  }

  function dotClassForState(state) {
    if (state === 'closed') return 'route-chip-dot-ok';
    if (state === 'half_open') return 'route-chip-dot-warn';
    if (state === 'open') return 'route-chip-dot-bad';
    return 'route-chip-dot-unknown';
  }

  function renderRoutes(data) {
    var focusedModel = routeBody.contains(document.activeElement) ? document.activeElement.getAttribute('data-model-toggle') : null;
    var routes = data.configuredModelRoutes || [];
    var snapshot = data.healthSnapshot || { channels: [], modelChannels: [] };
    var meta = channelMetaById(data);
    var html = '';
    for (var ri = 0; ri < routes.length; ri += 1) {
      var route = routes[ri];
      var channelIds = route.channelIds || [];
      var canonicalModel = route.canonicalModel;
      var expanded = expandedModels[canonicalModel] === true;
      var chips = '';
      for (var ci = 0; ci < channelIds.length; ci += 1) {
        var channelId = channelIds[ci];
        var mc = findModelChannelHealth(snapshot, channelId, canonicalModel);
        var channelHealth = channelQuotaRecord(snapshot, channelId);
        var state = effectiveState(mc, channelHealth);
        var quotaSeconds = channelQuotaRemaining(snapshot, channelId);
        var chipState = quotaSeconds > 0 ? 'quota' : state;
        var chipClass = quotaSeconds > 0 ? 'route-chip-quota' : chipClassForState(state);
        var dotClass = quotaSeconds > 0 ? 'route-chip-dot-quota' : dotClassForState(state);
        var chipTitle = quotaSeconds > 0 ? ' title="quota exhausted cooldown ' + escapeHtml(fmtQuotaRemaining(quotaSeconds)) + '"' : '';
        var details = meta[channelId] || { id: channelId, name: channelId };
        var displayName = (details.name && details.name !== channelId) ? details.name : channelId;
        chips += '<span class="route-chip ' + chipClass + '" data-route-model="' + escapeHtml(canonicalModel) + '"' + chipTitle + '>' +
          '<span class="route-chip-dot ' + dotClass + '"></span>' +
          '<span class="route-index">' + escapeHtml(ci + 1) + '</span>' +
          escapeHtml(displayName) +
          '</span>';
      }
      html += '<tr class="route-row" data-route-model="' + escapeHtml(canonicalModel) + '" style="cursor:pointer">' +
        '<td class="mono"><button type="button" class="route-toggle" data-model-toggle="' + escapeHtml(canonicalModel) + '" aria-expanded="' + expanded + '">' + escapeHtml(canonicalModel) + '</button></td>' +
        '<td><div class="route-chips">' + chips + '</div></td>' +
        '</tr>';
      if (expanded) {
        var detailCells = '';
        for (var di = 0; di < channelIds.length; di += 1) {
          var dChannelId = channelIds[di];
          var dMc = findModelChannelHealth(snapshot, dChannelId, canonicalModel);
          var dDetails = meta[dChannelId] || { id: dChannelId, name: dChannelId };
          var dState = dMc ? effectiveState(dMc, channelQuotaRecord(snapshot, dChannelId)) : 'idle';
          var dStats = requestStats(dMc);
          detailCells += '<div class="route-detail-grid">' +
            '<div><div class="rd-name">' + escapeHtml(dDetails.name || dChannelId) + '</div>' +
            '<div class="rd-id">' + escapeHtml(dChannelId) + '</div></div>' +
            '<div><div>' + stateBadge(dState === 'idle' ? null : dState) + '</div>' + quotaBadge(channelQuotaRecord(snapshot, dChannelId)) + manualBadge(channelQuotaRecord(snapshot, dChannelId)) + '</div>' +
            '<div>' + dStats.attempts + '</div>' +
            '<div>' + dStats.split + '</div>' +
            '<div>' + dStats.rate + '</div>' +
            '<div>' + breakerStat(dMc, data.modelChannelFailureThreshold) + '</div>' +
            '<div>' + cooldown(dMc) + '</div>' +
            '<div class="reason" title="' + escapeHtml((dMc && dMc.lastFailureReason) || '-') + '">' + escapeHtml((dMc && dMc.lastFailureReason) || '-') + '</div>' +
            '</div>';
        }
        var header = '<div class="route-detail-header">' +
          '<div>Channel</div>' +
          '<div title="Current circuit-breaker state">State</div>' +
          '<div title="Total upstream attempts since proxy start (successes + failures), never resets">Requests</div>' +
          '<div title="Cumulative successes / failures since proxy start; neither count resets">S / F</div>' +
          '<div title="Cumulative success percentage since proxy start">Rate</div>' +
          '<div title="Circuit breaker: consecutive failures / threshold; resets on any success">Breaker</div>' +
          '<div title="Seconds until an open circuit may enter half-open state">Cooldown</div>' +
          '<div title="Most recent failure reason">Reason</div></div>';
        html += '<tr class="route-detail-row"><td colspan="2">' +
          (channelIds.length > 0 ? header + detailCells : '<div class="empty-state">No channels configured for this model.</div>') +
          '</td></tr>';
      }
    }
    routeBody.innerHTML = html || '<tr><td colspan="2"><div class="empty-state">No model routes configured.</div></td></tr>';
    if (focusedModel !== null) {
      routeBody.querySelectorAll('[data-model-toggle]').forEach(function(button) {
        if (button.dataset.modelToggle === focusedModel) button.focus({ preventScroll: true });
      });
    }
  }

  function modelChildren(snapshot, channelId) {
    return (snapshot.modelChannels || []).filter(function(record) {
      return record.channelId === channelId;
    });
  }

  function renderModelChildren(records, threshold, channel) {
    if (records.length === 0) {
      return '<div class="empty-state">No configured model children.</div>';
    }
    var header = '<div class="stat-model-child-header">' +
      '<div>Model</div>' +
      '<div title="Current circuit-breaker state">State</div>' +
      '<div title="Total upstream attempts since proxy start (successes + failures), never resets">Requests</div>' +
      '<div title="Cumulative successes / failures since proxy start; neither count resets">S / F</div>' +
      '<div title="Cumulative success percentage since proxy start">Rate</div>' +
      '<div title="Sliding-window successes / failures and failure rate">Breaker</div>' +
      '<div title="Seconds until automatic cooldown expires">Cooldown</div>' +
      '<div title="Most recent failure reason">Reason</div></div>';
    return header + records.map(function(record) {
      var stats = requestStats(record);
      return '<div class="model-child">' +
        '<div class="model-name mono">' + modelName(record.canonicalModel) + '</div>' +
        '<div>' + stateBadge(effectiveState(record, channel)) + '</div>' +
        '<div>' + stats.attempts + '</div>' +
        '<div>' + stats.split + '</div>' +
        '<div>' + stats.rate + '</div>' +
        '<div>' + breakerStat(record, threshold) + '</div>' +
        '<div>' + escapeHtml(cooldown(record)) + '</div>' +
        '<div class="reason" title="' + escapeHtml(record.lastFailureReason || '-') + '">' + escapeHtml(record.lastFailureReason || '-') + '</div>' +
        '</div>';
    }).join('');
  }

  function renderChannels(data) {
    if (controllingChannel) return;
    var focusedControl = channelBody.contains(document.activeElement) && document.activeElement.dataset.breakerAction
      ? { channel: document.activeElement.dataset.breakerChannel, action: document.activeElement.dataset.breakerAction } : null;
    var focusedChannel = channelBody.contains(document.activeElement) ? document.activeElement.getAttribute('data-channel-id') : null;
    var snapshot = data.healthSnapshot || { channels: [], modelChannels: [] };
    var meta = channelMetaById(data);
    channelBody.innerHTML = (snapshot.channels || []).map(function(channel) {
      var channelId = channel.channelId;
      var details = meta[channelId] || { id: channelId, name: channelId };
      var children = modelChildren(snapshot, channelId);
      var expanded = expandedChannels[channelId] === true;
      var toggleText = expanded ? 'Collapse' : 'Expand';
      var stats = data.breakerControlAvailable ? requestStats(channel) : aggregateStats(children);
      return '<tr class="channel-row">' +
        '<td class="stat-col-channel"><div class="stat-channel-cell"><button type="button" class="toggle-button" data-channel-id="' + escapeHtml(channelId) + '" aria-expanded="' + expanded + '" aria-label="' + toggleText + ' ' + escapeHtml(channelId) + '">' + (expanded ? '−' : '+') + '</button>' +
        '<div class="channel-title"><span class="channel-id mono">' + escapeHtml(channelId) + '</span><span class="channel-name">' + escapeHtml(details.name) + '</span></div></div></td>' +
        '<td><div>' + stateBadge(effectiveState(channel, channel)) + '</div>' + quotaBadge(channel) + manualBadge(channel) + '</td>' +
        '<td>' + stats.attempts + '</td>' +
        '<td>' + stats.split + '</td>' +
        '<td>' + stats.rate + '</td>' +
        '<td>' + breakerStat(channel, data.channelFailureThreshold) + '</td>' +
        '<td>' + escapeHtml(cooldown(channel)) + '</td>' +
        '<td class="reason" title="' + escapeHtml(channel.lastFailureReason || '-') + '">' + escapeHtml(channel.lastFailureReason || '-') + '</td>' +
        '<td>' + escapeHtml(fmtTime(channel.lastSuccessAt)) +
        (data.breakerControlAvailable ? '<div class="breaker-actions"><button type="button" class="danger" data-breaker-action="open" data-breaker-channel="' + escapeHtml(channelId) + '" aria-label="立即熔断 ' + escapeHtml(channelId) + '">立即熔断</button>' +
          '<button type="button" data-breaker-action="close" data-breaker-channel="' + escapeHtml(channelId) + '" aria-label="立即恢复 ' + escapeHtml(channelId) + '">立即恢复</button></div>' : '') + '</td>' +
        '</tr>' +
        '<tr class="model-row"' + (expanded ? '' : ' hidden') + '><td colspan="9"><div class="model-children">' + renderModelChildren(children, data.modelChannelFailureThreshold, channel) + '</div></td></tr>';
    }).join('') || '<tr><td colspan="9"><div class="empty-state">No channel health records yet.</div></td></tr>';
    if (focusedChannel !== null) {
      channelBody.querySelectorAll('[data-channel-id]').forEach(function(button) {
        if (button.dataset.channelId === focusedChannel) button.focus({ preventScroll: true });
      });
    }
    if (focusedControl) channelBody.querySelectorAll('[data-breaker-action]').forEach(function(button) {
      if (button.dataset.breakerChannel === focusedControl.channel && button.dataset.breakerAction === focusedControl.action) button.focus({ preventScroll: true });
    });
  }

  function renderTrend() {
    var peak = Math.max(0, ...samples.map(function(sample) {
      return sample.activeRequests || 0;
    }));
    var max = Math.max(1, peak);
    trendBars.innerHTML = samples.map(function(sample) {
      var active = sample.activeRequests || 0;
      var height = Math.max(2, Math.round((active / max) * 112));
      return '<span style="height:' + height + 'px" title="active=' + active + '"></span>';
    }).join('');
    document.getElementById('trend-peak').textContent = 'Peak ' + peak;
    document.getElementById('trend-empty').hidden = peak > 0;
    document.getElementById('trend-start').textContent = samples.length + ' / 60 samples';
    trendBars.setAttribute('aria-label', samples.length + ' recent samples; peak ' + peak + ' active requests');
  }

  async function poll() {
    if (document.hidden) return;
    try {
      var response = await fetch('/admin/monitor/stats', { cache: 'no-store' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var body = await response.json();
      var policyEl = document.getElementById('breaker-policy');
      if (policyEl) {
        policyEl.hidden = !body.breakerControlAvailable;
        policyEl.textContent = '窗口 ' + (body.healthWindowMs / 1000) + 's：失败 ≥ ' + body.healthFailureThreshold +
          ' 且失败率 > ' + (body.healthFailureRateThreshold * 100) + '% → 熔断 ' + (body.healthCooldownMs / 60000) +
          ' 分钟；每渠道最多 ' + body.channelMaxAttempts + ' 次。人工恢复会清除额度冷却和失败窗口。';
      }
      document.getElementById('usage-nav').hidden = body.usageAvailable !== true;
      samples.push(body);
      if (samples.length > 60) samples.shift();
      renderCards(body);
      renderRoutes(body);
      renderChannels(body);
      renderTrend();
      statusEl.textContent = 'Last updated ' + new Date().toLocaleTimeString();
      statusEl.className = '';
    } catch (error) {
      statusEl.textContent = 'Monitor error: ' + error.message;
      statusEl.className = 'error';
    }
  }

  function toggleChannel(channelId) {
    expandedChannels[channelId] = expandedChannels[channelId] !== true;
    if (samples.length > 0) {
      renderChannels(samples[samples.length - 1]);
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
  channelBody.addEventListener('click', async function(event) {
    var target = event.target;
    if (!target || !target.closest) return;
    var control = target.closest('[data-breaker-action]');
    if (control) {
      if (controllingChannel) return;
      var channel = samples[samples.length - 1].healthSnapshot.channels.find(function(entry) { return entry.channelId === control.dataset.breakerChannel; });
      if (!channel) return;
      controllingChannel = channel.channelId;
      control.disabled = true;
      try {
        var response = await fetch('/admin/channels/breaker', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channelId: channel.channelId, fingerprint: channel.fingerprint, action: control.dataset.breakerAction }) });
        var result = await response.json();
        if (!response.ok || !result.ok) throw new Error((result.error && result.error.message) || 'HTTP ' + response.status);
        controllingChannel = null;
        await poll();
        statusEl.textContent = channel.channelId + (control.dataset.breakerAction === 'open' ? ' 已立即熔断' : ' 已恢复，重新遵循自动规则');
      } catch (error) {
        statusEl.textContent = '操作失败：' + error.message;
        statusEl.className = 'error';
      } finally { controllingChannel = null; control.disabled = false; }
      return;
    }
    var button = target.closest('button[data-channel-id]');
    if (!button) return;
    var channelId = button.getAttribute('data-channel-id');
    if (!channelId) return;
    toggleChannel(channelId);
  });
  routeBody.addEventListener('click', function(event) {
    var target = event.target;
    if (!target || !target.closest) return;
    var row = target.closest('tr.route-row');
    if (!row) return;
    var model = row.getAttribute('data-route-model');
    if (!model) return;
    expandedModels[model] = expandedModels[model] !== true;
    if (samples.length > 0) {
      renderRoutes(samples[samples.length - 1]);
    }
  });
  schedule();
})();
