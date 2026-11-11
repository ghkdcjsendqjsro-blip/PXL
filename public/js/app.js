import { normalizeImageFile, imageFromUrl } from './image-input.js';
import { renderPixelImage } from './pixelate.js';
import { requestJson, friendlyError } from './api.js';
import { initFeedback } from './feedback.js';

const $ = selector => document.querySelector(selector);
const form = $('#generate-form');
const state = {mode:'image',input:null,inputImage:null,result:null,busy:false,fileVersion:0,renderVersion:0,capabilities:null};
const tabs = [$('#tab-image'),$('#tab-prompt')];
const fileInput = $('#image-file');
const message = $('#generation-message');
const progress = $('#generation-progress');
const resultImage = $('#result-image');
const download = $('#download-button');
const localButton = $('#local-preview-button');
const demoButton = $('#demo-button');
const format = new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
let nextGenerationId = 0;

function notify(text, tone='error') {
  message.textContent = text; message.hidden = false; message.dataset.tone = tone;
}
function clearMessage() { message.hidden = true; message.textContent = ''; }
function options() {
  return {grid:Number(form.querySelector('input[name="grid"]:checked').value),palette:form.querySelector('input[name="palette"]:checked').value};
}
function busy(value, text='픽셀을 만들고 있어요. 잠시만 기다려 주세요.') {
  state.busy = value; form.setAttribute('aria-busy',String(value));
  for (const control of form.querySelectorAll('input,textarea,button,fieldset')) control.disabled = value;
  demoButton.disabled = value; localButton.disabled = value;
  $('#generate-button').textContent = value ? '만드는 중…' : '픽셀 이미지 만들기';
  progress.hidden = !value; progress.textContent = text;
}
function switchTab(mode, focus=false) {
  if (state.busy) return;
  state.mode = mode; clearMessage();
  for (const tab of tabs) {
    const active = tab.dataset.mode === mode;
    tab.setAttribute('aria-selected',String(active)); tab.tabIndex = active ? 0 : -1;
    if (active && focus) tab.focus();
  }
  $('#panel-image').hidden = mode !== 'image'; $('#panel-prompt').hidden = mode !== 'prompt';
  localButton.hidden = mode !== 'image';
}
tabs.forEach((tab,index)=>{
  tab.addEventListener('click',()=>switchTab(tab.dataset.mode));
  tab.addEventListener('keydown',event=>{
    const keys = {ArrowRight:(index+1)%2,ArrowLeft:(index+1)%2,Home:0,End:1};
    if (Object.hasOwn(keys,event.key)) {event.preventDefault();switchTab(tabs[keys[event.key]].dataset.mode,true);}
  });
});
for (const [id,count] of [['image-prompt','image-prompt-count'],['text-prompt','text-prompt-count']]) {
  $("#"+id).addEventListener('input',event=>{
    const length = [...event.target.value.trim()].length;
    $('#'+count).textContent = `${length.toLocaleString('ko-KR')} / 1,000`;
    $('#'+count).classList.toggle('is-over-limit',length>1000);
    event.target.setAttribute('aria-invalid',String(length>1000));
  });
}
document.querySelectorAll('[data-prompt]').forEach(button=>button.addEventListener('click',()=>{
  switchTab('prompt'); $('#text-prompt').value = button.dataset.prompt;
  $('#text-prompt').dispatchEvent(new Event('input')); $('#text-prompt').focus();
}));

