#!/usr/bin/env node
/* 一次性：启用 Discussions 并创建刺窝三个分类，输出 giscus 需要的 id */
'use strict';
const https = require('node:https');
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) { console.error('需要 GITHUB_TOKEN'); process.exit(1); }
const OWNER = 'supercalifragilisticexpialidociouer';
const REPO = 'PlanQuest';

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com', path, method, timeout: 60000,
      headers: Object.assign({
        Authorization: 'Bearer ' + TOKEN,
        'User-Agent': 'PlanQuest-Sync',
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      }, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, data: buf }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function gql(query, variables) {
  const r = await api('POST', '/graphql', { query, variables });
  if (r.status !== 200 || r.data.errors) throw new Error(JSON.stringify(r.data.errors || r.data));
  return r.data.data;
}

(async () => {
  const patch = await api('PATCH', `/repos/${OWNER}/${REPO}`, { has_discussions: true });
  console.log('启用 Discussions:', patch.status, 'has_discussions=', patch.data && patch.data.has_discussions);

  const info = await gql(
    `query($owner:String!,$repo:String!){
      repository(owner:$owner,name:$repo){
        id
        discussionCategories(first:100){ nodes { id name emoji } }
      }
    }`,
    { owner: OWNER, repo: REPO }
  );
  const repoId = info.repository.id;
  console.log('repo node id:', repoId);
  console.log('现有分类:', JSON.stringify(info.repository.discussionCategories.nodes));

  const wanted = [
    { name: '挨扎日记', emoji: ':speech_balloon:', description: '被阿刺骂了什么？晒连击、吐槽、立 Flag——阿刺看着呢。' },
    { name: '驯刺补遗', emoji: ':books:', description: '皮肤实测、文件同步骚操作、坑位预警。' },
    { name: '发疯现场', emoji: ':bug:', description: 'Bug 反馈与阿刺背锅奇迹记录；真 Bug 请带系统+版本+步骤。' },
  ];
  const existing = new Map(info.repository.discussionCategories.nodes.map((c) => [c.name, c]));
  for (const c of wanted) {
    if (existing.has(c.name)) { console.log('已存在', c.name, existing.get(c.name).id); continue; }
    try {
      const created = await gql(
        `mutation($repoId:ID!,$name:String!,$emoji:String!,$description:String!){
          createDiscussionCategory(input:{repositoryId:$repoId,name:$name,emoji:$emoji,description:$description}){
            discussionCategory { id name }
          }
        }`,
        Object.assign({ repoId }, c)
      );
      const nc = created.createDiscussionCategory.discussionCategory;
      console.log('创建', nc.name, nc.id);
    } catch (e) { console.log('创建失败', c.name, e.message.slice(0, 300)); }
  }

  const final = await gql(
    `query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){discussionCategories(first:100){nodes{id name emoji}}}}`,
    { owner: OWNER, repo: REPO }
  );
  console.log('FINAL_CATEGORIES=' + JSON.stringify(final.repository.discussionCategories.nodes));
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
