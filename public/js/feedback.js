import { requestJson, friendlyError } from './api.js';

export function initFeedback() {
  const form = document.querySelector('#feedback-form');
  const nickname = document.querySelector('#feedback-nickname');
  const content = document.querySelector('#feedback-content');
  const consent = document.querySelector('#feedback-consent');
  const website = document.querySelector('#feedback-website');
  const submit = document.querySelector('#feedback-submit');
  const message = document.querySelector('#feedback-message');
  const list = document.querySelector('#feedback-list');
  const status = document.querySelector('#feedback-list-status');
  const refresh = document.querySelector('#feedback-refresh');
  const more = document.querySelector('#feedback-more');
  let cursor = null;
  let loading = false;
  let posting = false;
  let pending = null;
  let sequence = 0;
  const shown = new Set();
  const dateFormat = new Intl.DateTimeFormat('ko-KR', { timeZone:'Asia/Seoul', year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit' });

  function notify(text, tone = 'error') {
    message.textContent = text; message.hidden = false; message.dataset.tone = tone;
  }
  function count() {
    const size = [...content.value.trim()].length;
    const counter = document.querySelector('#feedback-count');
    counter.textContent = `${size} / 500`;
    counter.classList.toggle('is-over-limit', size > 500);
    content.setAttribute('aria-invalid', String(size > 500));
  }
  content.addEventListener('input', count);
  function append(item) {
    if (shown.has(item.id)) return;
    shown.add(item.id);
    const row = document.createElement('li'); row.className = 'feedback-item';
    const head = document.createElement('div'); head.className = 'feedback-item-head';
    const name = document.createElement('strong'); name.textContent = item.nickname;
    const time = document.createElement('time'); time.dateTime = item.createdAt;
    time.textContent = dateFormat.format(new Date(item.createdAt));
    const text = document.createElement('p'); text.textContent = item.content;
    head.append(name,time); row.append(head,text); list.append(row);
  }
  async function load(reset = false) {
    if (loading) return false;
    loading = true;
    const current = ++sequence;
    const requestedCursor = reset ? null : cursor;
    refresh.disabled = more.disabled = true;
    status.textContent = '피드백을 불러오고 있어요…';
    try {
      const data = await requestJson('/api/feedback' + (requestedCursor ? `?cursor=${encodeURIComponent(requestedCursor)}` : ''));
      if (current !== sequence) return false;
      if (!Array.isArray(data.items)) throw new Error('피드백 목록을 읽지 못했어요.');
      if (reset) { list.replaceChildren(); shown.clear(); }
      for (const item of data.items) append(item);
      cursor = data.nextCursor;
      more.hidden = !cursor;
      status.textContent = !shown.size ? '첫 번째 피드백을 남겨 주세요.' : cursor ? '최근 의견부터 보여 드리고 있어요.' : '모든 피드백을 확인했어요.';
      status.dataset.tone = 'neutral';
      return true;
    } catch (error) {
      status.textContent = error.code === 'SERVICE_UNAVAILABLE' ? '피드백 연결을 준비하고 있어요. 연결 후 의견을 남길 수 있어요.' : friendlyError(error);
      status.dataset.tone = 'error';
      return false;
    } finally { if (current === sequence) { loading = false; refresh.disabled = more.disabled = false; } }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (posting) return;
    message.hidden = true;
    const values = {nickname:nickname.value.trim(),content:content.value.trim(),consent:consent.checked,website:website.value};
    const size = [...values.content].length;
    if ([...values.nickname].length > 20) { notify('닉네임은 20자까지 작성할 수 있어요.'); nickname.focus(); return; }
    if (size < 1 || size > 500) { notify('피드백을 1~500자로 작성해 주세요.'); content.setAttribute('aria-invalid','true'); content.focus(); return; }
    if (!values.consent) { notify('닉네임과 피드백 공개에 동의해 주세요.'); consent.focus(); return; }
    const signature = JSON.stringify(values);
    if (!pending || pending.signature !== signature) pending = {signature,id:crypto.randomUUID()};
    posting = true; submit.disabled = true; submit.textContent = '보내는 중…';
    // 전송 중 변경으로 저장된 내용과 화면 내용이 달라지지 않게 한다.
    for (const control of [nickname,content,consent]) control.disabled = true;
    try {
      await requestJson('/api/feedback', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clientRequestId:pending.id,...values})});
      pending = null; form.reset(); count();
      notify('피드백이 등록됐어요. 의견을 나눠 주셔서 고마워요.','success');
      // 이전 조회를 무효화하고 새 글을 포함한 첫 페이지를 읽는다.
      if (loading) { sequence++; loading = false; }
      const refreshed = await load(true);
      if (!refreshed) notify('피드백은 저장했어요. 목록을 다시 불러와 주세요.','success');
    } catch (error) { notify(friendlyError(error)); }
    finally {
      posting = false; submit.disabled = false; submit.textContent = '피드백 보내기';
      for (const control of [nickname,content,consent]) control.disabled = false;
    }
  });
  refresh.addEventListener('click',()=>load(true));
  more.addEventListener('click',()=>load(false));
  count(); load(true);
  return {refresh:()=>load(true)};
}