async function selectFiles(files) {
  if (state.busy) return;
  clearMessage();
  if (files.length !== 1) {notify('이미지를 한 장씩 선택해 주세요.'); return;}
  const version = ++state.fileVersion;
  busy(true,'이미지를 확인하고 있어요…');
  let normalized;
  try {
    normalized = await normalizeImageFile(files[0]);
    const image = await imageFromUrl(normalized.previewUrl);
    if (version !== state.fileVersion) {URL.revokeObjectURL(normalized.previewUrl); return;}
    const previousUrl = state.input?.previewUrl;
    state.input = normalized; state.inputImage = image;
    $('#input-preview').src = normalized.previewUrl; $('#file-name').textContent = normalized.name;
    $('#upload-preview').hidden = false; $('#upload-empty').hidden = true;
    if (previousUrl && previousUrl !== state.result?.originalUrl) URL.revokeObjectURL(previousUrl);
  } catch (error) {if (normalized) URL.revokeObjectURL(normalized.previewUrl); notify(friendlyError(error));}
  finally {fileInput.value = ''; busy(false);}
}
fileInput.addEventListener('change',()=>{if(fileInput.files.length) selectFiles([...fileInput.files]);});
$('#change-image').addEventListener('click',()=>fileInput.click());
$('#remove-image').addEventListener('click',()=>{
  if(state.busy)return;
  state.fileVersion++;
  if(state.input?.previewUrl && state.input.previewUrl!==state.result?.originalUrl)URL.revokeObjectURL(state.input.previewUrl);
  state.input = state.inputImage = null; fileInput.value = '';
  $('#input-preview').removeAttribute('src'); $('#upload-preview').hidden = true; $('#upload-empty').hidden = false;
});
const drop = $('#drop-zone');
for (const type of ['dragenter','dragover']) drop.addEventListener(type,event=>{event.preventDefault();if(!state.busy)drop.classList.add('is-dragging');});
for (const type of ['dragleave','drop']) drop.addEventListener(type,event=>{event.preventDefault();drop.classList.remove('is-dragging');});
drop.addEventListener('drop',event=>selectFiles([...event.dataTransfer.files]));

