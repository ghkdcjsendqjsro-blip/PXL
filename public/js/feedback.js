import { requestJson, friendlyError } from './api.js';

const emptyPrompt = '프롬프트 없음';

function encodePng(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(',') + 1));
    reader.onerror = () => reject(new Error('첨부 이미지를 읽지 못했어요. 다시 시도해 주세요.'));
    reader.readAsDataURL(blob);
  });
}

export function initFeedback() {
  const form = document.querySelector('#feedback-form');
  const nickname = document.querySelector('#feedback-nickname');
  const content = document.querySelector('#feedback-content');
  const consent = document.querySelector('#feedback-consent');
  const consentLabel = document.querySelector('#feedback-consent-label');
  const textConsent = consentLabel.textContent;
  const attachmentPanel = document.querySelector('#feedback-attachment');
  const attachmentPreview = document.querySelector('#feedback-attachment-preview');
  const attachmentImage = document.querySelector('#feedback-attachment-image');
  const attachmentPrompt = document.querySelector('#feedback-attachment-prompt');
  const attachmentToggle = document.querySelector('#feedback-attachment-toggle');
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
  let generatedAttachment = null;
  let includeAttachment = false;
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

  function showAttachment() {
    attachmentPanel.hidden = !generatedAttachment;
    attachmentPreview.hidden = !includeAttachment;
    attachmentToggle.textContent = includeAttachment ? '첨부 빼기' : '첨부하기';
    attachmentToggle.setAttribute('aria-expanded', String(includeAttachment));
    consentLabel.textContent = includeAttachment
      ? '닉네임, 피드백, 첨부 이미지와 프롬프트가 이 페이지에 공개되는 데 동의합니다.'
      : textConsent;
  }

  function setGeneratedAttachment(attachment) {
    const previous = generatedAttachment;
    if (attachment?.pngBlob === previous?.pngBlob && attachment?.generationId === previous?.generationId && attachment?.prompt === previous?.prompt) return;
    if (includeAttachment) consent.checked = false;
    if (previous) URL.revokeObjectURL(previous.previewUrl);
    generatedAttachment = attachment ? { ...attachment, previewUrl: URL.createObjectURL(attachment.pngBlob) } : null;
    if (attachment?.generationId !== previous?.generationId) includeAttachment = false;
    if (generatedAttachment) {
      attachmentImage.src = generatedAttachment.previewUrl;
      attachmentPrompt.textContent = generatedAttachment.prompt || emptyPrompt;
    } else {
      attachmentImage.removeAttribute('src');
      attachmentPrompt.textContent = '';
    }
    showAttachment();
  }

  attachmentToggle.addEventListener('click', () => {
    includeAttachment = !includeAttachment;
    consent.checked = false;
    showAttachment();
  });
  window.addEventListener('pagehide', event => {
    if (!event.persisted && generatedAttachment) URL.revokeObjectURL(generatedAttachment.previewUrl);
  });

  function append(item) {
    if (shown.has(item.id)) return;
    shown.add(item.id);
    const row = document.createElement('li'); row.className = 'feedback-item';
    const head = document.createElement('div'); head.className = 'feedback-item-head';
    const name = document.createElement('strong'); name.textContent = item.nickname;
    const time = document.createElement('time'); time.dateTime = item.createdAt;
    time.textContent = dateFormat.format(new Date(item.createdAt));
    const text = document.createElement('p'); text.textContent = item.content;
    head.append(name,time); row.append(head,text);
    const attachment = item.attachment;
    if (typeof attachment?.prompt === 'string' && attachment.imageUrl === `/api/feedback-image?id=${encodeURIComponent(item.id)}`) {
      const preview = document.createElement('div'); preview.className = 'feedback-item-attachment';
      const link = document.createElement('a');
      link.href = attachment.imageUrl;
      link.target = '_blank';
      link.rel = 'noopener';
      link.setAttribute('aria-label', '첨부 이미지 크게 보기');
      const image = document.createElement('img');
      image.alt = '공개 피드백에 첨부된 픽셀 이미지';
      image.width = image.height = 76;
      image.loading = 'lazy';
      image.src = attachment.imageUrl;
      const description = document.createElement('div');
      const label = document.createElement('strong'); label.className = 'feedback-prompt-label';
      label.textContent = '사용한 프롬프트';
      const prompt = document.createElement('p'); prompt.className = 'feedback-item-prompt';
      prompt.textContent = attachment.prompt || emptyPrompt;
      link.append(image); description.append(label,prompt); preview.append(link,description); row.append(preview);
    }
    list.append(row);
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
    const attachment = includeAttachment ? generatedAttachment : null;
    if (!values.consent) {
      notify(attachment ? '피드백, 첨부 이미지와 프롬프트 공개에 동의해 주세요.' : '닉네임과 피드백 공개에 동의해 주세요.');
      consent.focus();
      return;
    }
    posting = true; submit.disabled = true; submit.textContent = '보내는 중…';
    // 전송 중 변경으로 저장된 내용과 화면 내용이 달라지지 않게 한다.
    const controls = [nickname,content,consent,attachmentToggle];
    for (const control of controls) control.disabled = true;
    try {
      if (attachment) values.attachment = { imageBase64: await encodePng(attachment.pngBlob), prompt: attachment.prompt };
      const signature = JSON.stringify(values);
      if (!pending || pending.signature !== signature) pending = {signature,id:crypto.randomUUID()};
      await requestJson('/api/feedback', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clientRequestId:pending.id,...values})});
      pending = null;
      form.reset(); count();
      includeAttachment = false;
      showAttachment();
      notify('피드백이 등록됐어요. 의견을 나눠 주셔서 고마워요.','success');
      // 이전 조회를 무효화하고 새 글을 포함한 첫 페이지를 읽는다.
      if (loading) { sequence++; loading = false; }
      const refreshed = await load(true);
      if (!refreshed) notify('피드백은 저장했어요. 목록을 다시 불러와 주세요.','success');
    } catch (error) { notify(friendlyError(error)); }
    finally {
      posting = false; submit.disabled = false; submit.textContent = '피드백 보내기';
      for (const control of controls) control.disabled = false;
    }
  });
  refresh.addEventListener('click',()=>load(true));
  more.addEventListener('click',()=>load(false));
  count(); load(true);
  return {refresh:()=>load(true),setGeneratedAttachment};
}
