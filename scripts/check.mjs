import { readdir, readFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes:true });
  const result = [];
  for (const entry of entries) {
    const full = path.join(directory,entry.name);
    if (entry.isDirectory()) result.push(...await walk(full));
    else if (/\.(m?js)$/.test(entry.name)) result.push(full);
  }
  return result;
}
const files = (await Promise.all(['api','server','public/js','scripts','tests'].map(name=>walk(path.join(root,name))))).flat();
for (const file of files) {
  const checked = spawnSync(process.execPath,['--check',file],{encoding:'utf8'});
  if (checked.status !== 0) { process.stderr.write(checked.stderr); process.exit(1); }
}
const html = await readFile(path.join(root,'public/index.html'),'utf8');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);
if (new Set(ids).size !== ids.length) throw new Error('HTML 안에 중복 ID가 있습니다.');
if (/<script(?![^>]*src=)[^>]*>\s*\S/.test(html) || /\son(?:click|change|load)=/.test(html)) throw new Error('인라인 스크립트가 있습니다.');
for (const [,asset] of html.matchAll(/(?:src|href)="(\/(?:assets|js)\/[^"#]+|\/styles\.css)"/g)) await access(path.join(root,'public',asset));
for (const relative of ['public/index.html','public/styles.css',...files.filter(file=>file.includes(path.join('public','js'))).map(file=>path.relative(root,file))]) {
  const text = await readFile(path.join(root,relative),'utf8');
  if (/(?:sk-[A-Za-z0-9_-]{20,}|sb_secret_[A-Za-z0-9_-]{20,})/.test(text)) throw new Error('정적 파일에 비밀 값이 있습니다.');
}
console.log(`PASS: JavaScript ${files.length}개 문법, HTML ID, 자산 경로, 인라인 스크립트·키 노출 검사`);
