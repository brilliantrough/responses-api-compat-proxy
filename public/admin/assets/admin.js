(function() {
  var statusEl = document.getElementById('status');
  var dirtyBadge = document.getElementById('dirty-badge');
  var restartNotice = document.getElementById('restart-notice');
  var validationResult = document.getElementById('validation-result');
  var actionResult = document.getElementById('action-result');
  var instanceSummary = document.getElementById('instance-summary');
  var topbarRuntimeVersion = document.getElementById('topbar-runtime-version');
  var topbarActiveRequests = document.getElementById('topbar-active-requests');

  var serverConfig = null;
  var serverMeta = null;
  var draftEnv = [];
  var draftFallback = [];
  var draftModelMappings = {};
  var dirty = false;
  var draggingFallbackIndex = -1;
  var armedFallbackDragIndex = -1;

  var RUNTIME_KEYS = [
    'PORT', 'HOST', 'INSTANCE_NAME', 'PROXY_STREAM_MODE',
    'PROXY_UPSTREAM_TIMEOUT_MS', 'PROXY_NON_STREAM_TIMEOUT_MS',
    'PROXY_TOTAL_REQUEST_TIMEOUT_MS', 'PROXY_MAX_CONCURRENT_REQUESTS',
    'PROXY_FORCE_STORE_FALSE', 'PROXY_CONVERT_SYSTEM_TO_DEVELOPER',
    'PROXY_PROMPT_CACHE_RETENTION', 'PROXY_PROMPT_CACHE_KEY',
    'PROXY_CLAUDE_BILLING_HEADER_MODE'
  ];

  function isSecret(key) {
    var u = key.toUpperCase();
    return u.indexOf('KEY') >= 0 || u.indexOf('TOKEN') >= 0 || u.indexOf('SECRET') >= 0;
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function appendHelperText(container, text) {
    if (!text) return;
    var helperEl = document.createElement('div');
    helperEl.className = 'field-helper';
    helperEl.textContent = text;
    container.appendChild(helperEl);
  }

  function getEnvHelperText(key) {
    var helpers = {
      PRIMARY_PROVIDER_BASE_URL: 'Base URL that must expose /v1/responses and /v1/models.',
      PRIMARY_PROVIDER_API_KEY: 'Stored in .env and masked in this UI.',
      PRIMARY_PROVIDER_DEFAULT_MODEL: 'Used as the default upstream model for quick testing.',
      PROXY_ENV_PATH: 'Admin reads and writes this .env file path.',
      FALLBACK_CONFIG_PATH: 'JSON file saved when fallback providers are updated.',
      MODEL_MAP_PATH: 'JSON file saved when model mappings are updated.',
      PROXY_CLAUDE_BILLING_HEADER_MODE: 'strip_line removes the whole Claude billing header line; strip_cch only removes the dynamic cch field.'
    };
    return helpers[key] || '';
  }

  function getFallbackHelperText(field) {
    var helpers = {
      name: 'Shown in stats and cooldown state.',
      baseUrl: 'Base URL used for /v1/responses and /v1/models.',
      apiKeyMode: 'env reads a variable name; inline stores a masked secret in config.',
      apiKeyEnv: 'Variable name read from .env at runtime.'
    };
    return helpers[field] || '';
  }

  function getModelMappingHelperText(kind) {
    if (kind === 'alias') return 'Client-facing model name accepted by the proxy.';
    if (kind === 'target') return 'Actual upstream model sent after mapping.';
    return '';
  }

  function createFieldStack(control, helperText) {
    var stack = document.createElement('div');
    stack.className = 'field-stack';
    stack.appendChild(control);
    appendHelperText(stack, helperText);
    return stack;
  }

  function removeFallbackProvider(index) {
    draftFallback.splice(index, 1);
    renderFallbackProviders();
    checkDirty();
  }

  function addFallbackProvider() {
    var suffix = Date.now();
    draftFallback.push({
      name: 'new-fallback-' + suffix,
      baseUrl: 'https://provider.example',
      apiKeyMode: 'env',
      apiKeyEnv: 'NEW_FALLBACK_API_KEY',
      disableCooldown: false,
      apiKeyConfigured: false,
      apiKeyMasked: null
    });
    renderFallbackProviders();
    setDirty(true);
  }

  function moveFallbackProvider(fromIndex, toIndex) {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return;
    var moved = draftFallback.splice(fromIndex, 1)[0];
    draftFallback.splice(toIndex, 0, moved);
    renderFallbackProviders();
    checkDirty();
  }

  function setStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.className = isError ? 'notice notice-error' : 'notice notice-info';
  }

  function setDirty(v) {
    dirty = v;
    dirtyBadge.style.display = v ? 'inline-block' : 'none';
    dirtyBadge.className = v ? 'badge badge-dirty' : 'badge badge-ok';
  }

  function normalizeFallbackForDirty(p) {
    var normalized = {
      name: p.name,
      baseUrl: p.baseUrl,
      apiKeyMode: p.apiKeyMode,
      apiKeyEnv: p.apiKeyMode === 'env' ? p.apiKeyEnv : undefined,
      disableCooldown: p.disableCooldown === true
    };
    if (p.apiKeyMode === 'inline') {
      normalized.secretAction = p.secretAction || 'keep';
    }
    return normalized;
  }

  function checkDirty() {
    if (!serverConfig) return;
    var origEnv = serverConfig.env.map(function(e) {
      if (e.secret || isSecret(e.key)) {
        return { key: e.key, secretAction: 'keep' };
      }
      return { key: e.key, value: e.value };
    });
    var curEnv = draftEnv.map(function(e) {
      if (e.secretAction || isSecret(e.key)) {
        return { key: e.key, secretAction: e.secretAction || 'keep' };
      }
      return { key: e.key, value: e.value };
    });
    var envChanged = JSON.stringify(curEnv) !== JSON.stringify(origEnv);
    var fbChanged = JSON.stringify(draftFallback.map(normalizeFallbackForDirty)) !== JSON.stringify(serverConfig.fallbackProviders.map(normalizeFallbackForDirty));
    var mmChanged = JSON.stringify(draftModelMappings) !== JSON.stringify(serverConfig.modelMappings);
    setDirty(envChanged || fbChanged || mmChanged);
  }

  function getEnvValue(key) {
    var envArr = (serverConfig && serverConfig.env) || [];
    var entry = envArr.filter(function(e) { return e.key === key; })[0];
    return entry ? entry.value : '';
  }

  function renderTopbarSummary() {
    if (!serverConfig || !serverMeta) return;
    var instanceName = getEnvValue('INSTANCE_NAME') || 'Unknown instance';
    var primaryProviderName = getEnvValue('PRIMARY_PROVIDER_NAME') || 'No provider';
    var host = getEnvValue('HOST');
    var port = getEnvValue('PORT');
    var address = [host, port ? ':' + port : ''].filter(Boolean).join('');
    instanceSummary.textContent = [instanceName, primaryProviderName, address].filter(Boolean).join(' | ');
    var activeRequests = typeof serverMeta.activeRequests === 'number' ? serverMeta.activeRequests : '-';
    topbarRuntimeVersion.textContent = 'Runtime ' + (serverMeta.runtimeVersion || '-');
    topbarActiveRequests.textContent = 'Active ' + activeRequests;
  }

  function showRestartNotice(fields) {
    if (fields && fields.length > 0) {
      var hasPortHost = fields.some(function(f) { return f === 'PORT' || f === 'HOST'; });
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

  function renderOverview() {
    document.getElementById('ov-version').value = serverMeta.runtimeVersion || '-';
    document.getElementById('ov-restart').value = (serverMeta.restartRequiredFields || []).join(', ') || '(none)';
    var info = document.getElementById('ov-instance-info');
    info.textContent = '';
    var envArr = serverConfig.env || [];
    var inst = envArr.filter(function(e) { return e.key === 'INSTANCE_NAME'; })[0];
    var port = envArr.filter(function(e) { return e.key === 'PORT'; })[0];
    if (inst) {
      appendOverviewField(info, 'Instance', inst.value);
    }
    if (port) {
      appendOverviewField(info, 'Port', port.value);
    }
  }

  function renderPrimaryProvider() {
    var tbody = document.querySelector('#primary-table tbody');
    tbody.innerHTML = '';
    var envArr = serverConfig.env || [];
    for (var i = 0; i < envArr.length; i++) {
      var e = envArr[i];
      var draftEntry = draftEnv.filter(function(d) { return d.key === e.key; })[0];
      if (!draftEntry) continue;
      var tr = document.createElement('tr');
      var tdKey = document.createElement('td');
      tdKey.textContent = e.key;
      tr.appendChild(tdKey);
      var tdVal = document.createElement('td');
      var input = document.createElement('input');
      if (e.secret) {
        input.type = 'password';
        input.placeholder = '*** (masked)';
        input.value = '';
        input.dataset.key = e.key;
        input.addEventListener('input', function() {
          var k = this.dataset.key;
          for (var j = 0; j < draftEnv.length; j++) {
            if (draftEnv[j].key === k) {
              if (this.value) {
                draftEnv[j].secretAction = 'replace';
                draftEnv[j].value = this.value;
              } else {
                draftEnv[j].secretAction = 'keep';
                delete draftEnv[j].value;
              }
              break;
            }
          }
          checkDirty();
        });
      } else if (e.key === 'PROXY_CLAUDE_BILLING_HEADER_MODE') {
        input = document.createElement('select');
        ['strip_line', 'strip_cch'].forEach(function(mode) {
          var opt = document.createElement('option');
          opt.value = mode;
          opt.textContent = mode;
          if ((draftEntry.value || 'strip_line') === mode) opt.selected = true;
          input.appendChild(opt);
        });
        input.dataset.key = e.key;
        input.addEventListener('change', function() {
          var k = this.dataset.key;
          for (var j = 0; j < draftEnv.length; j++) {
            if (draftEnv[j].key === k) {
              draftEnv[j].value = this.value;
              break;
            }
          }
          checkDirty();
        });
      } else {
        input.type = 'text';
        input.value = draftEntry.value || '';
        input.dataset.key = e.key;
        input.addEventListener('input', function() {
          var k = this.dataset.key;
          for (var j = 0; j < draftEnv.length; j++) {
            if (draftEnv[j].key === k) {
              draftEnv[j].value = this.value;
              break;
            }
          }
          checkDirty();
        });
      }
      tdVal.appendChild(createFieldStack(input, getEnvHelperText(e.key)));
      tr.appendChild(tdVal);
      var tdSecret = document.createElement('td');
      tdSecret.textContent = e.secret ? 'Yes' : 'No';
      tr.appendChild(tdSecret);
      tbody.appendChild(tr);
    }
  }

  function renderFallbackProviders() {
    var tbody = document.querySelector('#fallback-table tbody');
    tbody.innerHTML = '';
    if (draftFallback.length === 0) {
      var emptyTr = document.createElement('tr');
        var emptyTd = document.createElement('td');
        emptyTd.colSpan = 8;
      emptyTd.className = 'loading';
      emptyTd.textContent = 'No fallback providers in the current draft.';
      emptyTr.appendChild(emptyTd);
      tbody.appendChild(emptyTr);
      return;
    }
    for (var i = 0; i < draftFallback.length; i++) {
      (function(index) {
      var p = draftFallback[index];
      var tr = document.createElement('tr');
      tr.className = 'fallback-row';
      tr.setAttribute('draggable', 'true');
      tr.addEventListener('dragstart', function(event) {
        if (armedFallbackDragIndex !== index) {
          event.preventDefault();
          return;
        }
        draggingFallbackIndex = index;
        tr.classList.add('is-dragging');
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', String(index));
        }
      });
      tr.addEventListener('dragover', function(event) {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      });
      tr.addEventListener('drop', function(event) {
        event.preventDefault();
        moveFallbackProvider(draggingFallbackIndex, index);
      });
      tr.addEventListener('dragend', function() {
        draggingFallbackIndex = -1;
        armedFallbackDragIndex = -1;
        tr.classList.remove('is-dragging');
      });

      var tdMove = document.createElement('td');
      tdMove.className = 'drag-cell fallback-row-control';
      var handle = document.createElement('button');
      handle.type = 'button';
      handle.className = 'drag-handle';
      handle.textContent = '::';
      handle.title = 'Drag to reorder';
      handle.addEventListener('mousedown', function() {
        armedFallbackDragIndex = index;
      });
      handle.addEventListener('mouseup', function() {
        armedFallbackDragIndex = -1;
      });
      tdMove.appendChild(handle);
      tr.appendChild(tdMove);

      var tdName = document.createElement('td');
      tdName.className = 'fallback-row-main';
      var nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.value = p.name;
      nameInput.dataset.idx = index;
      nameInput.addEventListener('input', function() {
        draftFallback[parseInt(this.dataset.idx)].name = this.value;
        checkDirty();
      });
      tdName.appendChild(createFieldStack(nameInput, getFallbackHelperText('name')));
      tr.appendChild(tdName);

      var tdUrl = document.createElement('td');
      tdUrl.className = 'fallback-row-url';
      var urlInput = document.createElement('input');
      urlInput.type = 'text';
      urlInput.value = p.baseUrl;
      urlInput.dataset.idx = index;
      urlInput.addEventListener('input', function() {
        draftFallback[parseInt(this.dataset.idx)].baseUrl = this.value;
        checkDirty();
      });
      tdUrl.appendChild(createFieldStack(urlInput, getFallbackHelperText('baseUrl')));
      tr.appendChild(tdUrl);

      var tdMode = document.createElement('td');
      tdMode.className = 'fallback-row-compact';
      var modeSelect = document.createElement('select');
      ['env', 'inline', 'none'].forEach(function(m) {
        var opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        if (p.apiKeyMode === m) opt.selected = true;
        modeSelect.appendChild(opt);
      });
      modeSelect.dataset.idx = index;
      modeSelect.addEventListener('change', function() {
        var idx = parseInt(this.dataset.idx);
        draftFallback[idx].apiKeyMode = this.value;
        if (this.value !== 'inline') {
          draftFallback[idx].secretAction = undefined;
          draftFallback[idx].value = undefined;
        } else {
          draftFallback[idx].secretAction = 'keep';
        }
        renderFallbackProviders();
        checkDirty();
      });
      tdMode.appendChild(createFieldStack(modeSelect, getFallbackHelperText('apiKeyMode')));
      tr.appendChild(tdMode);

      var tdEnv = document.createElement('td');
      tdEnv.className = 'fallback-row-secret';
      if (p.apiKeyMode === 'env') {
        var envInput = document.createElement('input');
        envInput.type = 'text';
        envInput.value = p.apiKeyEnv || '';
        envInput.dataset.idx = index;
        envInput.addEventListener('input', function() {
          draftFallback[parseInt(this.dataset.idx)].apiKeyEnv = this.value;
          checkDirty();
        });
        tdEnv.appendChild(createFieldStack(envInput, getFallbackHelperText('apiKeyEnv')));
      } else if (p.apiKeyMode === 'inline') {
        var inlineStack = document.createElement('div');
        inlineStack.className = 'field-stack';
        var inlinePwd = document.createElement('input');
        inlinePwd.type = 'password';
        inlinePwd.placeholder = '*** (masked)';
        inlinePwd.value = '';
        inlinePwd.dataset.idx = index;
        inlinePwd.addEventListener('input', function() {
          var idx = parseInt(this.dataset.idx);
          if (this.value) {
            draftFallback[idx].secretAction = 'replace';
            draftFallback[idx].value = this.value;
          } else {
            draftFallback[idx].secretAction = 'keep';
            draftFallback[idx].value = undefined;
          }
          actionSel.value = draftFallback[idx].secretAction;
          checkDirty();
        });
        inlineStack.appendChild(inlinePwd);

        var actionSel = document.createElement('select');
        actionSel.className = 'inline-secret-action';
        ['keep', 'replace', 'clear'].forEach(function(a) {
          var opt = document.createElement('option');
          opt.value = a;
          opt.textContent = a;
          if ((p.secretAction || 'keep') === a) opt.selected = true;
          actionSel.appendChild(opt);
        });
        actionSel.dataset.idx = index;
        actionSel.addEventListener('change', function() {
          var idx = parseInt(this.dataset.idx);
          var action = this.value;
          draftFallback[idx].secretAction = action;
          if (action === 'keep') {
            draftFallback[idx].value = undefined;
          } else if (action === 'clear') {
            draftFallback[idx].value = undefined;
          }
          renderFallbackProviders();
          checkDirty();
        });
        var actionLabel = document.createElement('div');
        actionLabel.className = 'inline-secret-label';
        actionLabel.textContent = 'Action:';
        actionLabel.appendChild(actionSel);
        inlineStack.appendChild(actionLabel);
        appendHelperText(inlineStack, 'Inline mode keeps a masked secret in config until you save.');
        tdEnv.appendChild(inlineStack);
      } else {
        appendHelperText(tdEnv, 'No secret configured for this fallback row.');
      }
      tr.appendChild(tdEnv);

      var tdDisableCooldown = document.createElement('td');
      tdDisableCooldown.className = 'fallback-row-compact';
      var cooldownStack = document.createElement('div');
      cooldownStack.className = 'checkbox-stack';
      var cooldownCheckbox = document.createElement('input');
      cooldownCheckbox.type = 'checkbox';
      cooldownCheckbox.checked = p.disableCooldown === true;
      cooldownCheckbox.dataset.idx = index;
      cooldownCheckbox.addEventListener('change', function() {
        draftFallback[parseInt(this.dataset.idx)].disableCooldown = this.checked;
        checkDirty();
      });
      cooldownStack.appendChild(cooldownCheckbox);
      appendHelperText(cooldownStack, 'Keep this fallback available after failures; current request can still fall through.');
      tdDisableCooldown.appendChild(cooldownStack);
      tr.appendChild(tdDisableCooldown);

      var tdConf = document.createElement('td');
      tdConf.className = 'fallback-row-status';
      var configuredChip = document.createElement('span');
      configuredChip.className = p.apiKeyConfigured ? 'fallback-chip fallback-chip-ok' : 'fallback-chip fallback-chip-muted';
      configuredChip.textContent = p.apiKeyConfigured ? 'Yes' : 'No';
      tdConf.appendChild(configuredChip);
      tr.appendChild(tdConf);

      var tdActions = document.createElement('td');
      tdActions.className = 'fallback-row-actions-cell';
      var actions = document.createElement('div');
      actions.className = 'row-actions';
      var deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'danger icon-button';
      deleteBtn.textContent = 'Delete';
      deleteBtn.dataset.idx = index;
      deleteBtn.addEventListener('click', function() {
        removeFallbackProvider(parseInt(this.dataset.idx, 10));
      });
      actions.appendChild(deleteBtn);
      tdActions.appendChild(actions);
      tr.appendChild(tdActions);

      tbody.appendChild(tr);
      })(i);
    }
  }

  function renderModelMappings() {
    var container = document.getElementById('model-mappings-list');
    container.innerHTML = '';
    var keys = Object.keys(draftModelMappings);
    for (var i = 0; i < keys.length; i++) {
      (function(alias, idx) {
        var row = document.createElement('div');
        row.className = 'mapping-row';
        var aliasCol = document.createElement('div');
        aliasCol.className = 'mapping-col';
        var aliasInput = document.createElement('input');
        aliasInput.type = 'text';
        aliasInput.value = alias;
        aliasInput.placeholder = 'alias';
        aliasInput.dataset.origAlias = alias;
        aliasInput.addEventListener('input', function() {
          var orig = this.dataset.origAlias;
          var newAlias = this.value;
          var target = draftModelMappings[orig];
          delete draftModelMappings[orig];
          draftModelMappings[newAlias] = target;
          this.dataset.origAlias = newAlias;
          targetInput.dataset.origAlias = newAlias;
          delBtn.dataset.alias = newAlias;
          checkDirty();
        });
        aliasCol.appendChild(aliasInput);
        appendHelperText(aliasCol, getModelMappingHelperText('alias'));
        row.appendChild(aliasCol);

        var arrow = document.createElement('div');
        arrow.className = 'mapping-arrow';
        arrow.textContent = '\u2192';
        row.appendChild(arrow);

        var targetCol = document.createElement('div');
        targetCol.className = 'mapping-col';
        var targetInput = document.createElement('input');
        targetInput.type = 'text';
        targetInput.value = draftModelMappings[alias];
        targetInput.placeholder = 'target model';
        targetInput.dataset.origAlias = alias;
        targetInput.addEventListener('input', function() {
          draftModelMappings[this.dataset.origAlias] = this.value;
          checkDirty();
        });
        targetCol.appendChild(targetInput);
        appendHelperText(targetCol, getModelMappingHelperText('target'));
        row.appendChild(targetCol);

        var actions = document.createElement('div');
        actions.className = 'row-actions';

        var delBtn = document.createElement('button');
        delBtn.className = 'icon-button';
        delBtn.textContent = 'x';
        delBtn.dataset.alias = alias;
        delBtn.addEventListener('click', function() {
          delete draftModelMappings[this.dataset.alias];
          renderModelMappings();
          checkDirty();
        });
        actions.appendChild(delBtn);
        row.appendChild(actions);
        container.appendChild(row);
      })(keys[i], i);
    }
  }

  function renderRuntime() {
    var tbody = document.querySelector('#runtime-table tbody');
    tbody.innerHTML = '';
    var envArr = serverConfig.env || [];
    for (var i = 0; i < envArr.length; i++) {
      var e = envArr[i];
      if (RUNTIME_KEYS.indexOf(e.key) < 0) continue;
      var tr = document.createElement('tr');
      var tdKey = document.createElement('td');
      tdKey.textContent = e.key;
      tr.appendChild(tdKey);
      var tdVal = document.createElement('td');
      tdVal.textContent = e.secret ? '***' : e.value;
      tr.appendChild(tdVal);
      tbody.appendChild(tr);
    }
  }

  function render() {
    renderTopbarSummary();
    renderOverview();
    renderPrimaryProvider();
    renderFallbackProviders();
    renderModelMappings();
    renderRuntime();
    showRestartNotice(serverMeta.restartRequiredFields);
    setDirty(false);
  }

  function initDraft() {
    draftEnv = (serverConfig.env || []).map(function(e) {
      var d = { key: e.key };
      if (e.secret || isSecret(e.key)) {
        d.secretAction = 'keep';
      } else {
        d.value = e.value;
      }
      return d;
    });
    draftFallback = (serverConfig.fallbackProviders || []).map(function(p) {
      var d = JSON.parse(JSON.stringify(p));
      if (d.apiKeyMode === 'inline') {
        d.secretAction = 'keep';
      }
      return d;
    });
    draftModelMappings = JSON.parse(JSON.stringify(serverConfig.modelMappings || {}));
  }

  function buildDraftPayload() {
    return {
      env: draftEnv.map(function(e) {
        var d = { key: e.key };
        if (e.secretAction) {
          d.secretAction = e.secretAction;
          if (e.secretAction === 'replace' && e.value !== undefined) {
            d.value = e.value;
          }
        } else {
          d.value = e.value;
        }
        return d;
      }),
      fallbackProviders: draftFallback.map(function(p) {
        var out = { name: p.name, baseUrl: p.baseUrl, apiKeyMode: p.apiKeyMode || 'none' };
        out.disableCooldown = p.disableCooldown === true;
        if (p.apiKeyMode === 'env' && p.apiKeyEnv) out.apiKeyEnv = p.apiKeyEnv;
        if (p.apiKeyMode === 'inline') {
          out.secretAction = p.secretAction || 'keep';
          if (p.secretAction === 'replace' && p.value) {
            out.value = p.value;
          }
        }
        return out;
      }),
      modelMappings: JSON.parse(JSON.stringify(draftModelMappings))
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
      var div = document.createElement('div');
      div.className = 'validation-result notice notice-success validation-valid';
      div.textContent = 'Draft is valid.';
      if (body.warnings && body.warnings.length > 0) {
        div.textContent += ' Warnings: ' + body.warnings.join('; ');
      }
      validationResult.appendChild(div);
    } else {
      var div = document.createElement('div');
      div.className = 'validation-result notice notice-error validation-invalid';
      div.textContent = 'Validation errors:';
      var ul = document.createElement('ul');
      ul.className = 'validation-errors';
      (body.errors || []).forEach(function(e) {
        var li = document.createElement('li');
        li.textContent = e;
        ul.appendChild(li);
      });
      div.appendChild(ul);
      validationResult.appendChild(div);
    }
  }

  async function loadConfig() {
    setStatus('Loading...');
    try {
      var res = await fetch('/admin/config');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      if (!data.ok) throw new Error(data.error?.message || 'Unknown error');
      serverConfig = data.config;
      serverMeta = { runtimeVersion: data.runtimeVersion, restartRequiredFields: data.restartRequiredFields || [], activeRequests: null };
      initDraft();
      render();
      await loadRuntimeStats();
      setStatus('Connected (runtimeVersion: ' + data.runtimeVersion + ')');
    } catch (err) {
      setStatus('Error: ' + err.message, true);
    }
  }

  async function loadRuntimeStats() {
    try {
      var res = await fetch('/admin/stats');
      if (!res.ok) return;
      var data = await res.json();
      if (typeof data.activeRequests === 'number') {
        serverMeta.activeRequests = data.activeRequests;
        renderTopbarSummary();
      }
    } catch (err) {
      void err;
    }
  }

  document.getElementById('btn-add-mapping').addEventListener('click', function() {
    var alias = 'new-alias-' + Date.now();
    draftModelMappings[alias] = '';
    renderModelMappings();
    setDirty(true);
  });

  document.getElementById('btn-add-fallback').addEventListener('click', addFallbackProvider);

  document.getElementById('btn-validate').addEventListener('click', async function() {
    validationResult.innerHTML = '<div class="loading">Validating...</div>';
    try {
      var res = await fetch('/admin/config/validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildDraftPayload())
      });
      var data = await res.json();
      showValidationResult(data);
    } catch (err) {
      validationResult.innerHTML = '<div class="validation-result notice notice-error validation-invalid">' + esc(err.message) + '</div>';
    }
  });

  document.getElementById('btn-save').addEventListener('click', async function() {
    clearActionResult();
    try {
      var res = await fetch('/admin/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildDraftPayload())
      });
      var data = await res.json();
      if (data.ok) {
        showActionResult('Saved and reloaded (v' + data.runtimeVersion + ')', false);
        await loadConfig();
      } else {
        showActionResult('Save failed: ' + (data.error?.message || 'Unknown error'), true);
      }
    } catch (err) {
      showActionResult('Save error: ' + err.message, true);
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
        showActionResult('Reload failed: ' + (data.error?.message || 'Unknown error'), true);
      }
    } catch (err) {
      showActionResult('Reload error: ' + err.message, true);
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
        showActionResult('Rollback failed: ' + (data.error?.message || 'Unknown error'), true);
      }
    } catch (err) {
      showActionResult('Rollback error: ' + err.message, true);
    }
  });

  loadConfig();
})();
