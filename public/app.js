/**
 * Dashboard logic. Plain JavaScript, no framework.
 *
 * Flow:
 *   1. The user picks a PDF.
 *   2. We POST it to /ai/upload/stream and read the response line by line (NDJSON).
 *   3. Every line is an event: "stage running", "stage done" (with partial data), "complete" or "error".
 *   4. handleEvent() updates `state`, then the render functions redraw the screen.
 */
(() => {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Constants                                                           */
  /* ------------------------------------------------------------------ */

  const STAGES = [
    { id: 'upload', label: 'Upload PDF', running: 'Uploading PDF...' },
    { id: 'parse', label: 'Parse PDF', running: 'Parsing...' },
    { id: 'markdown', label: 'Convert to Markdown', running: 'Markdown...' },
    { id: 'metadata', label: 'Extract metadata', running: 'Metadata...' },
    { id: 'clean', label: 'Clean document', running: 'Cleaning...' },
    { id: 'recursive', label: 'Recursive chunking', running: 'Recursive Chunking...' },
    { id: 'semantic', label: 'Semantic chunking', running: 'Semantic Chunking...' },
    { id: 'parentChild', label: 'Parent-child tree', running: 'Building Parent Child Tree...' },
    { id: 'summary', label: 'Gemini summary', running: 'Gemini Summary...' },
    { id: 'complete', label: 'Completed', running: 'Completed' },
  ];

  const TABS = [
    { id: 'overview', label: 'Overview', color: '#15203B', ready: () => true },
    { id: 'markdown', label: 'Markdown', color: '#15203B', ready: () => !!state.data.markdown },
    { id: 'recursive', label: 'Recursive chunks', color: 'var(--rec)', ready: () => !!state.data.recursive, count: () => state.data.recursive?.length },
    { id: 'semantic', label: 'Semantic chunks', color: 'var(--sem)', ready: () => !!state.data.semantic, count: () => state.data.semantic?.length },
    { id: 'tree', label: 'Parent-child tree', color: 'var(--tree)', ready: () => !!state.data.parents, count: () => state.data.parents?.length },
  ];

  const CARD = 'rounded-xl border border-line bg-white';

  /* ------------------------------------------------------------------ */
  /* State                                                               */
  /* ------------------------------------------------------------------ */

  const freshState = () => ({
    file: null,
    status: 'idle', // idle | processing | completed | failed
    error: null,
    totalMs: null,
    stages: Object.fromEntries(STAGES.map((s) => [s.id, { status: 'pending', durationMs: null, detail: '' }])),
    data: {
      markdown: null,
      metadata: null,
      cleaned: null,
      recursive: null,
      semantic: null,
      parents: null,
      summary: null,
      summaryError: null,
      settings: null,
    },
    ui: {
      tab: 'overview',
      mdVersion: 'cleaned',
      mdView: 'rendered',
      recQuery: '',
      recLevel: 'all',
      semQuery: '',
      expandedParents: new Set(),
      openChunks: new Set(),
    },
  });

  let state = freshState();

  /* ------------------------------------------------------------------ */
  /* Small helpers                                                       */
  /* ------------------------------------------------------------------ */

  const $ = (selector) => document.querySelector(selector);
  const esc = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const num = (n) => Number(n ?? 0).toLocaleString('en-US');
  const formatBytes = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`);
  const formatMs = (ms) => (ms == null ? '' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
  const crumbs = (path) => (path && path.length ? path.map(esc).join(' &rsaquo; ') : 'Before the first heading');

  function sizeSummary(items, key = 'charCount') {
    if (!items || items.length === 0) return { count: 0, min: 0, avg: 0, max: 0, tokens: 0 };
    const sizes = items.map((i) => i[key]);
    return {
      count: items.length,
      min: Math.min(...sizes),
      avg: Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length),
      max: Math.max(...sizes),
      tokens: items.reduce((sum, i) => sum + i.tokenEstimate, 0),
    };
  }

  /* ------------------------------------------------------------------ */
  /* Tiny Markdown renderer (safe: everything is escaped first)          */
  /* ------------------------------------------------------------------ */

  function renderMarkdown(markdown) {
    const inline = (text) =>
      esc(text)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');

    const html = [];
    let paragraph = [];
    let list = null; // { tag, items }
    let code = null;

    const flushParagraph = () => {
      if (paragraph.length) html.push(`<p>${inline(paragraph.join(' '))}</p>`);
      paragraph = [];
    };
    const flushList = () => {
      if (list) html.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
      list = null;
    };

    for (const line of markdown.split('\n')) {
      if (/^\s*```/.test(line)) {
        if (code) {
          html.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
          code = null;
        } else {
          flushParagraph();
          flushList();
          code = [];
        }
        continue;
      }
      if (code) {
        code.push(line);
        continue;
      }

      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
      const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);

      if (heading) {
        flushParagraph();
        flushList();
        const level = Math.min(heading[1].length, 4);
        html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      } else if (bullet || numbered) {
        flushParagraph();
        const tag = bullet ? 'ul' : 'ol';
        if (!list || list.tag !== tag) {
          flushList();
          list = { tag, items: [] };
        }
        list.items.push((bullet || numbered)[1]);
      } else if (!line.trim()) {
        flushParagraph();
        flushList();
      } else {
        flushList();
        paragraph.push(line.trim());
      }
    }
    flushParagraph();
    flushList();
    if (code) html.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
    return html.join('\n');
  }

  /* ------------------------------------------------------------------ */
  /* Upload and streaming                                                */
  /* ------------------------------------------------------------------ */

  async function startProcessing(file) {
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
      return showFatal('Only PDF files are accepted.');
    }

    state = freshState();
    state.file = file;
    state.status = 'processing';
    setStage('upload', 'running');
    renderAll();

    const form = new FormData();
    form.append('file', file);

    try {
      const response = await fetch('/ai/upload/stream', { method: 'POST', body: form });
      if (!response.ok) throw new Error(await readHttpError(response));
      await readEventStream(response, handleEvent);

      if (state.status === 'processing') showFatal('The connection closed before processing finished.');
    } catch (error) {
      showFatal(error.message || 'Something went wrong while uploading.');
    }
  }

  async function readHttpError(response) {
    try {
      const body = await response.json();
      return Array.isArray(body.message) ? body.message.join(', ') : body.message || response.statusText;
    } catch {
      return response.status === 413 ? 'The file is too large.' : `Request failed (${response.status}).`;
    }
  }

  /** Reads newline-delimited JSON from a streaming fetch response. */
  async function readEventStream(response, onEvent) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) onEvent(JSON.parse(line));
      }
    }
    if (buffer.trim()) onEvent(JSON.parse(buffer));
  }

  function handleEvent(event) {
    switch (event.type) {
      case 'start':
        setStage('upload', 'done', { detail: `${event.fileName} (${formatBytes(event.fileSizeBytes)})` });
        break;

      case 'stage':
        setStage(event.stage, event.status, { durationMs: event.durationMs, detail: event.detail });
        if (event.status === 'done' && event.data) applyStageData(event.stage, event.data);
        if (event.stage === 'summary' && event.status === 'failed') state.data.summaryError = event.detail;
        break;

      case 'complete':
        state.status = 'completed';
        state.totalMs = event.totalMs;
        state.data.settings = event.settings;
        setStage('complete', 'done', { durationMs: event.totalMs });
        break;

      case 'error':
        showFatal(event.message);
        return;
    }
    renderAll();
  }

  function applyStageData(stage, data) {
    if (stage === 'markdown') state.data.markdown = data.markdown;
    if (stage === 'metadata') state.data.metadata = data.metadata;
    if (stage === 'clean') state.data.cleaned = data.cleaned;
    if (stage === 'recursive') state.data.recursive = data.chunks;
    if (stage === 'semantic') state.data.semantic = data.chunks;
    if (stage === 'parentChild') {
      state.data.parents = data.parents;
      state.ui.expandedParents = new Set(data.parents.slice(0, 2).map((p) => p.id));
    }
    if (stage === 'summary') state.data.summary = data.summary;
  }

  function setStage(id, status, extra = {}) {
    state.stages[id] = { ...state.stages[id], status, ...extra };
  }

  function showFatal(message) {
    for (const stage of STAGES) {
      if (state.stages[stage.id].status === 'running') setStage(stage.id, 'failed', { detail: message });
    }
    state.status = 'failed';
    state.error = message;
    renderAll();
  }

  /* ------------------------------------------------------------------ */
  /* Rendering: header, upload card, timeline                            */
  /* ------------------------------------------------------------------ */

  function renderAll() {
    renderStatus();
    renderUpload();
    renderTimeline();
    renderWorkspace();
  }

  function renderStatus() {
    const pill = $('#status-pill');
    const labels = { idle: 'Idle', processing: 'Processing', completed: 'Completed', failed: 'Failed' };
    const styles = {
      idle: 'border-line text-mute',
      processing: 'border-run/40 bg-run/10 text-run',
      completed: 'border-ok/40 bg-ok/10 text-ok',
      failed: 'border-bad/40 bg-bad/10 text-bad',
    };
    pill.textContent = labels[state.status];
    pill.className = `rounded-full border px-3 py-1 text-sm font-medium ${styles[state.status]}`;
    $('#reset-btn').classList.toggle('hidden', state.status === 'idle' || state.status === 'processing');
  }

  function renderUpload() {
    const busy = state.status === 'processing';
    const dropzone = $('#dropzone');
    dropzone.setAttribute('aria-disabled', String(busy));
    $('#file-input').disabled = busy;
    $('#sample-btn').disabled = busy;

    const info = $('#file-info');
    if (state.file) {
      info.className = 'mt-3 flex items-center justify-between gap-3 rounded-lg bg-paper px-3 py-2 text-sm';
      info.innerHTML = `<span class="min-w-0 truncate font-medium" title="${esc(state.file.name)}">${esc(state.file.name)}</span><span class="shrink-0 text-mute">${formatBytes(state.file.size)}</span>`;
    } else {
      info.className = 'mt-3 hidden';
    }
  }

  function renderTimeline() {
    const icons = {
      done: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>',
      failed: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>',
      running: '<span class="spinner"></span>',
      pending: '',
    };

    $('#timeline').innerHTML = STAGES.map((stage) => {
      const s = state.stages[stage.id];
      const statusText = { pending: 'Waiting', running: 'Running', done: 'Done', failed: 'Failed' }[s.status];
      const textClass = s.status === 'pending' ? 'text-mute' : 'text-ink';
      const detail = s.detail && s.status !== 'running' ? `<p class="mt-0.5 break-words text-xs ${s.status === 'failed' ? 'text-bad' : 'text-mute'}">${esc(s.detail)}</p>` : '';
      return `
        <li class="rail-item" data-status="${s.status}">
          <span class="node" role="img" aria-label="${statusText}">${icons[s.status]}</span>
          <div class="min-w-0 flex-1">
            <div class="flex items-baseline justify-between gap-2">
              <span class="text-sm font-medium ${textClass}">${stage.label}</span>
              <span class="shrink-0 text-xs text-mute">${s.status === 'running' ? 'Running' : formatMs(s.durationMs)}</span>
            </div>
            ${detail}
          </div>
        </li>`;
    }).join('');

    const banner = $('#status-banner');
    const running = STAGES.find((s) => state.stages[s.id].status === 'running');
    if (state.status === 'idle') {
      banner.textContent = 'Waiting for a PDF.';
      banner.className = 'mb-4 rounded-lg bg-paper px-3 py-2 text-sm text-mute';
    } else if (state.status === 'processing') {
      banner.textContent = running ? running.running : 'Working...';
      banner.className = 'mb-4 rounded-lg bg-run/10 px-3 py-2 text-sm font-medium text-run';
    } else if (state.status === 'completed') {
      const note = state.stages.summary.status === 'failed' ? ' The Gemini summary failed, see the Overview tab.' : '';
      banner.textContent = `Completed.${note}`;
      banner.className = `mb-4 rounded-lg px-3 py-2 text-sm font-medium ${note ? 'bg-run/10 text-run' : 'bg-ok/10 text-ok'}`;
    } else {
      banner.textContent = state.error || 'Processing failed.';
      banner.className = 'mb-4 rounded-lg bg-bad/10 px-3 py-2 text-sm font-medium text-bad';
    }
    $('#total-time').textContent = state.totalMs != null ? `Total ${formatMs(state.totalMs)}` : '';
  }

  /* ------------------------------------------------------------------ */
  /* Rendering: workspace (tabs and panels)                              */
  /* ------------------------------------------------------------------ */

  function renderWorkspace() {
    const hasWork = state.status !== 'idle';
    $('#empty-state').classList.toggle('hidden', hasWork);
    $('#results').classList.toggle('hidden', !hasWork);
    if (!hasWork) return;

    // If the selected tab is not ready yet, fall back to the overview.
    const current = TABS.find((t) => t.id === state.ui.tab);
    if (!current || !current.ready()) state.ui.tab = 'overview';

    $('#tabs').innerHTML = TABS.map((tab) => {
      const ready = tab.ready();
      const active = state.ui.tab === tab.id;
      const count = ready && tab.count && tab.count() != null ? `<span class="ml-1.5 rounded-full bg-paper px-1.5 py-0.5 text-xs text-mute">${tab.count()}</span>` : '';
      return `<button role="tab" aria-selected="${active}" ${ready ? '' : 'disabled'} data-action="tab" data-tab="${tab.id}"
        class="-mb-px shrink-0 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors ${ready ? '' : 'cursor-not-allowed opacity-40'} ${active ? '' : 'border-transparent text-mute hover:text-ink'}"
        style="${active ? `border-color:${tab.color};color:#15203B` : ''}">${tab.label}${count}</button>`;
    }).join('');

    renderPanel();
  }

  function renderPanel() {
    const panel = $('#panel');
    switch (state.ui.tab) {
      case 'markdown':
        panel.innerHTML = markdownPanel();
        break;
      case 'recursive':
        panel.innerHTML = chunkPanel('recursive');
        refreshChunkList('recursive');
        break;
      case 'semantic':
        panel.innerHTML = chunkPanel('semantic');
        refreshChunkList('semantic');
        break;
      case 'tree':
        panel.innerHTML = treePanel();
        break;
      default:
        panel.innerHTML = overviewPanel();
    }
  }

  const waiting = (text) => `<div class="space-y-2" aria-label="${esc(text)}"><div class="skeleton h-4 w-3/4"></div><div class="skeleton h-4 w-full"></div><div class="skeleton h-4 w-2/3"></div><p class="pt-1 text-xs text-mute">${esc(text)}</p></div>`;

  /* ---------------------------- Overview ---------------------------- */

  function overviewPanel() {
    return `
      <div class="grid gap-4 xl:grid-cols-2">
        <div class="xl:col-span-2">${summaryCard()}</div>
        ${metadataCard()}
        ${statsCard()}
        <div class="xl:col-span-2">${cleaningCard()}</div>
      </div>`;
  }

  function summaryCard() {
    const { summary, summaryError } = state.data;
    let body;
    if (summary) {
      body = `
        <p class="max-w-[70ch] text-[15px] leading-relaxed">${esc(summary.summary)}</p>
        <ul class="mt-4 space-y-2">
          ${summary.keyPoints.map((p) => `<li class="flex gap-2.5 text-sm"><span class="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-ink"></span><span>${esc(p)}</span></li>`).join('')}
        </ul>
        <div class="mt-4 flex flex-wrap gap-1.5">
          ${summary.topics.map((t) => `<span class="rounded-full border border-line px-2.5 py-0.5 text-xs">${esc(t)}</span>`).join('')}
        </div>`;
    } else if (summaryError) {
      body = `
        <div class="rounded-lg border border-bad/30 bg-bad/5 p-3 text-sm">
          <p class="font-medium text-bad">The summary could not be created.</p>
          <p class="mt-1 break-words text-mute">${esc(summaryError)}</p>
          <p class="mt-2 text-mute">Every other result on this page is still valid. Fix the problem and upload the PDF again.</p>
        </div>`;
    } else if (state.stages.summary.status === 'running') {
      body = waiting('Gemini is reading the cleaned document...');
    } else {
      body = waiting('The summary starts after the chunks are ready.');
    }

    const type = summary?.documentType ? `<span class="rounded-full bg-ink px-2.5 py-0.5 text-xs font-medium text-white">${esc(summary.documentType)}</span>` : '';
    return `
      <section class="${CARD} p-5">
        <div class="mb-3 flex items-center justify-between gap-3">
          <h3 class="font-semibold">Summary</h3>${type}
        </div>${body}
      </section>`;
  }

  function metadataCard() {
    const m = state.data.metadata;
    const rows = m
      ? [
          ['Title', m.title],
          ['File', `${m.fileName} (${formatBytes(m.fileSizeBytes)})`],
          ['Pages', num(m.pageCount)],
          ['Author', m.author || 'Not set'],
          ['Created', m.createdAt ? new Date(m.createdAt).toLocaleDateString('en-US', { dateStyle: 'medium' }) : 'Not set'],
          ['Producer', m.producer || 'Not set'],
          ['Words', num(m.wordCount)],
          ['Reading time', `${m.readingTimeMinutes} min`],
          ['Language', m.language],
          ['Structure', `${m.headingCount} headings, ${m.paragraphCount} paragraphs, ${m.listItemCount} list items`],
        ]
      : [];
    return `
      <section class="${CARD} p-5">
        <h3 class="mb-3 font-semibold">Metadata</h3>
        ${
          m
            ? `<dl class="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
                ${rows.map(([k, v]) => `<dt class="text-mute">${k}</dt><dd class="break-words font-medium">${esc(v)}</dd>`).join('')}
              </dl>
              <div class="mt-4 flex flex-wrap gap-1.5">${m.keywords.map((k) => `<span class="rounded-md bg-paper px-2 py-0.5 text-xs">${esc(k)}</span>`).join('')}</div>`
            : waiting('Metadata appears after Markdown conversion.')
        }
      </section>`;
  }

  function statsCard() {
    const { recursive, semantic, parents, settings } = state.data;
    if (!recursive && !semantic && !parents) {
      return `<section class="${CARD} p-5"><h3 class="mb-3 font-semibold">Chunk statistics</h3>${waiting('Statistics appear as chunks are created.')}</section>`;
    }

    const children = parents ? parents.flatMap((p) => p.childChunks) : null;
    const tile = (label, value, color) => `
      <div class="rounded-lg border border-line p-3">
        <div class="text-2xl font-bold tabular-nums" style="color:${color}">${value == null ? '-' : num(value)}</div>
        <div class="text-xs text-mute">${label}</div>
      </div>`;

    const strip = (title, items, color, tab) => {
      if (!items) return '';
      const s = sizeSummary(items);
      return `
        <div class="mt-5">
          <div class="mb-1.5 flex flex-wrap items-baseline justify-between gap-2">
            <span class="text-sm font-medium">${title}</span>
            <span class="text-xs text-mute">min ${num(s.min)}, avg ${num(s.avg)}, max ${num(s.max)} chars, about ${num(s.tokens)} tokens</span>
          </div>
          <div class="strip" role="list" aria-label="${esc(title)} sizes">
            ${items.map((c) => `<button role="listitem" data-action="goto" data-tab="${tab}" data-id="${esc(c.id)}" title="${esc(c.id)}: ${c.charCount} chars" aria-label="${esc(c.id)}, ${c.charCount} characters" style="flex:${c.charCount} 1 0;background:${color}"></button>`).join('')}
          </div>
        </div>`;
    };

    const settingsLine = settings
      ? `<p class="mt-5 border-t border-line pt-3 text-xs text-mute">Recursive: ${settings.recursiveSize} chars with ${settings.recursiveOverlap} overlap. Semantic: ${settings.semanticMin} to ${settings.semanticMax} chars. Children: ${settings.childSize} chars. Model: ${esc(settings.geminiModel)}.</p>`
      : '';

    return `
      <section class="${CARD} p-5">
        <h3 class="mb-3 font-semibold">Chunk statistics</h3>
        <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
          ${tile('Recursive chunks', recursive?.length, 'var(--rec)')}
          ${tile('Semantic chunks', semantic?.length, 'var(--sem)')}
          ${tile('Parents', parents?.length, 'var(--tree)')}
          ${tile('Children', children?.length, 'var(--tree)')}
        </div>
        <p class="mt-4 text-xs text-mute">Each bar below is one chunk. Width shows its length. Click a bar to open it.</p>
        ${strip('Recursive', recursive, 'var(--rec)', 'recursive')}
        ${strip('Semantic', semantic, 'var(--sem)', 'semantic')}
        ${settingsLine}
      </section>`;
  }

  function cleaningCard() {
    const cleaned = state.data.cleaned;
    if (!cleaned) {
      return `<section class="${CARD} p-5"><h3 class="mb-3 font-semibold">Cleaning report</h3>${waiting('The report appears after the cleaning stage.')}</section>`;
    }
    const r = cleaned.report;
    return `
      <section class="${CARD} p-5">
        <div class="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h3 class="font-semibold">Cleaning report</h3>
          <span class="text-sm text-mute">${num(r.charsBefore)} to ${num(r.charsAfter)} characters (${r.reductionPercent}% smaller)</span>
        </div>
        <ul class="grid gap-x-8 gap-y-2 sm:grid-cols-2">
          ${r.steps
            .map(
              (s) => `<li class="flex items-start justify-between gap-3 text-sm">
                <span><span class="font-medium">${esc(s.name)}</span><br><span class="text-xs text-mute">${esc(s.description)}</span></span>
                <span class="shrink-0 rounded-md px-2 py-0.5 text-xs font-medium tabular-nums ${s.affected > 0 ? 'bg-ok/10 text-ok' : 'bg-paper text-mute'}">${s.affected > 0 ? `${num(s.affected)} fixed` : 'none'}</span>
              </li>`,
            )
            .join('')}
        </ul>
      </section>`;
  }

  /* ---------------------------- Markdown ---------------------------- */

  function currentMarkdown() {
    const original = state.data.markdown || '';
    return state.ui.mdVersion === 'cleaned' && state.data.cleaned ? state.data.cleaned.markdown : original;
  }

  function segmented(action, current, options) {
    return `<div class="inline-flex rounded-lg border border-line p-0.5 text-sm" role="group">
      ${options
        .map(
          ([value, label, disabled]) =>
            `<button data-action="${action}" data-value="${value}" ${disabled ? 'disabled' : ''} aria-pressed="${current === value}"
              class="rounded-md px-3 py-1 font-medium ${current === value ? 'bg-ink text-white' : 'text-mute hover:text-ink'} ${disabled ? 'cursor-not-allowed opacity-40' : ''}">${label}</button>`,
        )
        .join('')}
    </div>`;
  }

  function markdownPanel() {
    const hasCleaned = !!state.data.cleaned;
    const text = currentMarkdown();
    const info = hasCleaned
      ? `Original ${num(state.data.markdown.length)} chars, cleaned ${num(state.data.cleaned.markdown.length)} chars.`
      : `${num(text.length)} characters.`;
    return `
      <section class="${CARD}">
        <div class="flex flex-wrap items-center gap-3 border-b border-line p-3">
          ${segmented('md-version', state.ui.mdVersion, [['original', 'Original'], ['cleaned', 'Cleaned', !hasCleaned]])}
          ${segmented('md-view', state.ui.mdView, [['rendered', 'Rendered'], ['source', 'Source']])}
          <span class="text-xs text-mute">${info}</span>
          <span class="ml-auto flex gap-2">
            <button data-action="copy-md" class="rounded-lg border border-line px-3 py-1 text-sm font-medium hover:bg-paper">Copy</button>
            <button data-action="download-md" class="rounded-lg border border-line px-3 py-1 text-sm font-medium hover:bg-paper">Download .md</button>
          </span>
        </div>
        <div class="max-h-[75vh] overflow-auto p-6 sm:p-8">
          ${state.ui.mdView === 'rendered' ? `<article class="doc">${renderMarkdown(text)}</article>` : `<pre class="chunk-text">${esc(text)}</pre>`}
        </div>
      </section>`;
  }

  /* ------------------------ Recursive / Semantic -------------------- */

  function chunkPanel(kind) {
    const isRec = kind === 'recursive';
    const color = isRec ? 'var(--rec)' : 'var(--sem)';
    const items = state.data[kind] || [];
    const s = sizeSummary(items);
    const blurb = isRec
      ? 'Split on headings, then paragraphs, then sentences. Each chunk shows the smallest unit that had to be split.'
      : 'Related paragraphs stay together. Each chunk shows why it started and which rules kept its paragraphs together.';

    const levels = ['all', 'section', 'paragraph', 'line', 'sentence', 'word', 'character'];
    const levelSelect = isRec
      ? `<label class="flex items-center gap-2 text-sm text-mute">Split level
          <select id="rec-level" class="rounded-lg border border-line bg-white px-2 py-1.5 text-sm text-ink">
            ${levels.map((l) => `<option value="${l}" ${state.ui.recLevel === l ? 'selected' : ''}>${l === 'all' ? 'All levels' : l}</option>`).join('')}
          </select></label>`
      : '';

    return `
      <section class="${CARD} mb-4 p-4">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <h3 class="font-semibold" style="color:${color}">${isRec ? 'Recursive' : 'Semantic'} chunks</h3>
          <span class="text-xs text-mute">${num(s.count)} chunks, min ${num(s.min)}, avg ${num(s.avg)}, max ${num(s.max)} chars</span>
        </div>
        <p class="mt-1 max-w-[75ch] text-sm text-mute">${blurb}</p>
        <div class="mt-3 flex flex-wrap items-center gap-3">
          <input id="${isRec ? 'rec' : 'sem'}-search" type="search" placeholder="Search in chunks" value="${esc(isRec ? state.ui.recQuery : state.ui.semQuery)}"
            class="w-full rounded-lg border border-line px-3 py-1.5 text-sm sm:w-64" aria-label="Search in chunks" />
          ${levelSelect}
          <button data-action="toggle-all-chunks" data-kind="${kind}" class="ml-auto rounded-lg border border-line px-3 py-1.5 text-sm font-medium hover:bg-paper">Expand all</button>
        </div>
      </section>
      <div id="chunk-list" class="space-y-3"></div>`;
  }

  function refreshChunkList(kind) {
    const isRec = kind === 'recursive';
    const query = (isRec ? state.ui.recQuery : state.ui.semQuery).trim().toLowerCase();
    let items = state.data[kind] || [];
    if (query) items = items.filter((c) => c.content.toLowerCase().includes(query) || c.headingPath.join(' ').toLowerCase().includes(query));
    if (isRec && state.ui.recLevel !== 'all') items = items.filter((c) => c.splitLevel === state.ui.recLevel);

    const list = $('#chunk-list');
    if (!list) return;
    list.innerHTML = items.length ? items.map((c) => chunkCard(c)).join('') : `<div class="${CARD} p-6 text-sm text-mute">No chunks match this filter.</div>`;
  }

  function chunkCard(chunk) {
    const isRec = chunk.strategy === 'recursive';
    const color = isRec ? 'var(--rec)' : 'var(--sem)';
    const open = state.ui.openChunks.has(chunk.id);
    const long = chunk.content.length > 420;

    const chips = [];
    if (isRec) {
      chips.push(`<span class="rounded-md bg-paper px-2 py-0.5 text-xs">Split level: <strong>${esc(chunk.splitLevel)}</strong></span>`);
      if (chunk.overlapChars) chips.push(`<span class="rounded-md bg-paper px-2 py-0.5 text-xs">Overlap: ${chunk.overlapChars} chars from the previous chunk</span>`);
    } else {
      chips.push(`<span class="rounded-md bg-paper px-2 py-0.5 text-xs">Starts because: <strong>${esc(chunk.boundaryReason)}</strong></span>`);
      for (const rule of chunk.groupingRules || []) chips.push(`<span class="rounded-md px-2 py-0.5 text-xs" style="background:#F1EBFD">${esc(rule)}</span>`);
    }

    return `
      <article id="chunk-${esc(chunk.id)}" class="${CARD} ${open ? 'open' : ''} overflow-hidden" style="border-left:4px solid ${color}">
        <header class="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-3">
          <span class="rounded-md px-2 py-0.5 font-mono text-xs font-medium text-white" style="background:${color}">${esc(chunk.id)}</span>
          <span class="min-w-0 flex-1 truncate text-xs text-mute" title="${esc((chunk.headingPath || []).join(' > '))}">${crumbs(chunk.headingPath)}</span>
          <span class="text-xs tabular-nums text-mute">${num(chunk.charCount)} chars, about ${num(chunk.tokenEstimate)} tokens</span>
        </header>
        <div class="px-4 py-3">
          <div class="${long ? 'clamp' : ''}"><pre class="chunk-text">${esc(chunk.content)}</pre></div>
          ${long ? `<button data-action="toggle-chunk" data-id="${esc(chunk.id)}" class="mt-2 text-xs font-medium underline underline-offset-2">${open ? 'Show less' : 'Show full chunk'}</button>` : ''}
        </div>
        <footer class="flex flex-wrap gap-1.5 border-t border-line px-4 py-2.5">${chips.join('')}</footer>
      </article>`;
  }

  /* ----------------------- Parent-child tree ------------------------ */

  function treePanel() {
    const parents = state.data.parents || [];
    const children = parents.reduce((sum, p) => sum + p.childChunks.length, 0);
    return `
      <section class="${CARD} mb-4 p-4">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <h3 class="font-semibold" style="color:var(--tree)">Parent-child tree</h3>
          <span class="text-xs text-mute">${num(parents.length)} parents, ${num(children)} children</span>
        </div>
        <p class="mt-1 max-w-[75ch] text-sm text-mute">A parent is a full section. Its children are small chunks inside it. Later, search will match a child and return the whole parent to the model.</p>
        <div class="mt-3 flex gap-2">
          <button data-action="expand-parents" class="rounded-lg border border-line px-3 py-1.5 text-sm font-medium hover:bg-paper">Expand all</button>
          <button data-action="collapse-parents" class="rounded-lg border border-line px-3 py-1.5 text-sm font-medium hover:bg-paper">Collapse all</button>
        </div>
      </section>
      <div id="tree-list" class="space-y-3">${parents.map(parentCard).join('')}</div>`;
  }

  function parentCard(parent) {
    const open = state.ui.expandedParents.has(parent.id);
    const kids = parent.childChunks;
    return `
      <article id="parent-${esc(parent.id)}" class="${CARD} overflow-hidden" style="border-left:4px solid var(--tree)">
        <button data-action="toggle-parent" data-id="${esc(parent.id)}" aria-expanded="${open}" class="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-paper">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" class="shrink-0 transition-transform ${open ? 'rotate-90' : ''}" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>
          <span class="rounded-md bg-tree px-2 py-0.5 font-mono text-xs font-medium text-white">Parent</span>
          <span class="min-w-0 flex-1 truncate font-semibold">${esc(parent.title)}</span>
          <span class="shrink-0 text-xs text-mute">${kids.length} ${kids.length === 1 ? 'child' : 'children'}, ${num(parent.charCount)} chars</span>
        </button>
        ${
          open
            ? `<div class="border-t border-line px-4 py-4">
                <p class="mb-1 font-mono text-xs text-mute">${esc(parent.id)}</p>
                <details class="mb-5 rounded-lg bg-paper px-3 py-2 text-sm">
                  <summary class="cursor-pointer font-medium">Full parent Markdown</summary>
                  <pre class="chunk-text mt-2 max-h-72 overflow-auto">${esc(parent.markdown)}</pre>
                </details>
                <ol class="tree">${kids.map((child, i) => childCard(child, i, kids.length)).join('')}</ol>
              </div>`
            : ''
        }
      </article>`;
  }

  function childCard(child, index, total) {
    return `
      <li class="tree-child">
        <div class="rounded-lg border border-line bg-white p-3">
          <div class="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span class="text-sm font-semibold">Child ${index + 1} <span class="font-normal text-mute">of ${total}</span></span>
            <span class="font-mono text-xs text-mute">${esc(child.id)}</span>
            <span class="ml-auto text-xs tabular-nums text-mute">${num(child.charCount)} chars</span>
          </div>
          <pre class="chunk-text">${esc(child.content)}</pre>
          <p class="mt-2 font-mono text-xs text-mute">parentId: ${esc(child.parentId)}</p>
        </div>
      </li>`;
  }

  /* ------------------------------------------------------------------ */
  /* Events                                                              */
  /* ------------------------------------------------------------------ */

  function setTab(tab, afterRender) {
    state.ui.tab = tab;
    renderWorkspace();
    if (afterRender) afterRender();
  }

  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    const { action, tab, id, value, kind } = target.dataset;

    switch (action) {
      case 'tab':
        setTab(tab);
        break;

      case 'reset':
        state = freshState();
        $('#file-input').value = '';
        renderAll();
        break;

      case 'try-sample':
        loadSample();
        break;

      case 'md-version':
        state.ui.mdVersion = value;
        renderPanel();
        break;

      case 'md-view':
        state.ui.mdView = value;
        renderPanel();
        break;

      case 'copy-md':
        navigator.clipboard?.writeText(currentMarkdown()).then(() => flashButton(target, 'Copied'));
        break;

      case 'download-md':
        downloadMarkdown();
        break;

      case 'toggle-chunk': {
        if (state.ui.openChunks.has(id)) state.ui.openChunks.delete(id);
        else state.ui.openChunks.add(id);
        refreshChunkList(state.ui.tab);
        break;
      }

      case 'toggle-all-chunks': {
        const items = state.data[kind] || [];
        const allOpen = items.every((c) => state.ui.openChunks.has(c.id));
        items.forEach((c) => (allOpen ? state.ui.openChunks.delete(c.id) : state.ui.openChunks.add(c.id)));
        target.textContent = allOpen ? 'Expand all' : 'Collapse all';
        refreshChunkList(kind);
        break;
      }

      case 'toggle-parent':
        if (state.ui.expandedParents.has(id)) state.ui.expandedParents.delete(id);
        else state.ui.expandedParents.add(id);
        $('#tree-list').innerHTML = state.data.parents.map(parentCard).join('');
        break;

      case 'expand-parents':
        state.ui.expandedParents = new Set(state.data.parents.map((p) => p.id));
        $('#tree-list').innerHTML = state.data.parents.map(parentCard).join('');
        break;

      case 'collapse-parents':
        state.ui.expandedParents = new Set();
        $('#tree-list').innerHTML = state.data.parents.map(parentCard).join('');
        break;

      case 'goto': {
        state.ui.openChunks.add(id);
        setTab(tab, () => {
          const card = document.getElementById(`chunk-${id}`);
          if (card) {
            card.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
            card.classList.add('flash');
          }
        });
        break;
      }
    }
  });

  document.addEventListener('input', (event) => {
    if (event.target.id === 'rec-search') {
      state.ui.recQuery = event.target.value;
      refreshChunkList('recursive');
    } else if (event.target.id === 'sem-search') {
      state.ui.semQuery = event.target.value;
      refreshChunkList('semantic');
    }
  });

  document.addEventListener('change', (event) => {
    if (event.target.id === 'rec-level') {
      state.ui.recLevel = event.target.value;
      refreshChunkList('recursive');
    }
  });

  function flashButton(button, text) {
    const original = button.textContent;
    button.textContent = text;
    setTimeout(() => (button.textContent = original), 1200);
  }

  function downloadMarkdown() {
    const name = (state.file?.name || 'document').replace(/\.pdf$/i, '');
    const blob = new Blob([currentMarkdown()], { type: 'text/markdown' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${name}${state.ui.mdVersion === 'cleaned' ? '.cleaned' : ''}.md`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  /* ------------------------------------------------------------------ */
  /* File selection: click, keyboard, drag and drop, sample              */
  /* ------------------------------------------------------------------ */

  const dropzone = $('#dropzone');
  const fileInput = $('#file-input');

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    fileInput.value = ''; // lets the user pick the same file again
    startProcessing(file);
  });

  dropzone.addEventListener('keydown', (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && state.status !== 'processing') {
      event.preventDefault();
      fileInput.click();
    }
  });

  ['dragenter', 'dragover'].forEach((name) =>
    dropzone.addEventListener(name, (event) => {
      event.preventDefault();
      if (state.status !== 'processing') dropzone.classList.add('border-ink', 'bg-paper');
    }),
  );
  ['dragleave', 'drop'].forEach((name) =>
    dropzone.addEventListener(name, (event) => {
      event.preventDefault();
      dropzone.classList.remove('border-ink', 'bg-paper');
    }),
  );
  dropzone.addEventListener('drop', (event) => {
    if (state.status === 'processing') return;
    startProcessing(event.dataTransfer.files[0]);
  });

  async function loadSample() {
    try {
      const response = await fetch('/sample/rag-fundamentals.pdf');
      if (!response.ok) throw new Error('Sample PDF not found.');
      const blob = await response.blob();
      startProcessing(new File([blob], 'rag-fundamentals.pdf', { type: 'application/pdf' }));
    } catch (error) {
      showFatal(error.message);
    }
  }

  // Initial paint
  renderAll();
})();
