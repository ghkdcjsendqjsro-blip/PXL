import { test, expect } from '@playwright/test';
import sharp from 'sharp';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/status', route => route.fulfill({
    json: { aiConfigured: false, feedbackConfigured: false, localPreview: true },
  }));
  await page.route('**/api/feedback*', route => route.fulfill({
    json: { items: [], nextCursor: null },
  }));
});

async function fixtureImage(size=1024) {
  return sharp({create:{width:size,height:size,channels:3,background:'#bc94eb'}})
    .composite([{input:Buffer.from('<svg width="1024" height="1024"><rect x="128" y="128" width="384" height="768" fill="#e93794"/><circle cx="700" cy="350" r="180" fill="#72cb96"/></svg>'),top:0,left:0}])
    .png().toBuffer();
}
async function noHorizontalOverflow(page) {
  expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test('desktop: demo, palette and exact downloadable PNG',async({page})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  let aiCalls=0;page.on('request',request=>{if(request.url().endsWith('/api/generate'))aiCalls++;});
  await page.goto('/');
  await expect(page.locator('h1')).toContainText('픽셀');
  await page.locator('#demo-button').click();
  await expect(page.locator('#result-content')).toBeVisible();
  await expect(page.locator('#result-kind')).toContainText('데모 이미지');
  await page.locator('input[name="grid"][value="32"]').check();
  await page.locator('input[name="palette"][value="16"]').check();
  await expect(page.locator('#result-meta')).toContainText('32 × 32');
  await expect(page.locator('#result-meta')).toContainText('16색');
  const pixels=await page.locator('#result-image').evaluate(async image=>{
    await image.decode();const canvas=document.createElement('canvas');canvas.width=canvas.height=1024;
    const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);const data=ctx.getImageData(0,0,1024,1024).data;
    const colors=new Set();let opaque=true;let blocks=true;
    for(let y=0;y<1024;y++)for(let x=0;x<1024;x++){
      const i=(y*1024+x)*4;colors.add(`${data[i]},${data[i+1]},${data[i+2]}`);opaque&&=data[i+3]===255;
      const first=(Math.floor(y/32)*32*1024+Math.floor(x/32)*32)*4;
      blocks&&=data[i]===data[first]&&data[i+1]===data[first+1]&&data[i+2]===data[first+2];
    }
    return{width:image.naturalWidth,height:image.naturalHeight,colors:colors.size,opaque,blocks};
  });
  expect(pixels).toMatchObject({width:1024,height:1024,opaque:true,blocks:true});expect(pixels.colors).toBeLessThanOrEqual(16);
  const downloadEvent=page.waitForEvent('download');await page.locator('#download-button').click();
  const downloaded=await downloadEvent;expect(downloaded.suggestedFilename()).toMatch(/^suminpixel-\d{8}-\d{6}\.png$/);
  expect(await page.locator('#download-button').evaluate(link=>link.tabIndex)).toBe(0);
  const file=await downloaded.path();const metadata=await sharp(file).metadata();expect(metadata).toMatchObject({format:'png',width:1024,height:1024});
  expect(aiCalls).toBe(0);expect(errors).toEqual([]);await noHorizontalOverflow(page);
});

test('upload: real local preview, compare, invalid replacement preserves image',async({page})=>{
  await page.goto('/');
  await page.locator('#image-file').setInputFiles({name:'sample.png',mimeType:'image/png',buffer:await fixtureImage()});
  await expect(page.locator('#upload-preview')).toBeVisible();
  await page.locator('#local-preview-button').click();
  await expect(page.locator('#result-kind')).toContainText('AI 사용 안 함');
  await page.locator('#show-original').click();await expect(page.locator('#show-original')).toHaveAttribute('aria-pressed','true');
  await page.locator('#show-result').click();await expect(page.locator('#show-result')).toHaveAttribute('aria-pressed','true');
  await page.locator('#image-file').setInputFiles({name:'bad.png',mimeType:'image/png',buffer:Buffer.from('not an image')});
  await expect(page.locator('#generation-message')).toBeVisible();
  await expect(page.locator('#file-name')).toHaveText('sample.png');await expect(page.locator('#result-content')).toBeVisible();
});

test('prompt mode: keyboard tabs, examples, missing connection and retained demo',async({page})=>{
  await page.goto('/');await page.locator('#demo-button').click();await expect(page.locator('#result-content')).toBeVisible();
  await page.locator('#tab-image').focus();await page.keyboard.press('ArrowRight');
  await expect(page.locator('#tab-prompt')).toHaveAttribute('aria-selected','true');
  await expect(page.locator('#panel-prompt')).toBeVisible();
  await page.locator('[data-prompt]').first().click();await expect(page.locator('#text-prompt')).not.toBeEmpty();
  await expect(page.locator('#connection-status')).not.toContainText('확인 중');
  await page.locator('#generate-button').click();await expect(page.locator('#generation-message')).toContainText('연결');
  await expect(page.locator('#result-kind')).toContainText('데모');
});

