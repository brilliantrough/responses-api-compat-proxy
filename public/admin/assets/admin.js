(function() {
  var statusEl = document.getElementById('status');
  var dirtyBadge = document.getElementById('dirty-badge');
  var restartNotice = document.getElementById('restart-notice');
  var validationResult = document.getElementById('validation-result');
  var actionResult = document.getElementById('action-result');
  var instanceSummary = document.getElementById('instance-summary');
  var topbarRuntimeVersion = document.getElementById('topbar-runtime-version');
  var topbarActiveRequests = document.getElementById('topbar-active-requests');
  var defaultModelInput = document.getElementById('default-model-input');
  var compactEnabledInput = document.getElementById('compact-enabled');
  var compactModelInput = document.getElementById('compact-model-input');
  var compactModelOptions = document.getElementById('compact-model-options');
  var compactRouteEditor = document.getElementById('compact-route-editor');
  var compactDetectionSummary = document.getElementById('compact-detection-summary');
  var compactDetectionUnavailable = document.getElementById('compact-detection-unavailable');
  var compactDetecting = document.getElementById('compact-detecting');
  var compactDetectButton = document.getElementById('btn-detect-compact');

  var serverConfig = null;
  var serverMeta = null;
  var draftEnv = [];
  var draftDefaultModel = '';
  var draftChannels = [];
  var draftModels = [];
  var draftCompact = null;
  var draftAliases = {};
  var compactDetection = null;
  var compactDetectionAvailable = null;
  var compactDetectionTimer = null;
  var dirty = false;
  var selectedModelIdx = 0;

  var views = {
    channels: ['Channels', 'Connect your providers. Build a resilient gateway.'],
    models: ['Model routing', 'The right model. The right path. Every request.'],
    compact: ['Compaction', 'Give long conversations room to continue.'],
    aliases: ['Aliases', 'Simple names. Flexible connections.'],
    environment: ['Environment', 'Fine-tune how your gateway runs.'],
    runtime: ['Runtime', 'Your instance, as it is configured right now.'],
  };

  function showView() {
    var view = window.location.hash.slice(1);
    if (!Object.prototype.hasOwnProperty.call(views, view)) view = 'channels';
    document.querySelectorAll('.config-view').forEach(function(section) {
      section.hidden = section.id !== view;
    });
    document.querySelectorAll('[data-view]').forEach(function(link) {
      var active = link.dataset.view === view;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    document.getElementById('page-title').textContent = views[view][0];
    document.getElementById('page-breadcrumb').textContent = views[view][0];
    document.getElementById('page-description').textContent = views[view][1];
    document.title = views[view][0] + ' · Relay';
    window.scrollTo(0, 0);
  }

  function renderDraftSummary() {
    document.getElementById('summary-channels').textContent = draftChannels.length;
    document.getElementById('summary-models').textContent = draftModels.length;
    document.getElementById('summary-aliases').textContent = Object.keys(draftAliases).length;
    document.getElementById('summary-default').textContent = draftDefaultModel || 'Not set';
    document.getElementById('nav-channel-count').textContent = draftChannels.length;
    document.getElementById('nav-model-count').textContent = draftModels.length;
    document.getElementById('channel-count').textContent = draftChannels.length;
  }

  function filterChannels() {
    var query = document.getElementById('channel-search').value.trim().toLowerCase();
    var shown = 0;
    document.querySelectorAll('#channels-table .channel-row').forEach(function(row, index) {
      var channel = draftChannels[index];
      row.hidden = [channel.id, channel.name, channel.baseUrl].join(' ').toLowerCase().indexOf(query) < 0;
      if (!row.hidden) shown += 1;
    });
    document.getElementById('channel-search-empty').hidden = shown > 0 || draftChannels.length === 0;
    document.getElementById('channel-count').textContent = query ? shown + ' / ' + draftChannels.length : draftChannels.length;
  }

  function filterEnvironment() {
    var query = document.getElementById('env-search').value.trim().toLowerCase();
    var shown = 0;
    document.querySelectorAll('#primary-table tbody tr').forEach(function(row) {
      row.hidden = row.firstElementChild.textContent.toLowerCase().indexOf(query) < 0;
      if (!row.hidden) shown += 1;
    });
    document.getElementById('env-search-empty').hidden = shown > 0;
  }

  var COMPACT_CHANNEL_PICKERS = [
    { containerId: 'compact-channel-picker', channelKey: 'channelIds', protocol: 'v1' },
    { containerId: 'compact-v2-channel-picker', channelKey: 'v2ChannelIds', protocol: 'v2' },
  ];

  var RUNTIME_KEYS = [
    'PORT', 'HOST', 'INSTANCE_NAME', 'PROXY_STREAM_MODE',
    'PROXY_UPSTREAM_TIMEOUT_MS', 'PROXY_NON_STREAM_TIMEOUT_MS',
    'PROXY_TOTAL_REQUEST_TIMEOUT_MS', 'PROXY_MAX_CONCURRENT_REQUESTS',
    'PROXY_FORCE_STORE_FALSE', 'PROXY_CONVERT_SYSTEM_TO_DEVELOPER',
    'PROXY_PROMPT_CACHE_RETENTION', 'PROXY_PROMPT_CACHE_KEY',
    'PROXY_CLAUDE_BILLING_HEADER_MODE'
  ];

  function esc(value) {
    var div = document.createElement('div');
    div.textContent = value;
    return div.innerHTML;
  }

  function appendHelperText(container, text) {
    if (!text) return;
    var helperEl = document.createElement('div');
    helperEl.className = 'field-helper';
    helperEl.textContent = text;
    container.appendChild(helperEl);
  }

  function createFieldStack(control, helperText) {
    var stack = document.createElement('div');
    stack.className = 'field-stack';
    stack.appendChild(control);
    appendHelperText(stack, helperText);
    return stack;
  }

  function setStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.className = isError ? 'notice notice-error' : 'notice notice-info';
  }

  function setDirty(nextDirty) {
    dirty = nextDirty;
    dirtyBadge.style.display = nextDirty ? 'inline-block' : 'none';
    dirtyBadge.className = nextDirty ? 'badge badge-dirty' : 'badge badge-ok';
    renderDraftSummary();
    filterChannels();
  }

  function getEnvValue(key) {
    var envArr = (serverConfig && serverConfig.env) || [];
    var entry = envArr.filter(function(item) { return item.key === key; })[0];
    return entry ? entry.value : '';
  }

  function showRestartNotice(fields) {
    if (fields && fields.length > 0) {
      var hasPortHost = fields.some(function(field) { return field === 'PORT' || field === 'HOST'; });
      restartNotice.style.display = 'block';
      restartNotice.className = hasPortHost ? 'notice notice-warning notice-restart' : 'notice notice-error';
      restartNotice.textContent = hasPortHost
        ? 'Restart required: ' + fields.join(', ') + ' changed. Restart the proxy process for these to take effect.'
        : 'Fields changed: ' + fields.join(', ');
    } else {
      restartNotice.style.display = 'none';
    }
  }

  function appendOverviewField(container, label, value) {
    var group = document.createElement('div');
    group.className = 'field-group';
    var labelEl = document.createElement('label');
    labelEl.textContent = label;
    var input = document.createElement('input');
    input.readOnly = true;
    input.value = value == null ? '' : String(value);
    group.appendChild(labelEl);
    group.appendChild(input);
    container.appendChild(group);
  }

  function renderTopbarSummary() {
    if (!serverConfig || !serverMeta) return;
    var instanceName = getEnvValue('INSTANCE_NAME') || 'Unknown instance';
    var host = getEnvValue('HOST');
    var port = getEnvValue('PORT');
    var address = [host, port ? ':' + port : ''].filter(Boolean).join('');
    instanceSummary.textContent = [instanceName, address].filter(Boolean).join('  /  ');
    var activeRequests = typeof serverMeta.activeRequests === 'number' ? serverMeta.activeRequests : '-';
    topbarRuntimeVersion.textContent = 'Runtime ' + (serverMeta.runtimeVersion || '-');
    topbarActiveRequests.textContent = 'Active ' + activeRequests;
  }

  function renderOverview() {
    document.getElementById('ov-version').value = serverMeta.runtimeVersion || '-';
    document.getElementById('ov-restart').value = (serverMeta.restartRequiredFields || []).join(', ') || '(none)';
    var info = document.getElementById('ov-instance-info');
    info.textContent = '';
    var inst = (serverConfig.env || []).filter(function(entry) { return entry.key === 'INSTANCE_NAME'; })[0];
    var port = (serverConfig.env || []).filter(function(entry) { return entry.key === 'PORT'; })[0];
    if (inst) appendOverviewField(info, 'Instance', inst.value);
    if (port) appendOverviewField(info, 'Port', port.value);
  }

  function renderEnvTable() {
    var tbody = document.querySelector('#primary-table tbody');
    tbody.innerHTML = '';
    var envArr = serverConfig.env || [];
    var rollingPolicy = envArr.some(function(entry) { return entry.key === 'PROXY_HEALTH_WINDOW_MS'; });
    var policyHelp = {
      PROXY_HEALTH_WINDOW_MS: '滑动窗口毫秒；默认 180000（3 分钟）。',
      PROXY_HEALTH_FAILURE_THRESHOLD: '窗口内失败至少达到此次数，且失败率超限才熔断。按真实上游尝试计数。',
      PROXY_HEALTH_FAILURE_RATE_THRESHOLD: '失败 /（成功 + 失败）严格大于此值；默认 0.5。',
      PROXY_HEALTH_COOLDOWN_MS: '普通与人工熔断时长，毫秒；默认 600000（10 分钟）。',
      PROXY_CHANNEL_MAX_ATTEMPTS: '每个请求、每个渠道的总尝试上限，包含首次；默认 3。',
      PROXY_CHANNEL_RETRY_DELAY_MS: '同渠道两次尝试之间的等待毫秒；默认 500，额度耗尽直接换渠道。',
      PROXY_CACHE_KEY_POOL_SIZE: '最近使用的 cache key 历史池容量；不覆盖渠道优先级。',
      PROXY_QUOTA_COOLDOWN_MS: '额度耗尽冷却毫秒；No breaker 仍生效，可在 Overview 立即恢复。',
    };
    for (var i = 0; i < envArr.length; i += 1) {
      var envEntry = envArr[i];
      var draftEntry = draftEnv.filter(function(entry) { return entry.key === envEntry.key; })[0];
      if (!draftEntry) continue;

      var row = document.createElement('tr');
      var keyCell = document.createElement('td');
      keyCell.textContent = envEntry.key;
      row.appendChild(keyCell);

      var valueCell = document.createElement('td');
      var control;
      if (envEntry.secret) {
        control = document.createElement('input');
        control.type = 'password';
        control.placeholder = '*** (masked)';
        control.value = '';
        control.dataset.key = envEntry.key;
        control.addEventListener('input', function() {
          var key = this.dataset.key;
          for (var j = 0; j < draftEnv.length; j += 1) {
            if (draftEnv[j].key === key) {
              draftEnv[j].secretAction = this.value ? 'replace' : 'keep';
              draftEnv[j].value = this.value || undefined;
              break;
            }
          }
          checkDirty();
        });
      } else if (envEntry.key === 'PROXY_CLAUDE_BILLING_HEADER_MODE') {
        control = document.createElement('select');
        ['strip_line', 'strip_cch'].forEach(function(mode) {
          var option = document.createElement('option');
          option.value = mode;
          option.textContent = mode;
          if ((draftEntry.value || 'strip_line') === mode) option.selected = true;
          control.appendChild(option);
        });
        control.dataset.key = envEntry.key;
        control.addEventListener('change', function() {
          var key = this.dataset.key;
          for (var j = 0; j < draftEnv.length; j += 1) {
            if (draftEnv[j].key === key) {
              draftEnv[j].value = this.value;
              break;
            }
          }
          checkDirty();
        });
      } else {
        control = document.createElement('input');
        control.type = 'text';
        control.value = draftEntry.value || '';
        control.dataset.key = envEntry.key;
        control.addEventListener('input', function() {
          var key = this.dataset.key;
          for (var j = 0; j < draftEnv.length; j += 1) {
            if (draftEnv[j].key === key) {
              draftEnv[j].value = this.value;
              break;
            }
          }
          checkDirty();
        });
      }
      control.setAttribute('aria-label', envEntry.key);
      var legacy = rollingPolicy && /^(PROXY_CHANNEL_COOLDOWN_MS|PROXY_MODEL_CHANNEL_COOLDOWN_MS|PROXY_CHANNEL_FAILURE_THRESHOLD|PROXY_MODEL_CHANNEL_FAILURE_THRESHOLD|PROXY_HALF_OPEN_MAX_PROBES)$/.test(envEntry.key);
      valueCell.appendChild(createFieldStack(control, legacy ? '旧参数已停用；请使用 PROXY_HEALTH_*。' : policyHelp[envEntry.key] || ''));
      row.appendChild(valueCell);

      var secretCell = document.createElement('td');
      secretCell.textContent = envEntry.secret ? 'Yes' : 'No';
      row.appendChild(secretCell);
      tbody.appendChild(row);
    }
    filterEnvironment();
  }

  function renderDefaultModel() {
    defaultModelInput.value = draftDefaultModel;
  }

  function renderChannels() {
    var tbody = document.querySelector('#channels-table tbody');
    tbody.innerHTML = '';
    if (draftChannels.length === 0) {
      var emptyRow = document.createElement('tr');
      var emptyCell = document.createElement('td');
      emptyCell.colSpan = 6;
      emptyCell.className = 'loading';
      emptyCell.textContent = 'No channels in the current draft.';
      emptyRow.appendChild(emptyCell);
      tbody.appendChild(emptyRow);
      return;
    }

    for (var i = 0; i < draftChannels.length; i += 1) {
      (function(index) {
        var channel = draftChannels[index];
        var row = document.createElement('tr');
        row.className = 'channel-row';

        var idCell = document.createElement('td');
        var idInput = document.createElement('input');
        idInput.type = 'text';
        idInput.value = channel.id;
        idInput.dataset.idx = String(index);
        idInput.addEventListener('input', function() {
          draftChannels[Number(this.dataset.idx)].id = this.value;
          renderModelRoutes();
          renderCompactRoute();
          checkDirty();
        });
        idCell.appendChild(createFieldStack(idInput, 'Stable channel id.'));
        row.appendChild(idCell);

        var nameCell = document.createElement('td');
        var nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.value = channel.name || '';
        nameInput.dataset.idx = String(index);
        nameInput.addEventListener('input', function() {
          draftChannels[Number(this.dataset.idx)].name = this.value;
          renderModelRoutes();
          renderCompactRoute();
          checkDirty();
        });
        nameCell.appendChild(createFieldStack(nameInput, 'Optional display name.'));
        row.appendChild(nameCell);

        var baseUrlCell = document.createElement('td');
        var baseUrlInput = document.createElement('input');
        baseUrlInput.type = 'text';
        baseUrlInput.value = channel.baseUrl;
        baseUrlInput.dataset.idx = String(index);
        baseUrlInput.addEventListener('input', function() {
          draftChannels[Number(this.dataset.idx)].baseUrl = this.value;
          checkDirty();
        });
        baseUrlCell.appendChild(createFieldStack(baseUrlInput, 'Channel base URL.'));
        row.appendChild(baseUrlCell);

        var keyCell = document.createElement('td');
        var keyWrap = document.createElement('div');
        keyWrap.className = 'channel-key-wrap';
        var toggleRow = document.createElement('div');
        toggleRow.className = 'toggle-row';
        ['keep', 'replace'].forEach(function(action) {
          var button = document.createElement('button');
          button.type = 'button';
          button.className = channel.apiKeyAction === action ? 'primary' : '';
          button.textContent = action;
          button.dataset.idx = String(index);
          button.dataset.action = action;
          button.addEventListener('click', function() {
            var idx = Number(this.dataset.idx);
            draftChannels[idx].apiKeyAction = this.dataset.action;
            if (this.dataset.action === 'keep') {
              draftChannels[idx].apiKeyValue = undefined;
            }
            renderChannels();
            checkDirty();
          });
          toggleRow.appendChild(button);
        });
        keyWrap.appendChild(toggleRow);

        if (channel.apiKeyAction === 'replace') {
          var keyInput = document.createElement('input');
          keyInput.type = 'password';
          keyInput.placeholder = 'new api key';
          keyInput.value = channel.apiKeyValue || '';
          keyInput.dataset.idx = String(index);
          keyInput.addEventListener('input', function() {
            draftChannels[Number(this.dataset.idx)].apiKeyValue = this.value;
            checkDirty();
          });
          keyWrap.appendChild(createFieldStack(keyInput, 'Enter a replacement key.'));
        } else {
          var masked = document.createElement('div');
          masked.className = 'masked-secret';
          masked.textContent = '•••••••• · kept';
          keyWrap.appendChild(masked);
        }
        keyCell.appendChild(keyWrap);
        row.appendChild(keyCell);

        var breakerCell = document.createElement('td');
        var breakerLabel = document.createElement('label');
        breakerLabel.className = 'breaker-toggle';
        var breakerInput = document.createElement('input');
        breakerInput.type = 'checkbox';
        breakerInput.checked = channel.disableCooldown === true;
        breakerInput.dataset.idx = String(index);
        breakerInput.addEventListener('change', function() {
          draftChannels[Number(this.dataset.idx)].disableCooldown = this.checked;
          checkDirty();
        });
        breakerLabel.appendChild(breakerInput);
        breakerLabel.appendChild(document.createTextNode(' No breaker'));
        breakerCell.appendChild(breakerLabel);
        row.appendChild(breakerCell);

        var actionCell = document.createElement('td');
        var actions = document.createElement('div');
        actions.className = 'row-actions';
        var deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'danger icon-button';
        deleteButton.textContent = 'Delete';
        deleteButton.dataset.idx = String(index);
        deleteButton.addEventListener('click', function() {
          draftChannels.splice(Number(this.dataset.idx), 1);
          renderChannels();
          renderModelRoutes();
          renderCompactRoute();
          checkDirty();
        });
        actions.appendChild(deleteButton);
        actionCell.appendChild(actions);
        row.appendChild(actionCell);

        ['Channel ID', 'Display name', 'Base URL', 'API key', 'Circuit breaker', 'Actions'].forEach(function(label, cellIndex) {
          var cell = row.children[cellIndex];
          cell.dataset.label = label;
          cell.querySelectorAll('input').forEach(function(input) {
            input.setAttribute('aria-label', label + ' · ' + channel.id);
          });
        });
        tbody.appendChild(row);
      })(i);
    }
    filterChannels();
  }

  function getRouteChannelLabel(channelId) {
    for (var i = 0; i < draftChannels.length; i += 1) {
      if (draftChannels[i].id === channelId) {
        return {
          id: channelId,
          name: draftChannels[i].name || '',
          missing: false,
        };
      }
    }
    return { id: channelId, name: '', missing: true };
  }

  function appendChannelIdentity(container, channelInfo) {
    var name = document.createElement('span');
    name.className = 'route-channel-name cname';
    name.textContent = channelInfo.name || channelInfo.id || '(blank id)';
    container.appendChild(name);

    if (channelInfo.name && channelInfo.id) {
      var id = document.createElement('span');
      id.className = 'route-channel-id cid';
      id.textContent = channelInfo.id;
      container.appendChild(id);
    }

    if (channelInfo.missing) {
      var missing = document.createElement('span');
      missing.className = 'route-channel-id cid';
      missing.textContent = 'missing channel';
      container.appendChild(missing);
    }
  }

  function updateRouteChannels(routeIndex, channelIds) {
    draftModels[routeIndex].channelIds = channelIds.slice();
    renderModelRoutes();
    checkDirty();
  }

  function enableRouteSorting(container, list, channelIds, onChange) {
    var rows = Array.from(list.querySelectorAll('.route-selected-item'));
    var drag = null;
    var frame = null;
    list.setAttribute('role', 'list');

    function move(from, to) {
      if (from === to) return;
      var ids = channelIds.slice();
      ids.splice(to, 0, ids.splice(from, 1)[0]);
      var scrollTop = list.scrollTop;
      onChange(ids);
      container.querySelector('.route-selected-list').scrollTop = scrollTop;
    }

    function clearDrag() {
      if (!drag) return;
      var pointerId = drag.pointerId;
      drag = null;
      cancelAnimationFrame(frame);
      rows.forEach(function(row) { row.classList.remove('sorting', 'drop-before', 'drop-after'); });
      if (list.hasPointerCapture(pointerId)) list.releasePointerCapture(pointerId);
    }

    function preview() {
      if (!drag) return;
      if (!list.isConnected || !list.getClientRects().length) { clearDrag(); return; }
      var bounds = list.getBoundingClientRect();
      var inside = drag.x >= bounds.left && drag.x <= bounds.right && drag.y >= bounds.top && drag.y <= bounds.bottom;
      rows.forEach(function(row) { row.classList.remove('drop-before', 'drop-after'); });
      drag.to = drag.from;
      if (inside && drag.moved) {
        if (drag.y < Math.max(bounds.top, 0) + 28) list.scrollTop -= 8;
        if (drag.y > Math.min(bounds.bottom, window.innerHeight) - 28) list.scrollTop += 8;
        var boundary = rows.findIndex(function(row) {
          var rect = row.getBoundingClientRect();
          return drag.y < rect.top + rect.height / 2;
        });
        if (boundary < 0) boundary = rows.length;
        drag.to = boundary > drag.from ? boundary - 1 : boundary;
        if (drag.to !== drag.from) {
          (rows[boundary] || rows[rows.length - 1]).classList.add(boundary === rows.length ? 'drop-after' : 'drop-before');
        }
      }
      frame = requestAnimationFrame(preview);
    }

    rows.forEach(function(row, index) {
      row.setAttribute('role', 'listitem');
      var handle = document.createElement('button');
      handle.type = 'button';
      handle.className = 'route-drag-handle';
      handle.textContent = '⠿';
      handle.title = 'Drag to reorder · Arrow keys move · Home / End';
      handle.setAttribute('aria-label', 'Reorder ' + channelIds[index] + ', priority ' + (index + 1));
      handle.addEventListener('pointerdown', function(event) {
        if (event.button !== 0 || !event.isPrimary) return;
        drag = { from: index, to: index, pointerId: event.pointerId, x: event.clientX, y: event.clientY, startY: event.clientY, moved: false };
        list.setPointerCapture(event.pointerId);
        row.classList.add('sorting');
        preview();
      });
      handle.addEventListener('keydown', function(event) {
        var target = { ArrowUp: index - 1, ArrowDown: index + 1, Home: 0, End: rows.length - 1 }[event.key];
        if (target === undefined) return;
        event.preventDefault();
        target = Math.max(0, Math.min(rows.length - 1, target));
        move(index, target);
        container.querySelectorAll('.route-drag-handle')[target].focus();
      });
      row.prepend(handle);
    });
    list.addEventListener('pointermove', function(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      drag.x = event.clientX;
      drag.y = event.clientY;
      drag.moved = drag.moved || Math.abs(drag.y - drag.startY) > 4;
    });
    list.addEventListener('pointerup', function(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      drag.x = event.clientX;
      drag.y = event.clientY;
      cancelAnimationFrame(frame);
      preview();
      if (!drag) return;
      var from = drag.from;
      var to = drag.to;
      clearDrag();
      move(from, to);
    });
    list.addEventListener('pointercancel', clearDrag);
    list.addEventListener('lostpointercapture', clearDrag);
    list.addEventListener('keydown', function(event) {
      if (event.key === 'Escape') clearDrag();
    });
  }

  function renderModelRoutes() {
    var container = document.getElementById('model-routes-list');
    container.innerHTML = '';
    renderCompactModelOptions();

    if (draftModels.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'loading';
      empty.textContent = 'No model routes. Click "+ Add Route" to create one.';
      container.appendChild(empty);
      return;
    }

    if (selectedModelIdx >= draftModels.length) {
      selectedModelIdx = draftModels.length - 1;
    }

    var split = document.createElement('div');
    split.className = 'route-split';

    var sidebar = document.createElement('div');
    sidebar.className = 'route-sidebar';

    var sidebarList = document.createElement('div');
    sidebarList.className = 'route-sidebar-list';

    for (var i = 0; i < draftModels.length; i += 1) {
      (function(index) {
        var item = document.createElement('button');
        item.type = 'button';
        item.className = 'route-sidebar-item' + (index === selectedModelIdx ? ' active' : '');
        item.setAttribute('aria-pressed', String(index === selectedModelIdx));
        item.textContent = draftModels[index].canonicalModel || '(unnamed)';
        var count = document.createElement('span');
        count.className = 'route-sidebar-count';
        count.textContent = String(draftModels[index].channelIds.length);
        item.appendChild(count);
        item.addEventListener('click', function() {
          selectedModelIdx = index;
          renderModelRoutes();
        });
        sidebarList.appendChild(item);
      })(i);
    }
    sidebar.appendChild(sidebarList);

    var sidebarActions = document.createElement('div');
    sidebarActions.className = 'route-sidebar-actions';
    var addButton = document.createElement('button');
    addButton.type = 'button';
    addButton.textContent = '+ Add Route';
    addButton.addEventListener('click', function() {
      draftModels.push({ canonicalModel: 'new-model-' + Date.now(), channelIds: [] });
      selectedModelIdx = draftModels.length - 1;
      renderModelRoutes();
      checkDirty();
    });
    sidebarActions.appendChild(addButton);
    sidebar.appendChild(sidebarActions);
    split.appendChild(sidebar);

    var route = draftModels[selectedModelIdx];
    var detail = document.createElement('div');
    detail.className = 'route-detail';

    var header = document.createElement('div');
    header.className = 'route-detail-header';
    var modelInput = document.createElement('input');
    modelInput.type = 'text';
    modelInput.value = route.canonicalModel;
    modelInput.placeholder = 'Canonical model name';
    modelInput.setAttribute('aria-label', 'Canonical model name');
    modelInput.addEventListener('input', function() {
      draftModels[selectedModelIdx].canonicalModel = this.value;
      document.querySelector('.route-sidebar-item.active').firstChild.textContent = this.value || '(unnamed)';
      renderCompactModelOptions();
      checkDirty();
    });
    header.appendChild(modelInput);

    var deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'danger';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', function() {
      draftModels.splice(selectedModelIdx, 1);
      if (selectedModelIdx >= draftModels.length) {
        selectedModelIdx = Math.max(0, draftModels.length - 1);
      }
      renderModelRoutes();
      checkDirty();
    });
    header.appendChild(deleteBtn);
    detail.appendChild(header);

    var body = document.createElement('div');
    body.className = 'route-detail-body';

    var selectedCol = document.createElement('div');
    selectedCol.className = 'route-detail-selected';
    var selectedTitle = document.createElement('h4');
    selectedTitle.textContent = 'Fallback order · drag ⠿ to reorder';
    selectedCol.appendChild(selectedTitle);

    var selectedList = document.createElement('div');
    selectedList.className = 'route-selected-list';

    if (route.channelIds.length === 0) {
      var emptySelected = document.createElement('div');
      emptySelected.className = 'route-empty-selected';
      emptySelected.textContent = 'No channels in route. Add from the right.';
      selectedList.appendChild(emptySelected);
    } else {
      route.channelIds.forEach(function(channelId, position) {
        var channelInfo = getRouteChannelLabel(channelId);
        var item = document.createElement('div');
        item.className = 'route-selected-item';

        var num = document.createElement('span');
        num.className = 'route-selected-number';
        num.textContent = String(position + 1);
        item.appendChild(num);

        var nameDiv = document.createElement('div');
        nameDiv.className = 'route-selected-name';
        var cname = document.createElement('span');
        cname.className = 'cname';
        cname.textContent = channelInfo.name || channelInfo.id || '(blank)';
        nameDiv.appendChild(cname);
        if (channelInfo.name && channelInfo.id && channelInfo.name !== channelInfo.id) {
          var cid = document.createElement('span');
          cid.className = 'cid';
          cid.textContent = channelInfo.id;
          nameDiv.appendChild(cid);
        }
        if (channelInfo.missing) {
          var missing = document.createElement('span');
          missing.className = 'cid';
          missing.style.color = 'var(--status-error)';
          missing.textContent = 'missing';
          nameDiv.appendChild(missing);
        }
        item.appendChild(nameDiv);

        var actions = document.createElement('div');
        actions.className = 'route-selected-actions';

        var upBtn = document.createElement('button');
        upBtn.type = 'button';
        upBtn.textContent = '\u2191';
        upBtn.setAttribute('aria-label', 'Move channel up');
        upBtn.disabled = position === 0;
        upBtn.dataset.position = String(position);
        upBtn.addEventListener('click', function() {
          var p = Number(this.dataset.position);
          var ids = draftModels[selectedModelIdx].channelIds.slice();
          var moved = ids.splice(p, 1)[0];
          ids.splice(p - 1, 0, moved);
          draftModels[selectedModelIdx].channelIds = ids;
          renderModelRoutes();
          checkDirty();
        });
        actions.appendChild(upBtn);

        var downBtn = document.createElement('button');
        downBtn.type = 'button';
        downBtn.textContent = '\u2193';
        downBtn.setAttribute('aria-label', 'Move channel down');
        downBtn.disabled = position === route.channelIds.length - 1;
        downBtn.dataset.position = String(position);
        downBtn.addEventListener('click', function() {
          var p = Number(this.dataset.position);
          var ids = draftModels[selectedModelIdx].channelIds.slice();
          var moved = ids.splice(p, 1)[0];
          ids.splice(p + 1, 0, moved);
          draftModels[selectedModelIdx].channelIds = ids;
          renderModelRoutes();
          checkDirty();
        });
        actions.appendChild(downBtn);

        var rmBtn = document.createElement('button');
        rmBtn.type = 'button';
        rmBtn.textContent = '\u00d7';
        rmBtn.setAttribute('aria-label', 'Remove channel from route');
        rmBtn.dataset.position = String(position);
        rmBtn.addEventListener('click', function() {
          var p = Number(this.dataset.position);
          var ids = draftModels[selectedModelIdx].channelIds.slice();
          ids.splice(p, 1);
          draftModels[selectedModelIdx].channelIds = ids;
          renderModelRoutes();
          checkDirty();
        });
        actions.appendChild(rmBtn);

        item.appendChild(actions);
        selectedList.appendChild(item);
      });
    }
    var routeIndex = selectedModelIdx;
    enableRouteSorting(container, selectedList, route.channelIds, function(ids) { updateRouteChannels(routeIndex, ids); });
    selectedCol.appendChild(selectedList);
    body.appendChild(selectedCol);

    var availableCol = document.createElement('div');
    availableCol.className = 'route-detail-available';
    var availableTitle = document.createElement('h4');
    availableTitle.textContent = 'Available channels';
    availableCol.appendChild(availableTitle);

    var availableList = document.createElement('div');
    availableList.className = 'route-available-list';
    var availableCount = 0;

    draftChannels.forEach(function(channel) {
      if (!channel.id || route.channelIds.indexOf(channel.id) >= 0) return;
      availableCount += 1;
      var item = document.createElement('div');
      item.className = 'route-available-item';

      var nameDiv = document.createElement('div');
      nameDiv.className = 'route-available-name';
      var cname = document.createElement('span');
      cname.className = 'cname';
      cname.textContent = channel.name || channel.id;
      nameDiv.appendChild(cname);
      if (channel.name && channel.id && channel.name !== channel.id) {
        var cid = document.createElement('span');
        cid.className = 'cid';
        cid.textContent = channel.id;
        nameDiv.appendChild(cid);
      }
      item.appendChild(nameDiv);

      var addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'route-available-add';
      addBtn.textContent = '+ Add';
      addBtn.dataset.channelId = channel.id;
      addBtn.addEventListener('click', function() {
        draftModels[selectedModelIdx].channelIds.push(this.dataset.channelId);
        renderModelRoutes();
        checkDirty();
      });
      item.appendChild(addBtn);
      availableList.appendChild(item);
    });

    if (availableCount === 0) {
      var emptyAvailable = document.createElement('div');
      emptyAvailable.className = 'route-empty-available';
      emptyAvailable.textContent = 'All channels are in this route.';
      availableList.appendChild(emptyAvailable);
    }
    availableCol.appendChild(availableList);
    body.appendChild(availableCol);

    detail.appendChild(body);
    split.appendChild(detail);
    container.appendChild(split);
  }

  function getCompactDetectionResult(channelId, protocol) {
    if (!compactDetection || !compactDetection.results) return null;
    for (var i = 0; i < compactDetection.results.length; i += 1) {
      if (compactDetection.results[i].channelId === channelId && compactDetection.results[i].protocol === protocol) {
        return compactDetection.results[i];
      }
    }
    return null;
  }

  function appendCompactStatusBadge(container, channelId, protocol) {
    var result = getCompactDetectionResult(channelId, protocol);
    var status = result ? result.status : 'unknown';
    var label;
    var tone;

    switch (status) {
      case 'supported':
        label = '\u2713 compact';
        tone = 'supported';
        break;
      case 'unsupported_route':
        label = '\u2715 no endpoint';
        tone = 'error';
        break;
      case 'model_unsupported':
        label = '! model';
        tone = 'warning';
        break;
      case 'auth_failed':
        label = 'auth';
        tone = 'error';
        break;
      case 'timeout':
        label = 'timeout';
        tone = 'muted';
        break;
      case 'error':
        label = 'error';
        tone = 'muted';
        break;
      case 'bridge_only':
        label = '~ bridge';
        tone = 'warning';
        break;
      default:
        label = 'unknown';
        tone = 'unknown';
        break;
    }

    var badge = document.createElement('span');
    badge.className = 'compact-status compact-status-' + tone;
    badge.textContent = protocol + ' ' + label;
    if (status === 'bridge_only') {
      badge.title = 'accepts request but returns plain-message bridge, codex clients may fail';
    } else if (result && result.detail) {
      badge.title = result.detail;
    }
    container.appendChild(badge);
  }

  function appendCompactStatusBadges(container, channelId) {
    if (compactDetectionAvailable !== true) return;
    var badges = document.createElement('div');
    badges.className = 'compact-status-group';
    appendCompactStatusBadge(badges, channelId, 'v1');
    appendCompactStatusBadge(badges, channelId, 'v2');
    container.appendChild(badges);
  }

  function formatDetectionAge(timestamp) {
    var completedAt = timestamp < 1000000000000 ? timestamp * 1000 : timestamp;
    var elapsedSeconds = Math.max(0, Math.floor((Date.now() - completedAt) / 1000));
    if (elapsedSeconds < 60) return 'just now';
    var minutes = Math.floor(elapsedSeconds / 60);
    if (minutes < 60) return minutes + 'm ago';
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    return Math.floor(hours / 24) + 'd ago';
  }

  function renderCompactDetection() {
    var inProgress = compactDetectionAvailable === true && compactDetection && compactDetection.inProgress === true;
    compactDetecting.hidden = !inProgress;
    compactDetectButton.disabled = Boolean(inProgress);

    if (compactDetectionAvailable === false) {
      compactDetectionSummary.hidden = true;
      compactDetectionUnavailable.hidden = false;
      return;
    }

    compactDetectionUnavailable.hidden = true;
    if (compactDetectionAvailable !== true || !compactDetection) {
      compactDetectionSummary.hidden = true;
      return;
    }

    var results = compactDetection.results || [];
    var v1Supported = results.filter(function(result) { return result.protocol === 'v1' && result.status === 'supported'; }).length;
    var v2Supported = results.filter(function(result) { return result.protocol === 'v2' && result.status === 'supported'; }).length;
    var summary = 'v1: ' + v1Supported + '/' + draftChannels.length + ' supported · v2: ' + v2Supported + '/' + draftChannels.length + ' supported';
    if (compactDetection.model) summary += ' (model ' + compactDetection.model + ')';
    summary += compactDetection.lastCompletedAt
      ? ' · detected ' + formatDetectionAge(compactDetection.lastCompletedAt)
      : ' · not detected yet';
    compactDetectionSummary.textContent = summary;
    compactDetectionSummary.hidden = false;
  }

  function renderCompactModelOptions() {
    compactModelOptions.innerHTML = '';
    var seen = {};
    draftModels.forEach(function(route) {
      if (!route.canonicalModel || seen[route.canonicalModel]) return;
      seen[route.canonicalModel] = true;
      var option = document.createElement('option');
      option.value = route.canonicalModel;
      compactModelOptions.appendChild(option);
    });
  }

  function updateCompactChannels(picker, channelIds) {
    if (!draftCompact) return;
    draftCompact[picker.channelKey] = channelIds.slice();
    renderCompactChannelPicker(picker);
    checkDirty();
  }

  function renderCompactChannelPicker(picker) {
    var container = document.getElementById(picker.containerId);
    container.innerHTML = '';
    if (!draftCompact) return;
    var channelIds = draftCompact[picker.channelKey];

    var body = document.createElement('div');
    body.className = 'route-detail-body compact-route-picker';

    var selectedCol = document.createElement('div');
    selectedCol.className = 'route-detail-selected';
    var selectedTitle = document.createElement('h4');
    selectedTitle.textContent = 'Fallback order · drag ⠿ to reorder';
    selectedCol.appendChild(selectedTitle);

    var selectedList = document.createElement('div');
    selectedList.className = 'route-selected-list';
    if (channelIds.length === 0) {
      var emptySelected = document.createElement('div');
      emptySelected.className = 'route-empty-selected';
      emptySelected.textContent = 'No ' + picker.protocol + ' compact channels selected. Add from the right.';
      selectedList.appendChild(emptySelected);
    } else {
      channelIds.forEach(function(channelId, position) {
        var channelInfo = getRouteChannelLabel(channelId);
        var item = document.createElement('div');
        item.className = 'route-selected-item';

        var number = document.createElement('span');
        number.className = 'route-selected-number';
        number.textContent = String(position + 1);
        item.appendChild(number);

        var name = document.createElement('div');
        name.className = 'route-selected-name';
        appendChannelIdentity(name, channelInfo);
        item.appendChild(name);
        appendCompactStatusBadges(item, channelId);

        var actions = document.createElement('div');
        actions.className = 'route-selected-actions';

        var upButton = document.createElement('button');
        upButton.type = 'button';
        upButton.textContent = '\u2191';
        upButton.title = 'Move ' + picker.protocol + ' compact channel up';
        upButton.setAttribute('aria-label', 'Move ' + picker.protocol + ' compact channel up');
        upButton.disabled = position === 0;
        upButton.dataset.position = String(position);
        upButton.addEventListener('click', function() {
          var nextPosition = Number(this.dataset.position);
          var ids = draftCompact[picker.channelKey].slice();
          var moved = ids.splice(nextPosition, 1)[0];
          ids.splice(nextPosition - 1, 0, moved);
          updateCompactChannels(picker, ids);
        });
        actions.appendChild(upButton);

        var downButton = document.createElement('button');
        downButton.type = 'button';
        downButton.textContent = '\u2193';
        downButton.title = 'Move ' + picker.protocol + ' compact channel down';
        downButton.setAttribute('aria-label', 'Move ' + picker.protocol + ' compact channel down');
        downButton.disabled = position === channelIds.length - 1;
        downButton.dataset.position = String(position);
        downButton.addEventListener('click', function() {
          var nextPosition = Number(this.dataset.position);
          var ids = draftCompact[picker.channelKey].slice();
          var moved = ids.splice(nextPosition, 1)[0];
          ids.splice(nextPosition + 1, 0, moved);
          updateCompactChannels(picker, ids);
        });
        actions.appendChild(downButton);

        var removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.textContent = '\u00d7';
        removeButton.title = 'Remove ' + picker.protocol + ' compact channel';
        removeButton.setAttribute('aria-label', 'Remove ' + picker.protocol + ' compact channel');
        removeButton.dataset.position = String(position);
        removeButton.addEventListener('click', function() {
          var nextPosition = Number(this.dataset.position);
          var ids = draftCompact[picker.channelKey].slice();
          ids.splice(nextPosition, 1);
          updateCompactChannels(picker, ids);
        });
        actions.appendChild(removeButton);

        item.appendChild(actions);
        selectedList.appendChild(item);
      });
    }
    enableRouteSorting(container, selectedList, channelIds, function(ids) { updateCompactChannels(picker, ids); });
    selectedCol.appendChild(selectedList);
    body.appendChild(selectedCol);

    var availableCol = document.createElement('div');
    availableCol.className = 'route-detail-available';
    var availableTitle = document.createElement('h4');
    availableTitle.textContent = 'Available channels';
    availableCol.appendChild(availableTitle);

    var availableList = document.createElement('div');
    availableList.className = 'route-available-list';
    var availableCount = 0;
    draftChannels.forEach(function(channel) {
      if (!channel.id) return;
      availableCount += 1;
      var item = document.createElement('div');
      item.className = 'route-available-item';

      var option = document.createElement('label');
      option.className = 'compact-channel-option';
      var checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = channelIds.indexOf(channel.id) >= 0;
      checkbox.dataset.channelId = channel.id;
      checkbox.addEventListener('change', function() {
        var ids = draftCompact[picker.channelKey].slice();
        var existingIndex = ids.indexOf(this.dataset.channelId);
        if (this.checked && existingIndex < 0) {
          ids.push(this.dataset.channelId);
        } else if (!this.checked && existingIndex >= 0) {
          ids.splice(existingIndex, 1);
        }
        updateCompactChannels(picker, ids);
      });
      option.appendChild(checkbox);

      var name = document.createElement('div');
      name.className = 'route-available-name';
      appendChannelIdentity(name, getRouteChannelLabel(channel.id));
      option.appendChild(name);
      item.appendChild(option);
      appendCompactStatusBadges(item, channel.id);
      availableList.appendChild(item);
    });

    if (availableCount === 0) {
      var emptyAvailable = document.createElement('div');
      emptyAvailable.className = 'route-empty-available';
      emptyAvailable.textContent = 'No channels in the current draft.';
      availableList.appendChild(emptyAvailable);
    }
    availableCol.appendChild(availableList);
    body.appendChild(availableCol);
    container.appendChild(body);
  }

  function renderCompactChannelPickers() {
    COMPACT_CHANNEL_PICKERS.forEach(renderCompactChannelPicker);
  }

  function renderCompactRoute() {
    var enabled = draftCompact !== null;
    compactEnabledInput.checked = enabled;
    compactRouteEditor.hidden = !enabled;
    renderCompactModelOptions();
    compactModelInput.value = enabled ? draftCompact.model : '';
    renderCompactChannelPickers();
    renderCompactDetection();
  }

  function renderAliases() {
    var container = document.getElementById('aliases-list');
    container.innerHTML = '';
    var keys = Object.keys(draftAliases);
    if (keys.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'loading';
      empty.textContent = 'No aliases in the current draft.';
      container.appendChild(empty);
      return;
    }

    for (var i = 0; i < keys.length; i += 1) {
      (function(alias) {
        var row = document.createElement('div');
        row.className = 'mapping-row';

        var aliasCol = document.createElement('div');
        aliasCol.className = 'mapping-col';
        var aliasInput = document.createElement('input');
        aliasInput.type = 'text';
        aliasInput.value = alias;
        aliasInput.setAttribute('aria-label', 'Client-facing alias');
        aliasInput.dataset.alias = alias;
        aliasInput.addEventListener('input', function() {
          var original = this.dataset.alias;
          var nextAlias = this.value;
          var target = draftAliases[original];
          delete draftAliases[original];
          draftAliases[nextAlias] = target;
          this.dataset.alias = nextAlias;
          targetInput.dataset.alias = nextAlias;
          deleteButton.dataset.alias = nextAlias;
          checkDirty();
        });
        aliasCol.appendChild(aliasInput);
        appendHelperText(aliasCol, 'Client-facing alias.');
        row.appendChild(aliasCol);

        var arrow = document.createElement('div');
        arrow.className = 'mapping-arrow';
        arrow.textContent = '\u2192';
        row.appendChild(arrow);

        var targetCol = document.createElement('div');
        targetCol.className = 'mapping-col';
        var targetInput = document.createElement('input');
        targetInput.type = 'text';
        targetInput.value = draftAliases[alias];
        targetInput.setAttribute('aria-label', 'Canonical model target');
        targetInput.dataset.alias = alias;
        targetInput.addEventListener('input', function() {
          draftAliases[this.dataset.alias] = this.value;
          checkDirty();
        });
        targetCol.appendChild(targetInput);
        appendHelperText(targetCol, 'Canonical model target.');
        row.appendChild(targetCol);

        var actions = document.createElement('div');
        actions.className = 'row-actions';
        var deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'danger icon-button';
        deleteButton.textContent = '\u00d7';
        deleteButton.setAttribute('aria-label', 'Delete alias');
        deleteButton.dataset.alias = alias;
        deleteButton.addEventListener('click', function() {
          delete draftAliases[this.dataset.alias];
          renderAliases();
          checkDirty();
        });
        actions.appendChild(deleteButton);
        row.appendChild(actions);

        container.appendChild(row);
      })(keys[i]);
    }
  }

  function renderRuntime() {
    var tbody = document.querySelector('#runtime-table tbody');
    tbody.innerHTML = '';
    var envArr = serverConfig.env || [];
    for (var i = 0; i < envArr.length; i += 1) {
      var envEntry = envArr[i];
      if (RUNTIME_KEYS.indexOf(envEntry.key) < 0) continue;
      var row = document.createElement('tr');
      var keyCell = document.createElement('td');
      keyCell.textContent = envEntry.key;
      row.appendChild(keyCell);
      var valueCell = document.createElement('td');
      valueCell.textContent = envEntry.secret ? '***' : envEntry.value;
      row.appendChild(valueCell);
      tbody.appendChild(row);
    }
  }

  function render() {
    renderTopbarSummary();
    renderOverview();
    renderEnvTable();
    renderDefaultModel();
    renderChannels();
    renderModelRoutes();
    renderCompactRoute();
    renderAliases();
    renderRuntime();
    showRestartNotice(serverMeta.restartRequiredFields);
    setDirty(false);
  }

  function initDraft() {
    draftEnv = (serverConfig.env || []).map(function(envEntry) {
      var draft = { key: envEntry.key };
      if (envEntry.secret) {
        draft.secretAction = 'keep';
      } else {
        draft.value = envEntry.value;
      }
      return draft;
    });
    draftDefaultModel = serverConfig.defaultModel || '';
    draftChannels = (serverConfig.channels || []).map(function(channel) {
      return {
        id: channel.id,
        name: channel.name || '',
        baseUrl: channel.baseUrl,
        apiKeyAction: 'keep',
        disableCooldown: channel.disableCooldown === true,
      };
    });
    draftModels = (serverConfig.models || []).map(function(route) {
      return {
        canonicalModel: route.canonicalModel,
        channelIds: route.channelIds.slice(),
      };
    });
    draftCompact = serverConfig.compact ? {
      model: serverConfig.compact.model,
      channelIds: serverConfig.compact.channelIds.slice(),
      v2ChannelIds: (serverConfig.compact.v2ChannelIds || []).slice(),
    } : null;
    draftAliases = JSON.parse(JSON.stringify(serverConfig.aliases || {}));
  }

  function normalizeEnvForDirty(entry) {
    if (entry.secretAction) {
      var normalized = { key: entry.key, secretAction: entry.secretAction };
      if (entry.secretAction === 'replace' && entry.value !== undefined) {
        normalized.value = entry.value;
      }
      return normalized;
    }
    return { key: entry.key, value: entry.value };
  }

  function normalizeChannelForDirty(channel) {
    var normalized = { id: channel.id, name: channel.name || '', baseUrl: channel.baseUrl, apiKeyAction: channel.apiKeyAction, disableCooldown: channel.disableCooldown === true };
    if (channel.apiKeyAction === 'replace' && channel.apiKeyValue !== undefined) {
      normalized.apiKeyValue = channel.apiKeyValue;
    }
    return normalized;
  }

  function normalizeModelForDirty(route) {
    return {
      canonicalModel: route.canonicalModel,
      channelIds: route.channelIds.slice(),
    };
  }

  function normalizeCompactForDirty(compact) {
    if (!compact) return null;
    return {
      model: compact.model,
      channelIds: compact.channelIds.slice(),
      v2ChannelIds: (compact.v2ChannelIds || []).slice(),
    };
  }

  function checkDirty() {
    if (!serverConfig) return;
    var envChanged = JSON.stringify(draftEnv.map(normalizeEnvForDirty)) !== JSON.stringify((serverConfig.env || []).map(function(entry) {
      return entry.secret ? { key: entry.key, secretAction: 'keep' } : { key: entry.key, value: entry.value };
    }));
    var defaultModelChanged = draftDefaultModel !== (serverConfig.defaultModel || '');
    var channelsChanged = JSON.stringify(draftChannels.map(normalizeChannelForDirty)) !== JSON.stringify((serverConfig.channels || []).map(function(channel) {
      return { id: channel.id, name: channel.name || '', baseUrl: channel.baseUrl, apiKeyAction: 'keep', disableCooldown: channel.disableCooldown === true };
    }));
    var modelsChanged = JSON.stringify(draftModels.map(normalizeModelForDirty)) !== JSON.stringify((serverConfig.models || []).map(function(route) {
      return { canonicalModel: route.canonicalModel, channelIds: route.channelIds.slice() };
    }));
    var compactChanged = JSON.stringify(normalizeCompactForDirty(draftCompact)) !== JSON.stringify(normalizeCompactForDirty(serverConfig.compact));
    var aliasesChanged = JSON.stringify(draftAliases) !== JSON.stringify(serverConfig.aliases || {});
    setDirty(envChanged || defaultModelChanged || channelsChanged || modelsChanged || compactChanged || aliasesChanged);
  }

  function buildDraftPayload() {
    return {
      env: draftEnv.map(function(entry) {
        var payload = { key: entry.key };
        if (entry.secretAction) {
          payload.secretAction = entry.secretAction;
          if (entry.secretAction === 'replace' && entry.value !== undefined) payload.value = entry.value;
        } else {
          payload.value = entry.value;
        }
        return payload;
      }),
      defaultModel: draftDefaultModel,
      channels: draftChannels.map(function(channel) {
        var payload = {
          id: channel.id,
          name: channel.name,
          baseUrl: channel.baseUrl,
          apiKeyAction: channel.apiKeyAction,
          disableCooldown: channel.disableCooldown === true,
        };
        if (channel.apiKeyAction === 'replace' && channel.apiKeyValue !== undefined) {
          payload.apiKeyValue = channel.apiKeyValue;
        }
        return payload;
      }),
      models: draftModels.map(function(route) {
        return {
          canonicalModel: route.canonicalModel,
          channelIds: route.channelIds.slice(),
        };
      }),
      compact: normalizeCompactForDirty(draftCompact),
      aliases: JSON.parse(JSON.stringify(draftAliases)),
    };
  }

  function clearActionResult() {
    actionResult.textContent = '';
    actionResult.className = '';
  }

  function showActionResult(text, isError) {
    clearActionResult();
    actionResult.className = isError ? 'notice notice-error' : 'notice notice-success';
    actionResult.textContent = text;
  }

  function showValidationResult(body) {
    validationResult.innerHTML = '';
    if (body.valid) {
      var success = document.createElement('div');
      success.className = 'validation-result notice notice-success validation-valid';
      success.textContent = 'Draft is valid.';
      if (body.warnings && body.warnings.length > 0) {
        success.textContent += ' Warnings: ' + body.warnings.join('; ');
      }
      validationResult.appendChild(success);
      return;
    }

    var failure = document.createElement('div');
    failure.className = 'validation-result notice notice-error validation-invalid';
    failure.textContent = 'Validation errors:';
    var list = document.createElement('ul');
    list.className = 'validation-errors';
    (body.errors || []).forEach(function(error) {
      var item = document.createElement('li');
      item.textContent = error;
      list.appendChild(item);
    });
    failure.appendChild(list);
    validationResult.appendChild(failure);
  }

  function addChannel() {
    document.getElementById('channel-search').value = '';
    draftChannels.push({ id: 'new-channel-' + Date.now(), name: '', baseUrl: 'https://provider.example', apiKeyAction: 'replace', apiKeyValue: '', disableCooldown: false });
    renderChannels();
    renderModelRoutes();
    renderCompactRoute();
    checkDirty();
    var input = document.querySelector('#channels-table .channel-row:last-child input');
    input.focus();
    input.select();
  }

  function addModelRoute() {
    draftModels.push({ canonicalModel: 'new-model-' + Date.now(), channelIds: [] });
    selectedModelIdx = draftModels.length - 1;
    renderModelRoutes();
    checkDirty();
  }

  function addAlias() {
    var alias = 'new-alias-' + Date.now();
    draftAliases[alias] = '';
    renderAliases();
    checkDirty();
  }

  async function loadRuntimeStats() {
    try {
      var res = await fetch('/admin/stats');
      if (!res.ok) return;
      var data = await res.json();
      document.getElementById('usage-nav').hidden = data.usageAvailable !== true;
      if (typeof data.activeRequests === 'number') {
        serverMeta.activeRequests = data.activeRequests;
        renderTopbarSummary();
      }
    } catch (error) {
      void error;
    }
  }

  function clearCompactDetectionPoll() {
    if (compactDetectionTimer !== null) {
      window.clearTimeout(compactDetectionTimer);
      compactDetectionTimer = null;
    }
  }

  function scheduleCompactDetectionPoll() {
    clearCompactDetectionPoll();
    compactDetectionTimer = window.setTimeout(function() {
      compactDetectionTimer = null;
      loadCompactDetection();
    }, 3000);
  }

  async function loadCompactDetection() {
    try {
      var res = await fetch('/admin/compact/detection');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      if (!data.ok) throw new Error('Detection request failed');
      compactDetectionAvailable = true;
      compactDetection = data;
      renderCompactDetection();
      renderCompactChannelPickers();
      if (data.inProgress) {
        scheduleCompactDetectionPoll();
      } else {
        clearCompactDetectionPoll();
      }
    } catch (error) {
      void error;
      compactDetectionAvailable = false;
      compactDetection = null;
      clearCompactDetectionPoll();
      renderCompactDetection();
      renderCompactChannelPickers();
    }
  }

  async function detectCompactSupport() {
    compactDetectButton.disabled = true;
    try {
      var res = await fetch('/admin/compact/detect', { method: 'POST' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      if (!data.ok || data.started !== true) throw new Error('Detection did not start');
      compactDetectionAvailable = true;
      compactDetection = compactDetection || { model: null, lastCompletedAt: null, results: [] };
      compactDetection.inProgress = true;
      renderCompactDetection();
      scheduleCompactDetectionPoll();
    } catch (error) {
      void error;
      compactDetectionAvailable = false;
      compactDetection = null;
      clearCompactDetectionPoll();
      renderCompactDetection();
      renderCompactChannelPickers();
    }
  }

  async function loadConfig() {
    setStatus('Loading...');
    try {
      var res = await fetch('/admin/config');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      if (!data.ok) throw new Error((data.error && data.error.message) || 'Unknown error');
      serverConfig = data.config;
      serverMeta = { runtimeVersion: data.runtimeVersion, restartRequiredFields: data.restartRequiredFields || [], activeRequests: null };
      compactDetectionAvailable = null;
      compactDetection = null;
      clearCompactDetectionPoll();
      initDraft();
      render();
      await loadRuntimeStats();
      await loadCompactDetection();
      setStatus('Connected · configuration loaded');
    } catch (error) {
      setStatus('Error: ' + error.message, true);
    }
  }

  document.getElementById('default-model-input').addEventListener('input', function() {
    draftDefaultModel = this.value;
    checkDirty();
  });
  document.getElementById('btn-add-channel').addEventListener('click', addChannel);
  document.getElementById('btn-add-model-route').addEventListener('click', addModelRoute);
  document.getElementById('btn-add-alias').addEventListener('click', addAlias);
  compactEnabledInput.addEventListener('change', function() {
    if (this.checked) {
      draftCompact = {
        model: draftDefaultModel || (draftModels[0] ? draftModels[0].canonicalModel : ''),
        channelIds: [],
        v2ChannelIds: [],
      };
    } else {
      draftCompact = null;
    }
    renderCompactRoute();
    checkDirty();
  });
  compactModelInput.addEventListener('input', function() {
    if (!draftCompact) return;
    draftCompact.model = this.value;
    checkDirty();
  });
  compactDetectButton.addEventListener('click', detectCompactSupport);

  document.getElementById('btn-validate').addEventListener('click', async function() {
    validationResult.innerHTML = '<div class="loading">Validating...</div>';
    try {
      var res = await fetch('/admin/config/validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildDraftPayload()),
      });
      showValidationResult(await res.json());
    } catch (error) {
      validationResult.innerHTML = '<div class="validation-result notice notice-error validation-invalid">' + esc(error.message) + '</div>';
    }
  });

  document.getElementById('btn-save').addEventListener('click', async function() {
    clearActionResult();
    try {
      var res = await fetch('/admin/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildDraftPayload()),
      });
      var data = await res.json();
      if (data.ok) {
        showActionResult('Saved and reloaded (v' + data.runtimeVersion + ')', false);
        await loadConfig();
      } else {
        showActionResult('Save failed: ' + ((data.error && data.error.message) || 'Unknown error'), true);
      }
    } catch (error) {
      showActionResult('Save error: ' + error.message, true);
    }
  });

  document.getElementById('btn-reload').addEventListener('click', async function() {
    clearActionResult();
    try {
      var res = await fetch('/admin/config/reload', { method: 'POST' });
      var data = await res.json();
      if (data.ok) {
        showActionResult('Reloaded (v' + data.runtimeVersion + ')', false);
        await loadConfig();
      } else {
        showActionResult('Reload failed: ' + ((data.error && data.error.message) || 'Unknown error'), true);
      }
    } catch (error) {
      showActionResult('Reload error: ' + error.message, true);
    }
  });

  document.getElementById('btn-rollback').addEventListener('click', async function() {
    clearActionResult();
    try {
      var res = await fetch('/admin/config/rollback', { method: 'POST' });
      var data = await res.json();
      if (data.ok) {
        showActionResult('Rolled back. Restored: ' + (data.restored || []).join(', '), false);
        await loadConfig();
      } else {
        showActionResult('Rollback failed: ' + ((data.error && data.error.message) || 'Unknown error'), true);
      }
    } catch (error) {
      showActionResult('Rollback error: ' + error.message, true);
    }
  });

  window.addEventListener('hashchange', showView);
  document.getElementById('channel-search').addEventListener('input', filterChannels);
  document.getElementById('env-search').addEventListener('input', filterEnvironment);
  window.addEventListener('beforeunload', function(event) {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });
  showView();
  loadConfig();
})();