function showResult(original=false) {
  if(!state.result)return;
  resultImage.src = original ? state.result.originalUrl : state.result.url;
  resultImage.alt = original ? '이 결과를 만들 때 사용한 원본 이미지' : `${state.result.kindLabel}. ${state.result.grid}×${state.result.grid} 격자, ${state.result.palette==='original'?'원본 색상':`최대 ${state.result.palette}색`}.`;
  $('#show-original').setAttribute('aria-pressed',String(original)); $('#show-result').setAttribute('aria-pressed',String(!original));
}
async function render(source,kind,originalUrl=null,generation=null) {
  const version = ++state.renderVersion;
  const selected = options();
  const output = await renderPixelImage(source,selected);
  if(version!==state.renderVersion){URL.revokeObjectURL(output.url);return;}
  const old = state.result;
  const kindLabel = {demo:'데모 이미지 · AI 사용 안 함',local:'로컬 픽셀 미리보기 · AI 사용 안 함',ai:'AI로 만든 픽셀 이미지'}[kind];
  state.result = {...output,source,kind,kindLabel,originalUrl,generation};
  $('#result-empty').hidden = true; $('#result-content').hidden = false;
  $('#result-kind').textContent = kindLabel;
  $('#result-meta').textContent = `1024 × 1024 PNG · ${selected.grid} × ${selected.grid} 격자 · ${selected.palette==='original'?'원본 색상':`최대 ${selected.palette}색`}`;
  $('#result-compare').hidden = !originalUrl;
  showResult(false);
  download.href = output.url;
  download.removeAttribute('aria-disabled');
  download.removeAttribute('tabindex');
  download.classList.remove('is-disabled');
  const stamp = format.format(new Date()).replace(/[-: ]/g,'');
  download.download = `suminpixel-${stamp.slice(0,8)}-${stamp.slice(8)}.png`;
  if (generation) feedback.setGeneratedAttachment({ pngBlob:output.blob, prompt:generation.prompt, generationId:generation.id });
  if(old){URL.revokeObjectURL(old.url); if(old.originalUrl && old.originalUrl!==originalUrl && old.originalUrl!==state.input?.previewUrl)URL.revokeObjectURL(old.originalUrl);}
}
localButton.addEventListener('click',async()=>{
  if(state.busy)return; clearMessage();
  if(!state.inputImage){notify('먼저 이미지를 선택해 주세요.');fileInput.focus();return;}
  busy(true,'이 기기에서 픽셀을 다듬고 있어요…');
  try{await render(state.inputImage,'local',state.input.previewUrl); notify('기기 안에서 변환했어요. 이미지가 서버로 전송되지 않았어요.','success');}
  catch(error){notify(friendlyError(error));}finally{busy(false);}
});
demoButton.addEventListener('click',async()=>{
  if(state.busy)return;clearMessage();busy(true,'데모 이미지에 픽셀 설정을 적용하고 있어요…');
  try{const source=await imageFromUrl('/assets/pixel-garden.svg');await render(source,'demo');notify('데모 이미지예요. 픽셀 크기와 색상을 바꿔 보세요.','success');}
  catch(error){notify(friendlyError(error));}finally{busy(false);}
});
form.addEventListener('submit',async event=>{
  event.preventDefault();if(state.busy)return;clearMessage();
  const promptField = state.mode==='image'?$('#image-prompt'):$('#text-prompt');
  const prompt = promptField.value.trim(); const length=[...prompt].length;
  if(state.mode==='image'&&!state.input){notify('먼저 이미지를 선택해 주세요.');fileInput.focus();return;}
  if(length>1000||(state.mode==='prompt'&&!length)){notify(length>1000?'설명은 1,000자까지 작성할 수 있어요.':'만들고 싶은 장면을 적어 주세요.');promptField.setAttribute('aria-invalid','true');promptField.focus();return;}
  if(state.capabilities?.aiConfigured===false){notify('AI 생성 연결을 준비하고 있어요. 이미지 첨부 후 로컬 미리보기나 데모를 먼저 체험해 보세요.');return;}
  const data=new FormData();data.set('mode',state.mode);data.set('prompt',prompt);
  if(state.mode==='image')data.set('image',state.input.blob,'input.png');
  busy(true);
  let source;
  try {
    const response=await requestJson('/api/generate',{method:'POST',body:data,timeout:110_000});
    if(response.mimeType!=='image/png'||response.width!==512||response.height!==512||typeof response.imageBase64!=='string')throw new Error('이미지 응답을 읽지 못했어요.');
    source=await imageFromUrl(`data:image/png;base64,${response.imageBase64}`);
    progress.textContent='이미지를 픽셀로 다듬고 있어요…';
    const generation = { id:++nextGenerationId, prompt };
    await render(source,'ai',state.mode==='image'?state.input.previewUrl:null,generation);
    notify('나만의 픽셀 이미지가 완성됐어요. PNG로 저장해 보세요.','success');
  } catch(error){notify(error.code==='TIMEOUT'?'생성 대기 시간이 초과됐어요. 다시 요청하면 이전 생성 비용과 별도로 처리될 수 있어요.':friendlyError(error));}
  finally{busy(false);}
});
for(const name of ['grid','palette'])form.querySelectorAll(`input[name="${name}"]`).forEach(input=>input.addEventListener('change',async()=>{
  if(!state.result||state.busy)return;clearMessage();
  const {source,kind,originalUrl,generation}=state.result;
  try{await render(source,kind,originalUrl,generation);}catch(error){notify(friendlyError(error));}
}));
$('#show-original').addEventListener('click',()=>showResult(true));
$('#show-result').addEventListener('click',()=>showResult(false));
download.addEventListener('click',event=>{if(!state.result){event.preventDefault();notify('먼저 이미지를 만들거나 데모를 체험해 주세요.');}});
$('#restart-button').addEventListener('click',()=>{
  $('#create').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
  (state.mode==='prompt'?$('#text-prompt'):fileInput).focus({preventScroll:true});
});
async function loadStatus(){
  try{
    state.capabilities=await requestJson('/api/status');
    $('#connection-status').textContent=state.capabilities.aiConfigured?'AI 생성 연결 설정됨 · 로컬 체험 가능':'로컬 체험 가능 · AI 생성 연결 대기';
  }catch{$('#connection-status').textContent='로컬 체험 가능 · 연결 상태 확인 중';}
}
switchTab('image');
const feedback = initFeedback();
loadStatus();
window.addEventListener('pagehide',event=>{
  if (event.persisted) return;
  const urls=new Set([state.input?.previewUrl,state.result?.url,state.result?.originalUrl]);
  for(const url of urls)if(url?.startsWith('blob:'))URL.revokeObjectURL(url);
});
