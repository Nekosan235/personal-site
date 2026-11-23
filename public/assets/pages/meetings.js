import { apiRequest, ApiError } from '../components/api.js?v=1.7.0';
import { element, pageHeading } from '../components/dom.js?v=1.4.0';
import { icon } from '../components/icons.js?v=1.11.0';
import { createPoller } from '../components/poller.js?v=1.4.0';

const ACTIVE_STATUSES = new Set(['queued', 'transcribing']);

const STATUS_META = {
  draft: { label: '待上传', className: 'meetings-status-draft bg-secondary-lt' },
  queued: { label: '待转写', className: 'meetings-status-queued bg-secondary-lt' },
  transcribing: { label: '正在转写', className: 'meetings-status-transcribing bg-blue-lt' },
  done: { label: '已转写', className: 'meetings-status-done bg-green-lt' },
  failed: { label: '转写失败', className: 'meetings-status-failed bg-red-lt' },
};

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (!seconds) return '—';
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} 小时 ${remainder} 分` : `${hours} 小时`;
}

function formatDate(timestamp) {
  if (!timestamp) return '—';
  return new Date(timestamp).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function statusBadge(status) {
  const meta = STATUS_META[status] ?? { label: '未知', className: 'bg-secondary-lt' };
  return element('span', { className: `meeting-status badge ${meta.className}`, text: meta.label });
}

function actionButton(label, className, onClick) {
  const button = element('button', {
    className: `btn btn-sm ${className}`,
    text: label,
    attributes: { type: 'button' },
  });
  button.addEventListener('click', onClick);
  return button;
}

function statTile(label, value, tone = '') {
  return element('div', { className: `meeting-stat card ${tone}` }, [
    element('span', { className: 'meeting-stat-value', text: String(value) }),
    element('span', { className: 'meeting-stat-label', text: label }),
  ]);
}

export async function renderMeetings({ session, signal }) {
  const state = {
    meetings: [],
    stats: { total: 0, counts: { draft: 0, queued: 0, transcribing: 0, done: 0, failed: 0 }, audioBytes: 0, transcriptCount: 0 },
    limits: { maxUploadBytes: 200 * 1024 * 1024 },
    signature: '',
    uploads: [],
    busy: new Set(),
  };

  const page = element('div', { className: 'meetings-page page-enter' });
  const statsRow = element('section', { className: 'meetings-stats', attributes: { 'aria-label': '转写状态统计' } });
  const queueSection = element('section', { className: 'meetings-queue card', attributes: { hidden: '' } });
  const archiveSection = element('section', { className: 'meetings-archive' });
  const archiveGrid = element('div', { className: 'meetings-grid' });
  const notice = element('p', {
    className: 'data-notice',
    attributes: { hidden: '', role: 'status', 'aria-live': 'polite' },
  });

  // ── upload zone ──────────────────────────────────────────────────────────
  const fileInput = element('input', {
    className: 'meetings-file-input',
    attributes: {
      type: 'file',
      multiple: '',
      accept: 'audio/*,.wav,.mp3,.m4a,.mp4,.aac,.ogg,.oga,.opus,.flac,.webm,.amr,.wma',
      'aria-label': '选择会议录音',
    },
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files?.length) void startUpload([...fileInput.files]);
    fileInput.value = '';
  });
  // The zone forwards clicks to the hidden input; a programmatic input click
  // bubbles back up, so stop it here instead of recursing.
  fileInput.addEventListener('click', (event) => event.stopPropagation());

  const dropHint = element('span');
  const dropZone = element('div', { className: 'meetings-drop card', attributes: { tabindex: '0', role: 'button' } }, [
    element('div', { className: 'meetings-drop-icon' }, [icon('meetings', 'icon')]),
    element('div', { className: 'meetings-drop-copy' }, [
      element('strong', { text: '把会议录音拖到这里，或点击选择' }),
      dropHint,
    ]),
    fileInput,
  ]);

  function updateDropHint() {
    dropHint.textContent = `支持 wav / mp3 / m4a / aac / ogg / opus / flac / webm，单个不超过 ${formatBytes(state.limits.maxUploadBytes)}。上传后自动排队转写。`;
  }
  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      fileInput.click();
    }
  });
  for (const type of ['dragenter', 'dragover']) {
    dropZone.addEventListener(type, (event) => {
      event.preventDefault();
      dropZone.setAttribute('data-drag', 'true');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    dropZone.addEventListener(type, (event) => {
      event.preventDefault();
      dropZone.removeAttribute('data-drag');
    });
  }
  dropZone.addEventListener('drop', (event) => {
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length) void startUpload(files);
  });

  const uploadList = element('div', { className: 'meetings-uploads', attributes: { hidden: '' } });

  // ── transcript dialog ────────────────────────────────────────────────────
  const dialogTitle = element('h2', { className: 'meetings-dialog-title', text: '转写稿', attributes: { id: 'meetings-dialog-title' } });
  const dialogBody = element('div', { className: 'meetings-dialog-body' });
  const dialogClose = element('button', {
    className: 'btn btn-icon btn-ghost-secondary',
    attributes: { type: 'button', 'aria-label': '关闭' },
  }, [icon('close', 'icon')]);
  const dialog = element('dialog', { className: 'meetings-dialog', attributes: { 'aria-labelledby': 'meetings-dialog-title' } }, [
    element('div', { className: 'meetings-dialog-head' }, [dialogTitle, dialogClose]),
    dialogBody,
  ]);
  dialogClose.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });

  // ── header ───────────────────────────────────────────────────────────────
  const uploadButton = element('button', {
    className: 'btn btn-primary meetings-upload-button',
    attributes: { type: 'button' },
  }, [icon('meetings', 'icon'), element('span', { text: '上传录音' })]);
  uploadButton.addEventListener('click', () => fileInput.click());

  const refreshButton = actionButton('刷新', 'btn-outline-secondary', () => { void refresh(); });

  page.append(
    pageHeading(
      '会议记录',
      '上传会议录音，自动转写并按会议归档。录音可删除释放空间，转写稿与纪要长期保留。',
      element('div', { className: 'meetings-head-actions' }, [refreshButton, uploadButton]),
    ),
    notice,
    statsRow,
    dropZone,
    uploadList,
    queueSection,
    archiveSection,
    dialog,
  );

  archiveSection.append(
    element('div', { className: 'meetings-section-head' }, [
      element('h2', { className: 'meetings-section-title', text: '归档' }),
      element('span', { className: 'meetings-section-hint', text: '每条会议一个独立文件夹：meta.json + 录音 + 转写稿' }),
    ]),
    archiveGrid,
  );

  function showNotice(message, tone = 'info') {
    notice.textContent = message;
    notice.dataset.tone = tone;
    notice.hidden = !message;
  }

  function setBusy(id, busy) {
    if (busy) state.busy.add(id);
    else state.busy.delete(id);
    render();
  }

  // ── rendering ────────────────────────────────────────────────────────────
  function renderStats() {
    const { counts, audioBytes, transcriptCount, total } = state.stats;
    statsRow.replaceChildren(
      statTile('全部会议', total),
      statTile('待转写', counts.queued + counts.transcribing, 'meeting-stat-active'),
      statTile('已转写', counts.done, 'meeting-stat-done'),
      statTile('录音占用', formatBytes(audioBytes)),
    );
  }

  function renderUploads() {
    if (!state.uploads.length) {
      uploadList.hidden = true;
      uploadList.replaceChildren();
      return;
    }
    uploadList.hidden = false;
    uploadList.replaceChildren(...state.uploads.map((item) => {
      const bar = element('span', { className: 'meetings-progress-bar' });
      bar.style.width = `${Math.round(item.progress * 100)}%`;
      return element('div', { className: 'meetings-upload-row' }, [
        element('span', { className: 'meetings-upload-name', text: item.name }),
        element('span', { className: 'meetings-progress', attributes: { 'aria-hidden': 'true' } }, [bar]),
        element('span', { className: 'meetings-upload-state', text: item.state === 'uploading' ? `${Math.round(item.progress * 100)}%` : item.state === 'done' ? '已上传' : (item.error || '失败') }),
      ]);
    }));
  }

  function renderQueue() {
    const active = state.meetings.filter((meeting) => ACTIVE_STATUSES.has(meeting.status));
    if (!active.length) {
      queueSection.hidden = true;
      queueSection.replaceChildren();
      return;
    }
    queueSection.hidden = false;
    const rows = active.map((meeting) => {
      const position = meeting.queuePosition;
      const detail = meeting.status === 'transcribing'
        ? '正在转写…'
        : (position ? `队列第 ${position} 位` : '排队中');
      return element('div', { className: 'meetings-queue-row' }, [
        element('span', { className: 'meetings-queue-title', text: meeting.title }),
        statusBadge(meeting.status),
        element('span', { className: 'meetings-queue-detail', text: detail }),
      ]);
    });
    queueSection.replaceChildren(
      element('div', { className: 'meetings-section-head' }, [
        element('h2', { className: 'meetings-section-title', text: '转写队列' }),
        element('span', { className: 'meetings-section-hint', text: `共 ${active.length} 条进行中` }),
      ]),
      ...rows,
    );
  }

  function renderMeetingCard(meeting) {
    const transcript = meeting.transcript;
    const audio = meeting.audio;
    const meta = [
      formatDate(meeting.createdAt),
      transcript?.durationMs ? formatDuration(transcript.durationMs) : null,
      transcript?.speakers?.length ? `${transcript.speakers.length} 人` : null,
      audio && !audio.deleted ? formatBytes(audio.bytes) : (audio?.deleted ? '录音已删除' : null),
    ].filter(Boolean).join(' · ');

    const head = element('div', { className: 'meeting-card-head' }, [
      element('div', { className: 'meeting-title-wrap' }, [
        element('span', { className: 'meeting-folder', attributes: { 'aria-hidden': 'true' } }, [icon('meetings', 'icon')]),
        element('h3', { className: 'meeting-title', text: meeting.title }),
      ]),
      statusBadge(meeting.status),
    ]);

    const body = element('div', { className: 'meeting-card-body' }, [
      element('p', { className: 'meeting-meta', text: meta }),
    ]);

    if (meeting.status === 'failed' && meeting.error) {
      body.append(element('p', { className: 'meeting-error', text: meeting.error }));
    }
    if (transcript && meeting.status === 'done') {
      const facts = [`模型 ${transcript.model || '—'}`, transcript.language ? `语言 ${transcript.language}` : null, `${transcript.chars} 字`]
        .filter(Boolean).join(' · ');
      body.append(element('p', { className: 'meeting-facts', text: facts }));
    }

    const actions = element('div', { className: 'meeting-actions' });
    const busy = state.busy.has(meeting.id);

    if (meeting.transcript) {
      actions.append(actionButton('查看转写稿', 'btn-outline-primary', () => void openTranscript(meeting)));
      actions.append(element('a', {
        className: 'btn btn-sm btn-outline-secondary',
        text: '下载 .md',
        attributes: {
          href: `/api/meetings/${meeting.id}/transcript?format=md&download=1`,
          download: '',
        },
      }));
    }
    if (meeting.status === 'failed') {
      actions.append(actionButton(busy ? '排队中…' : '重试转写', 'btn-outline-primary', () => void retry(meeting)));
    }
    // Deleting audio while a job is queued would cancel it mid-flight; hide the
    // action until the job settles.
    if (audio && !audio.deleted && !ACTIVE_STATUSES.has(meeting.status)) {
      actions.append(actionButton(busy ? '处理中…' : '删除录音（保留转写）', 'btn-outline-secondary', () => void removeAudio(meeting)));
    }
    actions.append(actionButton('删除记录', 'btn-outline-danger', () => void removeMeeting(meeting)));

    return element('article', {
      className: `meeting-card card`,
      attributes: { 'data-status': meeting.status, 'data-id': meeting.id },
    }, [head, body, actions]);
  }

  function renderArchive() {
    if (!state.meetings.length) {
      archiveGrid.replaceChildren(element('p', {
        className: 'data-notice meetings-empty',
        text: '还没有会议记录。上传第一段录音后，这里会出现按会议归档的文件夹。',
      }));
      return;
    }
    archiveGrid.replaceChildren(...state.meetings.map(renderMeetingCard));
  }

  function render() {
    renderStats();
    renderUploads();
    renderQueue();
    renderArchive();
  }

  // ── data ─────────────────────────────────────────────────────────────────
  function meetingsSignature(list) {
    return list
      .map((meeting) => [
        meeting.id,
        meeting.status,
        meeting.title,
        meeting.audio?.deleted ? '1' : '0',
        meeting.audio?.bytes ?? '',
        meeting.transcript?.completedAt ?? '',
        meeting.error ?? '',
      ].join(':'))
      .join('|');
  }

  function applyData(data) {
    const meetings = Array.isArray(data.meetings) ? data.meetings : [];
    const stats = data.stats ?? state.stats;
    if (Number.isFinite(data.limits?.maxUploadBytes) && data.limits.maxUploadBytes > 0) {
      state.limits.maxUploadBytes = data.limits.maxUploadBytes;
      updateDropHint();
    }
    const signature = `${meetingsSignature(meetings)}#${JSON.stringify(stats)}`;
    state.meetings = meetings;
    state.stats = stats;
    // Polling must not rebuild the grid when nothing visible changed, or it
    // steals clicks and focus from under the pointer.
    if (signature !== state.signature) {
      state.signature = signature;
      render();
    }
  }

  async function refresh() {
    try {
      const data = await apiRequest('/api/meetings', { signal });
      applyData(data);
      showNotice('');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return;
      if (error?.name === 'AbortError') return;
      showNotice('暂时无法读取会议列表，请稍后重试。', 'error');
    }
  }

  // ── upload ───────────────────────────────────────────────────────────────
  async function startUpload(files) {
    for (const file of files) {
      if (file.size > state.limits.maxUploadBytes) {
        showNotice(`${file.name} 超过 ${formatBytes(state.limits.maxUploadBytes)} 上限，已跳过。`, 'error');
        continue;
      }
      const title = file.name.replace(/\.[^.]+$/, '');
      const item = { name: file.name, progress: 0, state: 'uploading', error: '' };
      state.uploads.push(item);
      renderUploads();
      let id = null;
      try {
        const created = await apiRequest('/api/meetings', {
          method: 'POST',
          csrfToken: session.csrfToken,
          body: { title },
          signal,
        });
        id = created?.meeting?.id;
        if (!id) throw new Error('创建会议记录失败');
        await uploadAudio(id, file, (progress) => {
          item.progress = progress;
          renderUploads();
        });
        item.state = 'done';
        item.progress = 1;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return;
        item.state = 'error';
        item.error = error?.message || '上传失败';
        // An empty meeting record would sit in the queue forever; drop it.
        // Use a fresh request: the route signal is already aborted here.
        if (id) {
          try {
            await apiRequest(`/api/meetings/${id}`, { method: 'DELETE', csrfToken: session.csrfToken });
          } catch {
            // best effort
          }
        }
      } finally {
        renderUploads();
        void refresh();
        setTimeout(() => {
          state.uploads = state.uploads.filter((entry) => entry !== item);
          renderUploads();
        }, item.state === 'done' ? 1500 : 6000);
      }
    }
  }

  function uploadAudio(id, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/meetings/${id}/audio?name=${encodeURIComponent(file.name)}`);
      xhr.setRequestHeader('X-CSRF-Token', session.csrfToken);
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.responseType = 'text';
      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable && event.total) onProgress(event.loaded / event.total);
      });
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          onProgress(1);
          resolve();
          return;
        }
        let message = `上传失败（${xhr.status}）`;
        try {
          const payload = JSON.parse(xhr.responseText);
          if (payload?.error) message = payload.error;
        } catch {
          // keep the status message
        }
        reject(new Error(message));
      });
      xhr.addEventListener('error', () => reject(new Error('上传中断，请检查网络后重试。')));
      xhr.addEventListener('abort', () => reject(new Error('上传已取消。')));
      signal?.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.send(file);
    });
  }

  // ── actions ──────────────────────────────────────────────────────────────
  let transcriptRequest = 0;

  async function openTranscript(meeting) {
    const requestId = ++transcriptRequest;
    dialogTitle.textContent = meeting.title;
    dialogBody.replaceChildren(element('p', { className: 'meetings-dialog-loading', text: '正在读取转写稿…' }));
    if (!dialog.open) dialog.showModal();
    try {
      const data = await apiRequest(`/api/meetings/${meeting.id}/transcript`, { signal });
      if (requestId !== transcriptRequest) return;
      const transcript = data?.transcript;
      if (!transcript) throw new Error('没有转写稿');
      const segments = Array.isArray(transcript.utterances) ? transcript.utterances : [];
      const list = element('div', { className: 'meetings-transcript' });
      for (const segment of segments) {
        list.append(element('div', { className: 'meetings-transcript-row' }, [
          element('span', { className: 'meetings-transcript-speaker', text: `Speaker ${segment.speaker}` }),
          element('span', { className: 'meetings-transcript-time', text: formatClock(segment.start) }),
          element('p', { className: 'meetings-transcript-text', text: segment.text }),
        ]));
      }
      dialogBody.replaceChildren(
        element('div', { className: 'meetings-dialog-facts' }, [
          element('span', { text: `模型 ${transcript.model || '—'}` }),
          element('span', { text: `语言 ${transcript.language || '自动'}` }),
          element('span', { text: formatDuration(transcript.durationMs) }),
          element('span', { text: `${segments.length} 段` }),
        ]),
        list,
      );
    } catch (error) {
      if (requestId !== transcriptRequest) return;
      if (error instanceof ApiError && error.status === 401) return;
      dialogBody.replaceChildren(element('p', { className: 'meetings-error', text: error?.message || '读取转写稿失败。' }));
    }
  }

  async function retry(meeting) {
    setBusy(meeting.id, true);
    try {
      await apiRequest(`/api/meetings/${meeting.id}/transcribe`, {
        method: 'POST',
        csrfToken: session.csrfToken,
        body: {},
        signal,
      });
      showNotice('已重新排队转写。');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return;
      showNotice(error?.message || '重新排队失败。', 'error');
    } finally {
      setBusy(meeting.id, false);
      void refresh();
    }
  }

  async function removeAudio(meeting) {
    if (!window.confirm(`删除「${meeting.title}」的录音文件？\n转写稿会保留，录音占用的空间会被释放。`)) return;
    setBusy(meeting.id, true);
    try {
      await apiRequest(`/api/meetings/${meeting.id}/audio`, {
        method: 'DELETE',
        csrfToken: session.csrfToken,
        signal,
      });
      showNotice('录音已删除，转写稿已保留。');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return;
      showNotice(error?.message || '删除录音失败。', 'error');
    } finally {
      setBusy(meeting.id, false);
      void refresh();
    }
  }

  async function removeMeeting(meeting) {
    if (!window.confirm(`彻底删除「${meeting.title}」？\n录音、转写稿和纪要都会一起删除，无法恢复。`)) return;
    setBusy(meeting.id, true);
    try {
      await apiRequest(`/api/meetings/${meeting.id}`, {
        method: 'DELETE',
        csrfToken: session.csrfToken,
        signal,
      });
      showNotice('会议记录已删除。');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return;
      showNotice(error?.message || '删除失败。', 'error');
    } finally {
      setBusy(meeting.id, false);
      void refresh();
    }
  }

  // ── boot ─────────────────────────────────────────────────────────────────
  updateDropHint();
  render();
  await refresh();

  const poller = createPoller({
    request: (requestSignal) => apiRequest('/api/meetings', { signal: requestSignal }),
    onData: (data) => applyData(data),
    onError: () => {},
    signal,
    intervalMs: 4000,
    timeoutMs: 10000,
  });
  poller.start();
  signal?.addEventListener('abort', () => {
    poller.stop();
    if (dialog.open) dialog.close();
  }, { once: true });

  return page;
}

function formatClock(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
