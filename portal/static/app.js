const app = document.querySelector('#app');
const toastEl = document.querySelector('#toast');
const state = {
  reviewer: null, person: null, questions: [], currentId: null, detail: null,
  payload: null, version: 0, status: 'new', filter: 'all', search: '',
  revision: 0, savedRevision: 0, saving: null, saveTimer: null,
  recording: null, segment: 0, transcript: [], requestSequence: 0,
  captionsEnabled: localStorage.getItem('smvqa_captions') !== 'off',
  reviewShortcutHandler: null,
};
const ISSUE_OPTIONS = [
  'unclear wording', 'incorrect answer key', 'multiple valid choices',
  'insufficient evidence', 'missing evidence', 'wrong timestamps',
  'evidence after question time', 'other',
];
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const pretty = value => String(value ?? '').replaceAll('_', ' ').replace(/\b\w/g, ch => ch.toUpperCase());
const clock = seconds => {
  if (!Number.isFinite(Number(seconds))) return '—';
  const n = Math.max(0, Number(seconds));
  const h = Math.floor(n / 3600), m = Math.floor(n % 3600 / 60), s = Math.floor(n % 60);
  return h ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`;
};
const dateTime = seconds => new Date(Number(seconds) * 1000).toLocaleString(undefined, {dateStyle:'medium',timeStyle:'short'});
const shortVideo = id => String(id || '').replace(/^Person_\d+_/, '').replaceAll('_', ' ');
function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastEl.timer);
  toastEl.timer = setTimeout(() => toastEl.classList.remove('show'), 3200);
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: options.body ? {'Content-Type':'application/json','X-Portal-Request':'1'} : (options.method === 'DELETE' ? {'X-Portal-Request':'1'} : {}),
    ...options,
  });
  let data;
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
function topbar() {
  return `<header class="topbar"><a href="/" class="brand" id="brand"><span class="brand-mark">✳</span><span>SuperMemory <span class="brand-sub">/ Review Studio</span></span></a>
    <div class="top-actions">${state.reviewer ? `<span class="reviewer-name">${esc(state.reviewer.display_name)}</span><button id="change-person">Participants</button><button id="signout">Sign out</button>` : '<span>Independent annotation portal</span>'}</div></header>`;
}
function bindTopbar() {
  document.querySelector('#brand')?.addEventListener('click', async event => {
    event.preventDefault(); if (await flushSave()) { history.pushState({}, '', '/'); showPeople(); }
  });
  document.querySelector('#change-person')?.addEventListener('click', async () => {
    if (await flushSave()) { history.pushState({}, '', '/'); showPeople(); }
  });
  document.querySelector('#signout')?.addEventListener('click', async () => {
    if (!(await flushSave())) return;
    try { await api('/api/session', {method:'DELETE'}); state.reviewer = null; history.pushState({}, '', '/'); showLogin(); }
    catch (error) { toast(error.message); }
  });
}
function showLogin() {
  state.person = null; state.currentId = null;
  app.innerHTML = `${topbar()}<main class="page">
    <section class="hero"><div><div class="eyebrow">SuperMemory-VQA · Agreement study</div>
      <h1>A careful second look at memory questions.</h1>
      <p>Review questions against recordings captured before they were asked. Check the cited evidence, make an independent answer prediction, and save your judgment as you go.</p></div>
      <div class="hero-art" aria-hidden="true"><div class="art-line"></div><div class="art-dot one"></div><div class="art-dot two"></div><span class="art-caption">Evidence · Time · Judgment</span></div></section>
    <section class="panel login-card"><h2>Enter the review studio</h2><p class="muted small">Use your assigned reviewer name and passphrase. A new name creates a private review account; the same credentials resume your drafts.</p>
      <form id="login-form"><div class="field"><label for="reviewer-name">Reviewer name</label><input id="reviewer-name" maxlength="64" minlength="2" required autocomplete="username" placeholder="e.g. Reviewer A"></div>
      <div class="field"><label for="passphrase">Passphrase</label><input id="passphrase" type="password" minlength="8" required autocomplete="current-password" placeholder="At least 8 characters"></div>
      <button class="button" type="submit">Continue to participants →</button><div id="login-error" class="inline-error"></div></form></section></main>`;
  bindTopbar();
  document.querySelector('#login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.target.querySelector('button'); button.disabled = true;
    try {
      const result = await api('/api/session', {method:'POST',body:JSON.stringify({name:document.querySelector('#reviewer-name').value,passphrase:document.querySelector('#passphrase').value})});
      state.reviewer = result.reviewer; history.replaceState({}, '', '/'); await showPeople();
    } catch (error) { document.querySelector('#login-error').textContent = error.message; button.disabled = false; }
  });
}
async function showPeople() {
  state.person = null; state.currentId = null; state.detail = null;
  app.innerHTML = `${topbar()}<main class="page"><p class="muted">Loading participants…</p></main>`; bindTopbar();
  try {
    const {people} = await api('/api/people');
    app.innerHTML = `${topbar()}<main class="page"><section class="select-heading"><div class="eyebrow">Choose a participant</div><h1>Where would you like to begin?</h1><p>Each participant has a separate set of questions. Your progress is saved under your reviewer account.</p></section>
      <details class="guide" open><summary>Quick annotation guide</summary><ol>
      <li>Read the question and answer choices. The answer key is hidden. Choose the answer you independently predict.</li>
      <li>Review every cited GT span, then inspect other eligible recordings and redacted transcripts if needed. Media stops before the question context begins.</li>
      <li>Judge clarity, answerability, and evidence separately. Mark all issues you find and suggest replacement spans when useful.</li>
      <li>Drafts save automatically. Use <strong>Save draft</strong> whenever you want; <strong>Submit review</strong> locks that question.</li>
      </ol></details><section class="people-grid" aria-label="Participants">${people.map(p => {
        const percent = Math.round(p.submitted / p.total * 100);
        return `<button class="person-card" data-person="${p.person}"><div class="number">${String(p.person).padStart(2,'0')}</div><div class="name">Person ${p.person} ↗</div><div class="count">${p.total} questions</div><div class="progress-track"><div class="progress-fill" style="transform:scaleX(${percent/100})"></div></div><div class="done-count">${p.submitted} submitted · ${p.draft} drafts</div></button>`;
      }).join('')}</section></main>`;
    bindTopbar();
    document.querySelectorAll('[data-person]').forEach(button => button.addEventListener('click', () => openPerson(Number(button.dataset.person))));
  } catch (error) { app.querySelector('main').innerHTML = `<p class="inline-error">${esc(error.message)}</p>`; }
}
async function openPerson(person, requestedId = null, push = true) {
  if (!Number.isInteger(person) || person < 1 || person > 10) { showPeople(); return; }
  if (!(await flushSave())) return;
  state.person = person; state.currentId = null; state.detail = null;
  state.filter = 'all'; state.search = '';
  app.innerHTML = `${topbar()}<main class="page"><p class="muted">Loading Person ${person} questions…</p></main>`; bindTopbar();
  try {
    const response = await api(`/api/people/${person}/questions`);
    state.questions = response.questions;
    const first = state.questions.find(q => q.status !== 'submitted') || state.questions[0];
    const id = state.questions.some(q => q.question_id === requestedId) ? requestedId : first?.question_id;
    app.innerHTML = `${topbar()}<div class="workspace"><aside class="sidebar">
      <div class="side-head"><button class="back" id="back-people">← All participants</button><h2>Person ${person}</h2><p id="side-progress"></p></div>
      <div class="side-search"><input class="search-input" id="question-search" placeholder="Find question or ID…" aria-label="Search questions">
      <div class="filter-row" role="group" aria-label="Question status"><button data-filter="all" class="active">All</button><button data-filter="new">New</button><button data-filter="draft">Drafts</button><button data-filter="submitted">Done</button></div></div>
      <div class="question-list" id="question-list"></div></aside><main class="review-main" id="review-main"><p class="muted">Loading question…</p></main></div>`;
    bindTopbar();
    document.querySelector('#back-people').addEventListener('click', async () => { if (await flushSave()) { history.pushState({}, '', '/'); showPeople(); }});
    document.querySelector('#question-search').addEventListener('input', event => { state.search = event.target.value.toLowerCase(); renderQuestionList(); });
    document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
      state.filter = button.dataset.filter;
      document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('active', b === button));
      renderQuestionList();
    }));
    renderQuestionList();
    if (id) await openQuestion(id, push);
  } catch (error) { document.querySelector('#review-main, main')?.replaceChildren(document.createTextNode(error.message)); }
}
function renderQuestionList() {
  const list = document.querySelector('#question-list');
  if (!list) return;
  const done = state.questions.filter(q => q.status === 'submitted').length;
  const draft = state.questions.filter(q => q.status === 'draft').length;
  document.querySelector('#side-progress').textContent = `${done} of ${state.questions.length} submitted · ${draft} drafts`;
  const visible = state.questions.filter(q => (state.filter === 'all' || q.status === state.filter) &&
    (!state.search || `${q.question_id} ${q.question}`.toLowerCase().includes(state.search)));
  list.innerHTML = visible.length ? visible.map(q => `<button class="question-link ${q.status} ${q.question_id === state.currentId ? 'active' : ''}" data-question="${q.question_id}">
    <span class="qnumber">${q.status === 'submitted' ? '✓' : q.status === 'draft' ? '•' : '#'}</span><span><span class="qtext">${esc(q.question)}</span><span class="qstatus">Q${q.question_id} · ${q.status}</span></span></button>`).join('') : '<div class="transcript-empty">No questions match this filter.</div>';
  list.querySelectorAll('[data-question]').forEach(button => button.addEventListener('click', () => openQuestion(Number(button.dataset.question))));
}
function defaultPayload() {
  return {clarity:null,answerability:null,evidence_correctness:null,predicted_choice:null,
    issues:[],other_issue:'',feedback:'',edit_evidence:false,edited_spans:[]};
}
async function openQuestion(id, push = true) {
  if (id === state.currentId && state.detail) return;
  if (!(await flushSave())) return;
  const sequence = ++state.requestSequence;
  document.querySelector('#review-main').innerHTML = '<p class="muted">Loading question…</p>';
  try {
    const [detail, reviewResponse] = await Promise.all([
      api(`/api/questions/${id}`), api(`/api/questions/${id}/review`),
    ]);
    if (sequence !== state.requestSequence) return;
    state.currentId = id; state.detail = detail;
    state.payload = reviewResponse.review?.payload || defaultPayload();
    state.version = reviewResponse.review?.version || 0;
    state.status = reviewResponse.review?.status || 'new';
    state.revision = 0; state.savedRevision = 0; state.recording = null; state.segment = 0; state.transcript = [];
    if (push) history.pushState({}, '', `/review/${state.person}/${id}`);
    renderQuestion(); renderQuestionList();
    document.querySelector(`.question-link[data-question="${id}"]`)?.scrollIntoView({block:'nearest',inline:'nearest'});
  } catch (error) { document.querySelector('#review-main').innerHTML = `<div class="panel card inline-error">${esc(error.message)}</div>`; }
}
function radioGroup(name, values, current) {
  return `<div class="segmented">${values.map(value => `<label><input type="radio" name="${name}" value="${esc(value)}" ${current === value ? 'checked' : ''}><span>${esc(value)}</span></label>`).join('')}</div>`;
}
function renderQuestion() {
  const q = state.detail, p = state.payload;
  const eligible = new Set(q.recordings.map(r => r.video_id));
  const transcripts = new Set(q.recordings.filter(r => r.transcript_available).map(r => r.video_id));
  const evidence = q.evidence_spans.length ? q.evidence_spans.map((span, i) => `<article class="evidence-item">
    <div class="evidence-head"><strong>Span ${i + 1} · ${esc(span.video_id)}</strong><span class="badge ${span.within_cutoff ? 'neutral' : 'danger'}">${span.within_cutoff ? 'GT cited' : 'After cutoff'}</span></div>
    <div class="evidence-meta"><span class="time">${clock(span.start)} – ${clock(span.end)}</span>${span.modalities.map(m => `<span class="tiny-tag">${esc(m)}</span>`).join('')}
    <button type="button" class="button secondary" data-evidence="${i}" ${!span.within_cutoff || !eligible.has(span.video_id) ? 'disabled' : ''}>Jump to span ↗</button>
    ${span.modalities.includes('Audio') && span.within_cutoff && transcripts.has(span.video_id) ? `<button type="button" class="button transcript-action" data-transcript="${i}" aria-expanded="false">Read transcript ▾</button>` : ''}
    ${span.modalities.includes('Audio') && !transcripts.has(span.video_id) ? '<span class="tiny-tag">Transcript unavailable</span>' : ''}</div>
    <div class="audio-excerpt hidden" id="audio-excerpt-${i}"></div></article>`).join('') : '<div class="empty-state">No GT answer evidence spans are cited for this question. Review other eligible recordings before judging answerability.</div>';
  const choices = q.choices.map((choice, i) => `<label class="choice ${p.predicted_choice === i ? 'selected' : ''}"><input type="radio" name="predicted_choice" value="${i}" ${p.predicted_choice === i ? 'checked' : ''}><span class="choice-letter">${String.fromCharCode(65+i)}</span><span>${esc(choice)}</span></label>`).join('');
  const recordings = q.recordings.map(r => `<option value="${esc(r.video_id)}">${esc(shortVideo(r.video_id))} · ${dateTime(r.recording_start_unix)}${r.transcript_available ? ' · transcript' : ''}${r.video_available ? '' : ' · video pending'}</option>`).join('');
  document.querySelector('#review-main').innerHTML = `
    <div class="review-top"><span class="crumb">Person ${q.person} / Question ${q.question_id} / ${state.questions.findIndex(row => row.question_id === q.question_id)+1} of ${state.questions.length}</span><span class="save-state" id="save-state"><i class="save-dot"></i><span>${state.status === 'submitted' ? 'Submitted' : state.status === 'draft' ? 'Draft saved' : 'New review'}</span></span></div>
    <section class="panel question-card"><div class="q-card-top"><span class="badge">${esc(pretty(q.category))}</span><span class="badge neutral">Q${q.question_id}</span></div>
      <h1>${esc(q.question)}</h1><div class="meta-strip"><div class="meta-item"><span>Participant</span><strong>Person ${q.person}</strong></div>
      <div class="meta-item"><span>Question cutoff</span><strong>${dateTime(q.question_time_unix)}</strong></div>
      <div class="meta-item"><span>Question session</span><strong>${esc(q.primary_video_id || 'Unknown')}</strong></div>
      <div class="meta-item"><span>Timing basis</span><strong>${esc(q.question_time_basis)}</strong></div></div>
      <p class="section-kicker">Predict the answer <span class="required">*</span></p><div class="choices" id="choices">${choices}</div></section>
    <div class="content-grid"><div class="stack">
      <section class="panel card"><div class="card-head"><div><h2>Ground truth evidence</h2><p>All cited spans are shown without the answer key or evidence text.</p></div><span class="badge neutral">${q.evidence_spans.length} spans</span></div><div class="evidence-list">${evidence}</div>
      ${q.evidence_spans.some(span => !span.within_cutoff) ? '<div class="notice warn">A cited span is after the question cutoff. Its video and transcript are blocked. Mark the timing issue in your review.</div>' : ''}</section>
      <section class="panel card"><div class="card-head"><div><h2>Eligible recordings</h2><p>Browse recordings captured before the question context began.</p></div><span class="badge neutral">${q.recordings.length}</span></div>
        ${q.recordings.length ? `<select class="recording-select" id="recording-select" aria-label="Choose eligible recording"><option value="">Select a recording…</option>${recordings}</select>` : '<div class="empty-state">No recording lies before the conservative question cutoff.</div>'}
        <div class="video-box" id="video-box"><video id="video" controls playsinline preload="none"></video><div id="video-caption" class="video-caption hidden" aria-live="off"></div><div class="video-placeholder" id="video-placeholder"><strong>Choose a recording</strong>Then select a point on its timeline or jump to a cited span.</div></div>
        <div id="timeline-wrap" class="hidden"><div class="timeline-head"><span>Recording timeline</span><span id="position-label">0:00 / 0:00</span></div>
          <input id="timeline" class="timeline" type="range" min="0" max="1" step="0.1" value="0" aria-label="Seek within eligible recording"><div class="timeline-times"><span>Start</span><span id="timeline-end">Question cutoff</span></div>
          <div class="video-actions"><button class="button secondary" id="play-point" type="button">Play from here ▶</button><button class="button secondary" id="toggle-captions" type="button" aria-pressed="${state.captionsEnabled}">${state.captionsEnabled ? 'CC On' : 'CC Off'}</button><span class="video-status" id="video-status"></span></div></div>
        <div id="transcript-section"><div class="timeline-head"><span>Redacted transcript</span><span class="muted small" id="transcript-source"></span></div><div class="transcript" id="transcript"><div class="transcript-empty">Choose a recording to load its transcript.</div></div></div>
        <div class="notice">Only eligible time is served. The player loads short, server-clipped segments; source videos are never exposed directly.</div></section>
    </div><div class="stack"><section class="panel card"><div class="card-head"><div><h2>Your independent review</h2><p>Choose each required judgment, then submit.</p></div></div>
      ${state.status === 'submitted' ? '<div class="locked-banner">✓ Submitted. This review is locked to preserve independent judgments.</div>' : ''}
      <form id="review-form" class="review-form ${state.status === 'submitted' ? 'locked' : ''}">
        <div class="form-group"><p class="group-title">1. Question clarity <span class="required">*</span></p>${radioGroup('clarity',['Clear','Unclear'],p.clarity)}</div>
        <div class="form-group"><p class="group-title">2. Answerability from eligible recordings <span class="required">*</span></p>${radioGroup('answerability',['Answerable','Unanswerable','Unable to verify within the review'],p.answerability)}</div>
        <div class="form-group"><p class="group-title">3. GT evidence correctness <span class="required">*</span></p>${radioGroup('evidence_correctness',['Sufficient and correctly timed','Partly sufficient or needs revision','Insufficient or wrong','Not applicable'],p.evidence_correctness)}</div>
        <div class="form-group"><p class="group-title">4. GT evidence edit</p><label class="edit-toggle"><input id="edit-evidence" type="checkbox" ${p.edit_evidence ? 'checked' : ''}>Suggest replacement evidence spans</label>
          <div id="edit-area" class="${p.edit_evidence ? '' : 'hidden'}"><p class="small muted">These spans replace the full GT set. Use eligible recordings and times before the cutoff.</p><div class="edit-list" id="edit-list"></div><div class="edit-actions"><button class="button ghost" id="add-span" type="button">+ Add span</button><span class="small muted">Use 0 spans to recommend removal.</span></div></div></div>
        <div class="form-group"><p class="group-title">5. Issue reasons <span class="muted small">(select all that apply)</span></p><div class="checks">${ISSUE_OPTIONS.map(issue => `<label class="check"><input type="checkbox" name="issue" value="${esc(issue)}" ${p.issues.includes(issue) ? 'checked' : ''}><span>${esc(pretty(issue))}</span></label>`).join('')}</div>
          <div class="field ${p.issues.includes('other') ? '' : 'hidden'}" id="other-wrap" style="margin-top:12px"><label for="other-issue">Describe other issue</label><input id="other-issue" maxlength="500" value="${esc(p.other_issue)}"></div></div>
        <div class="form-group"><p class="group-title">6. Predicted answer choice <span class="required">*</span></p><p class="small muted" id="prediction-summary">${p.predicted_choice == null ? 'Choose an answer in the question card above.' : `Choice ${String.fromCharCode(65+p.predicted_choice)} selected above.`}</p></div>
        <div class="form-group"><div class="field" style="margin-bottom:0"><label for="feedback">7. Feedback <span class="muted small">(optional)</span></label><textarea id="feedback" maxlength="5000" placeholder="Explain uncertain judgments or suggest a correction…">${esc(p.feedback)}</textarea></div></div>
        <div class="form-footer"><div><button type="button" class="button ghost" id="previous-q">← Previous</button><button type="button" class="button ghost" id="next-q">Next →</button></div>
          <div class="right"><button type="button" class="button secondary" id="save-draft">Save draft</button><button type="submit" class="button green" id="submit-review">Submit review</button></div></div><div id="form-error" class="form-error"></div>
      </form></section><details class="guide"><summary>Review guide</summary><ol><li>Predict from recordings available before the question.</li><li>Rate the cited evidence independently of your predicted answer.</li><li>Mark missing or late evidence as an issue, and suggest corrected spans where possible.</li><li>Drafts autosave. Submitted reviews automatically open the next question.</li><li>Press <strong>A</strong> for Clear / Answerable / Sufficient and submit, or <strong>D</strong> for Clear / Unable to verify / Not applicable and submit. Shortcuts are disabled while typing.</li><li>The redacted transcript panel is expanded by default after opening a question.</li></ol></details></div></div>`;
  bindQuestion();
  if (p.edit_evidence) renderEditedSpans();
  if (state.status === 'submitted') document.querySelectorAll('#choices input').forEach(input => input.disabled = true);
}
function currentEditRows() {
  return [...document.querySelectorAll('.edit-row')].map(row => ({
    video_id: row.querySelector('[name="edit-video"]').value,
    start: row.querySelector('[name="edit-start"]').value === '' ? null : Number(row.querySelector('[name="edit-start"]').value),
    end: row.querySelector('[name="edit-end"]').value === '' ? null : Number(row.querySelector('[name="edit-end"]').value),
    modalities: row.querySelector('[name="edit-modalities"]').value.split(',').map(x => x.trim()).filter(Boolean),
  }));
}
function renderEditedSpans(rows = state.payload.edited_spans) {
  const list = document.querySelector('#edit-list');
  if (!list) return;
  list.innerHTML = rows.map((row, i) => `<div class="edit-row" data-edit="${i}">
    <label class="wide">Recording<select name="edit-video">${state.detail.recordings.map(r => `<option value="${esc(r.video_id)}" ${r.video_id === row.video_id ? 'selected' : ''}>${esc(shortVideo(r.video_id))}</option>`).join('')}</select></label>
    <label>Start (seconds)<input name="edit-start" type="number" min="0" step="0.1" value="${row.start ?? ''}"></label><label>End (seconds)<input name="edit-end" type="number" min="0" step="0.1" value="${row.end ?? ''}"></label>
    <label class="wide">Modalities, separated by commas<input name="edit-modalities" value="${esc((row.modalities || []).join(', '))}" placeholder="Video, Audio"></label>
    <button class="remove" data-remove="${i}" type="button">Remove span</button></div>`).join('');
  list.querySelectorAll('[data-remove]').forEach(button => button.addEventListener('click', () => {
    const current = currentEditRows(); current.splice(Number(button.dataset.remove),1); renderEditedSpans(current); changed();
  }));
  list.querySelectorAll('input,select').forEach(input => input.addEventListener('input', changed));
}
function bindQuestion() {
  const q = state.detail;
  if (state.reviewShortcutHandler) document.removeEventListener('keydown', state.reviewShortcutHandler);
  state.reviewShortcutHandler = async event => {
    if (event.repeat || state.status === 'submitted' || !state.detail ||
        ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(document.activeElement?.tagName)) return;
    const presets = {
      a: {clarity:'Clear', answerability:'Answerable', evidence_correctness:'Sufficient and correctly timed'},
      d: {clarity:'Clear', answerability:'Unable to verify within the review', evidence_correctness:'Not applicable'},
    };
    const preset = presets[event.key.toLowerCase()];
    if (!preset) return;
    event.preventDefault();
    for (const [name, value] of Object.entries(preset)) {
      const input = document.querySelector(`input[name="${name}"][value="${CSS.escape(value)}"]`);
      if (input) input.checked = true;
    }
    changed();
    await submitReview();
  };
  document.addEventListener('keydown', state.reviewShortcutHandler);
  document.querySelectorAll('[data-evidence]').forEach(button => button.addEventListener('click', () => {
    const span = q.evidence_spans[Number(button.dataset.evidence)];
    chooseRecording(span.video_id); seekTo(span.start, true);
  }));
  document.querySelectorAll('[data-transcript]').forEach(button => {
    button.addEventListener('click', () => showAudioTranscript(Number(button.dataset.transcript), button));
    showAudioTranscript(Number(button.dataset.transcript), button);
  });
  document.querySelector('#recording-select')?.addEventListener('change', event => chooseRecording(event.target.value));
  document.querySelector('#timeline')?.addEventListener('input', event => {
    document.querySelector('#position-label').textContent = `${clock(event.target.value)} / ${clock(state.recording?.allowed_until)}`;
  });
  document.querySelector('#timeline')?.addEventListener('change', event => seekTo(Number(event.target.value), false));
  document.querySelector('#play-point')?.addEventListener('click', () => seekTo(Number(document.querySelector('#timeline').value), true));
  document.querySelector('#toggle-captions')?.addEventListener('click', () => {
    state.captionsEnabled = !state.captionsEnabled;
    localStorage.setItem('smvqa_captions', state.captionsEnabled ? 'on' : 'off');
    const button = document.querySelector('#toggle-captions');
    button.textContent = state.captionsEnabled ? 'CC On' : 'CC Off';
    button.setAttribute('aria-pressed', String(state.captionsEnabled));
    updatePlayback();
  });
  document.querySelector('#video')?.addEventListener('timeupdate', updatePlayback);
  document.querySelector('#video')?.addEventListener('ended', () => {
    if (state.recording && (state.segment+1)*45 < state.recording.allowed_until - .3) seekTo((state.segment+1)*45, true);
  });
  document.querySelector('#video')?.addEventListener('error', () => {
    const status = document.querySelector('#video-status'); if (status) status.textContent = 'Could not load this segment. Check the server log.';
  });
  document.querySelector('#choices')?.addEventListener('change', () => {
    document.querySelectorAll('.choice').forEach(row => row.classList.toggle('selected', row.querySelector('input').checked));
    const selected = document.querySelector('[name="predicted_choice"]:checked');
    document.querySelector('#prediction-summary').textContent = selected ? `Choice ${String.fromCharCode(65+Number(selected.value))} selected above.` : 'Choose an answer above.';
    changed();
  });
  document.querySelector('#review-form').addEventListener('input', changed);
  document.querySelector('#review-form').addEventListener('change', event => {
    if (event.target.id === 'edit-evidence') {
      const area = document.querySelector('#edit-area'); area.classList.toggle('hidden', !event.target.checked);
      if (event.target.checked && !document.querySelector('.edit-row')) {
        renderEditedSpans(q.evidence_spans.filter(s => s.within_cutoff && q.recordings.some(r => r.video_id === s.video_id)).map(s => ({video_id:s.video_id,start:s.start,end:s.end,modalities:s.modalities})));
      }
    }
    if (event.target.name === 'issue') document.querySelector('#other-wrap').classList.toggle('hidden', ![...document.querySelectorAll('[name="issue"]:checked')].some(x => x.value === 'other'));
    changed();
  });
  document.querySelector('#add-span').addEventListener('click', () => {
    const rows = currentEditRows(); rows.push({video_id:q.recordings[0]?.video_id || '',start:null,end:null,modalities:[]}); renderEditedSpans(rows); changed();
  });
  document.querySelector('#save-draft').addEventListener('click', () => saveDraft(true));
  document.querySelector('#review-form').addEventListener('submit', async event => { event.preventDefault(); await submitReview(); });
  document.querySelector('#previous-q').addEventListener('click', () => moveQuestion(-1));
  document.querySelector('#next-q').addEventListener('click', () => moveQuestion(1));
  const index = state.questions.findIndex(item => item.question_id === q.question_id);
  document.querySelector('#previous-q').disabled = index <= 0;
  document.querySelector('#next-q').disabled = index >= state.questions.length-1;
}
function collectPayload() {
  const radio = name => document.querySelector(`input[name="${name}"]:checked`)?.value ?? null;
  const choice = radio('predicted_choice');
  return {
    clarity:radio('clarity'),answerability:radio('answerability'),evidence_correctness:radio('evidence_correctness'),
    predicted_choice:choice === null ? null : Number(choice),
    issues:[...document.querySelectorAll('[name="issue"]:checked')].map(input => input.value),
    other_issue:document.querySelector('#other-issue').value,
    feedback:document.querySelector('#feedback').value,
    edit_evidence:document.querySelector('#edit-evidence').checked,
    edited_spans:currentEditRows(),
  };
}
function setSaveState(kind, message) {
  const element = document.querySelector('#save-state'); if (!element) return;
  element.className = `save-state ${kind}`; element.querySelector('span').textContent = message;
}
function changed() {
  if (state.status === 'submitted') return;
  state.revision++; setSaveState('pending','Unsaved changes');
  clearTimeout(state.saveTimer); state.saveTimer = setTimeout(() => saveDraft(), 850);
  document.querySelector('#form-error').textContent = '';
}
async function saveDraft(force = false) {
  if (!state.detail || state.status === 'submitted') return true;
  if (state.saving) { await state.saving; if (!force && state.revision <= state.savedRevision) return true; }
  if (!force && state.revision <= state.savedRevision) return true;
  clearTimeout(state.saveTimer);
  const id = state.currentId, revision = state.revision, payload = collectPayload();
  setSaveState('pending','Saving draft…');
  const work = api(`/api/questions/${id}/review`, {method:'POST',body:JSON.stringify({payload,version:state.version,submit:false})});
  state.saving = work;
  try {
    const response = await work;
    if (id !== state.currentId) return true;
    state.version = response.version; state.savedRevision = revision; state.status = 'draft';
    state.payload = payload;
    const row = state.questions.find(item => item.question_id === id); if (row) row.status = 'draft';
    setSaveState('saved',`Draft saved · ${new Date(response.saved_at).toLocaleTimeString()}`);
    renderQuestionList();
    return true;
  } catch (error) {
    if (id === state.currentId) { setSaveState('error','Save failed'); document.querySelector('#form-error').textContent = error.message; }
    return false;
  } finally {
    if (state.saving === work) state.saving = null;
    if (id === state.currentId && state.revision > state.savedRevision) {
      clearTimeout(state.saveTimer); state.saveTimer = setTimeout(() => saveDraft(), 850);
    }
  }
}
async function flushSave() {
  clearTimeout(state.saveTimer);
  if (state.saving) { try { await state.saving; } catch { return false; } }
  if (state.detail && state.status !== 'submitted' && state.revision > state.savedRevision) return saveDraft();
  return true;
}
async function submitReview() {
  if (state.status === 'submitted') return;
  if (!(await flushSave())) return;
  const payload = collectPayload();
  const button = document.querySelector('#submit-review'); button.disabled = true;
  try {
    const response = await api(`/api/questions/${state.currentId}/review`, {method:'POST',body:JSON.stringify({payload,version:state.version,submit:true})});
    state.version = response.version; state.status = 'submitted'; state.payload = payload;
    state.savedRevision = state.revision;
    const row = state.questions.find(item => item.question_id === state.currentId); if (row) row.status = 'submitted';
    document.querySelector('#review-form').classList.add('locked');
    document.querySelector('#review-form').insertAdjacentHTML('afterbegin','<div class="locked-banner">✓ Submitted. This review is locked to preserve independent judgments.</div>');
    document.querySelectorAll('#choices input').forEach(input => input.disabled = true);
    setSaveState('saved','Submitted'); renderQuestionList();
    const index = state.questions.findIndex(item => item.question_id === state.currentId);
    const next = state.questions[index + 1];
    if (next) {
      toast('Review submitted. Opening the next question.');
      await openQuestion(next.question_id);
    } else {
      toast('Review submitted. This was the last question.');
    }
  } catch (error) { document.querySelector('#form-error').textContent = error.message; button.disabled = false; }
}
function moveQuestion(delta) {
  const index = state.questions.findIndex(item => item.question_id === state.currentId);
  const next = state.questions[index+delta]; if (next) openQuestion(next.question_id);
}
function clearCaption() {
  const box = document.querySelector('#video-caption');
  if (!box) return;
  box.classList.add('hidden');
  box.replaceChildren();
  box.dataset.lines = '';
}
function captionChunks(text) {
  const chunks = [];
  let current = '';
  for (const word of String(text || '').trim().split(/\s+/)) {
    if (current && current.length + word.length + 1 > 110) {
      chunks.push(current);
      current = word;
    } else current += `${current ? ' ' : ''}${word}`;
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [''];
}
function updateCaption(at) {
  const box = document.querySelector('#video-caption');
  const video = document.querySelector('#video');
  if (!box || !video || video.readyState < 1 || !state.captionsEnabled || !state.recording?.transcript_available) {
    clearCaption();
    return;
  }
  const rows = state.transcript.filter(row => row.text.trim() && row.start <= at + .08 && row.end > at).slice(0, 2).map(row => {
    const chunks = captionChunks(row.text);
    const progress = Math.max(0, Math.min(.999, (at - row.start) / Math.max(.01, row.end - row.start)));
    const index = Math.floor(progress * chunks.length);
    return {row, text: chunks[index], index};
  });
  const key = rows.map(({row, index}) => `${row.start}:${row.end}:${index}`).join('|');
  if (box.dataset.lines === key) return;
  box.dataset.lines = key;
  box.classList.toggle('hidden', !rows.length);
  box.innerHTML = rows.map(({row, text}) => `<div class="caption-line">${row.speaker ? `<span class="caption-speaker">${esc(row.speaker)}</span>` : ''}<span>${esc(text)}</span></div>`).join('');
}
async function showAudioTranscript(index, button) {
  const span = state.detail.evidence_spans[index];
  const box = document.querySelector(`#audio-excerpt-${index}`);
  if (!span || !box) return;
  if (!box.classList.contains('hidden')) {
    box.classList.add('hidden');
    button.setAttribute('aria-expanded', 'false');
    button.textContent = 'Read transcript ▾';
    return;
  }
  box.classList.remove('hidden');
  button.setAttribute('aria-expanded', 'true');
  button.textContent = 'Hide transcript ▴';
  box.innerHTML = '<div class="transcript-empty">Loading redacted transcript around this audio span…</div>';
  const recording = state.detail.recordings.find(row => row.video_id === span.video_id);
  const from = Math.max(0, span.start - 5);
  const to = Math.min(span.end + 5, from + 119.5, recording.allowed_until - .25);
  if (to <= from) {
    box.innerHTML = '<div class="transcript-empty">This audio span ends at the review cutoff.</div>';
    return;
  }
  const questionId = state.currentId;
  try {
    const result = await api(`/api/questions/${questionId}/transcript?video=${encodeURIComponent(span.video_id)}&from=${from}&to=${to}`);
    if (state.currentId !== questionId || !box.isConnected) return;
    box.innerHTML = result.rows.length ? `<div class="audio-excerpt-heading">Redacted transcript · ${clock(from)}–${clock(to)}</div>${result.rows.map((row, rowIndex) => `
      <div class="audio-line ${row.start < span.end && row.end > span.start ? 'in-evidence' : ''}">
        <time>${clock(row.start)}</time><span>${row.speaker ? `<strong>${esc(row.speaker)}:</strong> ` : ''}${esc(row.text)}</span>
        <button type="button" data-audio-line="${rowIndex}" aria-label="Play video at ${clock(row.start)}">▶</button></div>`).join('')}` :
      '<div class="transcript-empty">No redacted transcript lines overlap this span. Check the video and note the issue if needed.</div>';
    box.querySelectorAll('[data-audio-line]').forEach(playButton => playButton.addEventListener('click', () => {
      chooseRecording(span.video_id);
      seekTo(result.rows[Number(playButton.dataset.audioLine)].start, true);
      document.querySelector('#video-box').scrollIntoView({block:'center',behavior:'smooth'});
    }));
  } catch (error) {
    box.innerHTML = `<div class="transcript-empty">${esc(error.message)}</div>`;
  }
}
function chooseRecording(videoId) {
  const r = state.detail.recordings.find(row => row.video_id === videoId);
  state.recording = r || null; state.segment = 0; state.transcript = [];
  clearCaption();
  const video = document.querySelector('#video'); video.pause(); video.removeAttribute('src'); video.load();
  document.querySelector('#video-box').classList.remove('has-video');
  document.querySelector('#recording-select').value = r?.video_id || '';
  document.querySelector('#timeline-wrap').classList.toggle('hidden', !r);
  document.querySelector('#toggle-captions').disabled = !r?.transcript_available;
  if (!r) { document.querySelector('#video-placeholder').innerHTML = '<strong>Choose a recording</strong>Then select a point on its timeline or jump to a cited span.'; return; }
  const timeline = document.querySelector('#timeline'); timeline.max = Math.max(0, r.allowed_until-.3); timeline.value = 0;
  document.querySelector('#timeline-end').textContent = clock(r.allowed_until);
  document.querySelector('#position-label').textContent = `0:00 / ${clock(r.allowed_until)}`;
  document.querySelector('#video-status').textContent = r.video_available ? 'Select a point to load video.' : (r.video_error || 'Video file is not yet present locally.');
  document.querySelector('#video-placeholder').innerHTML = r.video_available ? '<strong>Ready to inspect</strong>Press Play from here or select a point on the timeline.' : `<strong>Video unavailable</strong>${esc(r.video_error || 'The video file is not yet present locally. The transcript remains available if present.')}`;
  document.querySelector('#transcript-source').textContent = r.transcript_available ? 'Time-aligned to this recording' : '';
  if (r.transcript_available) refreshTranscript(0);
  else document.querySelector('#transcript').innerHTML = '<div class="transcript-empty">No redacted transcript file is available for this recording.</div>';
}
async function seekTo(value, play) {
  const r = state.recording; if (!r) return;
  const at = Math.max(0,Math.min(Number(value) || 0,r.allowed_until-.35));
  document.querySelector('#timeline').value = at;
  document.querySelector('#position-label').textContent = `${clock(at)} / ${clock(r.allowed_until)}`;
  const segment = Math.floor(at / 45);
  state.segment = segment;
  clearCaption();
  refreshTranscript(segment);
  if (!r.video_available) return;
  const video = document.querySelector('#video');
  const nextSrc = `/api/questions/${state.currentId}/media/${encodeURIComponent(r.video_id)}?segment=${segment}`;
  const offset = at - segment*45;
  document.querySelector('#video-status').textContent = 'Preparing a time-limited video segment…';
  if (video.getAttribute('src') === nextSrc && video.readyState >= 1) {
    video.currentTime = Math.min(offset, Math.max(0,video.duration-.1));
    updatePlayback();
    if (play) video.play().catch(() => {});
    return;
  }
  video.pause(); video.src = nextSrc; video.load();
  video.addEventListener('loadedmetadata', () => {
    if (state.recording?.video_id !== r.video_id || state.segment !== segment) return;
    video.currentTime = Math.min(offset,Math.max(0,video.duration-.1));
    document.querySelector('#video-box').classList.add('has-video');
    document.querySelector('#video-status').textContent = `Playing ${clock(segment*45)}–${clock(Math.min((segment+1)*45,r.allowed_until))} of eligible recording.`;
    if (play) video.play().catch(() => {});
  }, {once:true});
}
async function refreshTranscript(segment) {
  const r = state.recording;
  const box = document.querySelector('#transcript');
  if (!r || !r.transcript_available || !box) return;
  const id = state.currentId, videoId = r.video_id;
  state.transcript = [];
  clearCaption();
  box.innerHTML = '<div class="transcript-empty">Loading redacted transcript…</div>';
  try {
    const result = await api(`/api/questions/${id}/transcript?video=${encodeURIComponent(videoId)}&from=${segment*45}&to=${(segment+1)*45}`);
    if (state.currentId !== id || state.recording?.video_id !== videoId || state.segment !== segment) return;
    state.transcript = result.rows;
    box.innerHTML = result.rows.length ? result.rows.map((row,i) => `<button type="button" class="transcript-row" data-line="${i}"><time>${clock(row.start)}</time><span>${row.speaker ? `<b>${esc(row.speaker)}:</b> ` : ''}${esc(row.text)}</span></button>`).join('') : '<div class="transcript-empty">No redacted transcript lines in this window. Move the timeline to inspect another window.</div>';
    box.querySelectorAll('[data-line]').forEach(button => button.addEventListener('click', () => seekTo(result.rows[Number(button.dataset.line)].start, true)));
    updatePlayback();
  } catch (error) { state.transcript = []; clearCaption(); box.innerHTML = `<div class="transcript-empty">${esc(error.message)}</div>`; }
}
function updatePlayback() {
  const r = state.recording, video = document.querySelector('#video');
  if (!r || !video || !Number.isFinite(video.currentTime)) return;
  const at = Math.min(r.allowed_until,state.segment*45 + video.currentTime);
  document.querySelector('#timeline').value = at;
  document.querySelector('#position-label').textContent = `${clock(at)} / ${clock(r.allowed_until)}`;
  const buttons = [...document.querySelectorAll('.transcript-row')];
  let active = -1;
  state.transcript.forEach((row,i) => { if (row.start <= at && row.end >= at) active = i; });
  buttons.forEach((button,i) => button.classList.toggle('active', i === active));
  if (active >= 0) {
    const container = document.querySelector('#transcript');
    const rowBox = buttons[active].getBoundingClientRect();
    const panelBox = container.getBoundingClientRect();
    if (rowBox.top < panelBox.top) container.scrollTop -= panelBox.top - rowBox.top + 4;
    else if (rowBox.bottom > panelBox.bottom) container.scrollTop += rowBox.bottom - panelBox.bottom + 4;
  }
  updateCaption(at);
}
window.addEventListener('popstate', async () => {
  const match = location.pathname.match(/^\/review\/(10|[1-9])\/(\d+)$/);
  if (match && state.reviewer) await openPerson(Number(match[1]),Number(match[2]),false);
  else if (state.reviewer) showPeople(); else showLogin();
});
(async () => {
  try {
    const session = await api('/api/session'); state.reviewer = session.reviewer;
    if (!state.reviewer) { showLogin(); return; }
    const match = location.pathname.match(/^\/review\/(10|[1-9])\/(\d+)$/);
    if (match) await openPerson(Number(match[1]),Number(match[2]),false); else await showPeople();
  } catch (error) { app.innerHTML = `<main class="page"><p class="inline-error">${esc(error.message)}</p></main>`; }
})();