test('AI UI integration with stubbed provider response and no extra calls for options',async({page})=>{
  const source=await sharp({create:{width:512,height:512,channels:3,background:'#c388b8'}}).png().toBuffer();
  await page.route('**/api/status',route=>route.fulfill({json:{aiConfigured:true,feedbackConfigured:false,localPreview:true}}));
  let calls=0;
  await page.route('**/api/generate',async route=>{calls++;await new Promise(resolve=>setTimeout(resolve,120));await route.fulfill({json:{requestId:'test',imageBase64:source.toString('base64'),mimeType:'image/png',width:512,height:512}});});
  await page.goto('/');await page.locator('#tab-prompt').click();await page.locator('#text-prompt').fill('작은 고양이');
  await page.locator('#generate-button').click();await expect(page.locator('#generate-button')).toBeDisabled();
  await expect(page.locator('#result-kind')).toHaveText('AI로 만든 픽셀 이미지');
  await page.locator('input[name="grid"][value="128"]').check();await expect(page.locator('#result-meta')).toContainText('128 × 128');
  expect(calls).toBe(1);
});

test('feedback: safe public text, pagination, consent and UUID retry',async({page})=>{
  const items=Array.from({length:21},(_,index)=>({id:`row-${index}`,nickname:'익명',content:index===0?'<img src=x onerror=alert(1)>':`의견 ${index}`,createdAt:'2026-11-11T03:00:00.123456+00:00'}));
  const posts=[];
  await page.route('**/api/feedback*',async route=>{
    const req=route.request();
    if(req.method()==='GET'){await route.fulfill({json:req.url().includes('cursor=')?{items:items.slice(20),nextCursor:null}:{items:items.slice(0,20),nextCursor:'cursor'}});return;}
    posts.push(req.postDataJSON());
    if(posts.length===1)await route.fulfill({status:503,json:{error:{code:'SERVICE_UNAVAILABLE',message:'테스트 일시 오류'}}});
    else await route.fulfill({status:201,json:{item:{...items[0],id:'saved'}}});
  });
  await page.goto('/');await expect(page.locator('#feedback-list > li')).toHaveCount(20);
  await expect(page.locator('#feedback-list img')).toHaveCount(0);await expect(page.locator('#feedback-list')).toContainText('<img src=x onerror=alert(1)>');
  await page.locator('#feedback-more').click();await expect(page.locator('#feedback-list > li')).toHaveCount(21);
  await page.locator('#feedback-content').fill('색상이 예뻐요');await page.locator('#feedback-submit').click();
  await expect(page.locator('#feedback-message')).toContainText('동의');expect(posts).toHaveLength(0);
  await page.locator('#feedback-consent').check();await page.locator('#feedback-submit').click();await expect(page.locator('#feedback-message')).toContainText('테스트 일시 오류');
  await expect(page.locator('#feedback-content')).toHaveValue('색상이 예뻐요');
  await page.locator('#feedback-submit').click();await expect(page.locator('#feedback-message')).toContainText('등록');
  expect(posts[0].clientRequestId).toBe(posts[1].clientRequestId);await expect(page.locator('#feedback-content')).toBeEmpty();
});

test('feedback includes the AI result and its original prompt only when selected', async ({ page }) => {
  const source = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#c388b8' } }).png().toBuffer();
  const postBodies = [];
  const items = [];
  const attachmentId = 'e4fef9f1-4a50-4404-a52d-bfd0f470752d';
  const imagePath = `/api/feedback-image?id=${attachmentId}`;
  const usedPrompt = '달빛 아래 고양이 <img src=x>';
  await page.route('**/api/status', route => route.fulfill({
    json: { aiConfigured: true, feedbackConfigured: true, localPreview: true },
  }));
  await page.route('**/api/generate', route => route.fulfill({
    json: { requestId: 'test', imageBase64: source.toString('base64'), mimeType: 'image/png', width: 512, height: 512 },
  }));
  await page.route('**/api/feedback', async route => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { items, nextCursor: null } });
      return;
    }
    const body = route.request().postDataJSON();
    postBodies.push(body);
    const item = {
      id: body.attachment ? attachmentId : '219a8b4a-b32a-4497-9ab1-857a9b988821', nickname: '익명', content: body.content,
      createdAt: '2026-11-11T03:00:00.123456+00:00',
      attachment: body.attachment ? { imageUrl: imagePath, prompt: body.attachment.prompt } : null,
    };
    items.unshift(item);
    await route.fulfill({ status: 201, json: { item } });
  });
  await page.route(`**${imagePath}`, route => route.fulfill({
    contentType: 'image/png', body: Buffer.from(postBodies.find(body => body.attachment).attachment.imageBase64, 'base64'),
  }));

  await page.goto('/');
  await page.locator('#tab-prompt').click();
  await page.locator('#text-prompt').fill(` ${usedPrompt} `);
  await page.locator('#generate-button').click();
  await expect(page.locator('#result-kind')).toHaveText('AI로 만든 픽셀 이미지');
  const toggle = page.locator('#feedback-attachment-toggle');
  await expect(toggle).toHaveText('첨부하기');
  await expect(page.locator('#feedback-attachment-preview')).toBeHidden();
  await toggle.click();
  await expect(page.locator('#feedback-attachment-image')).toBeVisible();
  await expect(page.locator('#feedback-attachment-prompt')).toHaveText(usedPrompt);
  await page.locator('#text-prompt').fill('다음 작품에 쓸 설명');
  await expect(page.locator('#feedback-attachment-prompt')).toHaveText(usedPrompt);

  await toggle.click();
  await expect(page.locator('#feedback-attachment-preview')).toBeHidden();
  await page.locator('#feedback-content').fill('첨부 없이 보낸 의견');
  await page.locator('#feedback-consent').check();
  await page.locator('#feedback-submit').click();
  await expect(page.locator('#feedback-list')).toContainText('첨부 없이 보낸 의견');
  expect(postBodies[0]).not.toHaveProperty('attachment');

  await expect(page.locator('#feedback-attachment-preview')).toBeHidden();
  await toggle.click();
  await expect(page.locator('#feedback-attachment-preview')).toBeVisible();
  const publicConsent = page.getByRole('checkbox', { name: /첨부 이미지와 프롬프트가 이 페이지에 공개/ });
  await expect(publicConsent).not.toBeChecked();
  await page.locator('#feedback-content').fill('완성한 픽셀 이미지와 함께 보낸 의견');
  await publicConsent.check();
  await page.locator('#feedback-submit').click();
  await expect(page.locator('#feedback-list')).toContainText('완성한 픽셀 이미지와 함께 보낸 의견');
  await expect(toggle).toHaveText('첨부하기');
  await expect(page.locator('#feedback-attachment-preview')).toBeHidden();
  expect(postBodies[1].attachment.prompt).toBe(usedPrompt);
  const submittedImage = Buffer.from(postBodies[1].attachment.imageBase64, 'base64');
  expect(await sharp(submittedImage).metadata()).toMatchObject({ format: 'png', width: 1024, height: 1024 });

  await page.reload();
  const publicAttachment = page.locator('#feedback-list .feedback-item-attachment');
  await expect(publicAttachment.locator('.feedback-item-prompt')).toHaveText(usedPrompt);
  await expect(publicAttachment.locator('img')).toHaveCount(1);
  await expect(publicAttachment.locator('img')).toHaveAttribute('src', imagePath);
  await publicAttachment.scrollIntoViewIfNeeded();
  await expect.poll(() => publicAttachment.locator('img').evaluate(image => image.naturalWidth)).toBe(1024);

  const thumbnailButton = publicAttachment.getByRole('button', { name: '첨부 이미지 크게 보기' });
  const thumbnail = thumbnailButton.locator('img');
  const thumbnailWidth = await thumbnail.evaluate(image => image.clientWidth);
  const dialog = page.getByRole('dialog', { name: '첨부 이미지', exact: true });
  const dialogImage = dialog.locator('img');
  await thumbnail.click();
  await expect(dialog).toBeVisible();
  await expect(dialogImage).toHaveAttribute('src', imagePath);
  await expect(dialogImage).toBeVisible();
  await expect.poll(() => dialogImage.evaluate(image => image.clientWidth)).toBeGreaterThan(thumbnailWidth);
  expect(page.context().pages()).toEqual([page]);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(thumbnailButton).toBeFocused();

  await thumbnailButton.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(thumbnailButton).toBeFocused();
});

for(const width of [375,320])test(`responsive ${width}px: no overflow and demo controls work`,async({page})=>{
  await page.setViewportSize({width,height:900});await page.goto('/');await noHorizontalOverflow(page);
  await page.locator('#demo-button').click();await expect(page.locator('#result-content')).toBeVisible();
  await noHorizontalOverflow(page);await expect(page.locator('#download-button')).toBeVisible();
});
