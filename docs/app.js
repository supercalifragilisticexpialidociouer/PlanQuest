/* PlanQuest 下载站：静态前端 + GitHub Release 后端 */
'use strict';

const REPO = 'supercalifragilisticexpialidociouer/PlanQuest';
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_URL = `https://github.com/${REPO}/releases`;
const ISSUES_URL = `https://github.com/${REPO}/issues`;
const SOURCE_URL = `https://github.com/${REPO}`;
const MAIL = 'zirc0656@agent.qq.com';
/* 网页版地址：发布 Pages 后指向 /web/；本地预览可在控制台改 window.PQ_WEB_URL */
const WEB_APP_URL = `https://supercalifragilisticexpialidociouer.github.io/PlanQuest/web/`;

const state = {
  version: '2.9.11',
  releaseUrl: RELEASES_URL,
  assets: new Map(),
  online: false,
  platform: 'web',
};

const app = document.getElementById('app');

/* ---------------- 数据层：仓库 Release ---------------- */
async function loadRelease() {
  try {
    const res = await fetch(API_LATEST, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    state.version = String(data.tag_name || '').replace(/^v/, '') || state.version;
    state.releaseUrl = data.html_url || RELEASES_URL;
    state.assets = new Map((data.assets || []).map((a) => [a.name, a.browser_download_url]));
    state.online = true;
  } catch (err) {
    /* 仓库接口不通时仍保留静态兜底，不让页面白屏 */
    state.online = false;
    console.warn('[PlanQuest] Release 接口不可用，使用内置版本信息：', err.message);
  }
}

function assetUrl(name) {
  return state.assets.get(name) || null;
}

function fallbackUrl(name) {
  const exact = `${RELEASES_URL}/download/v${state.version}/${name}`;
  return exact;
}

function downloadTarget(name) {
  return assetUrl(name) || fallbackUrl(name);
}

function hasAsset(name) {
  return state.online ? state.assets.has(name) : true;
}

/* ---------------- 平台定义 ---------------- */
function platforms() {
  const setupName = `PlanQuest-${state.version}-setup.exe`;
  return {
    web: {
      tab: '网页版（免安装）',
      title: '网页版客户端 / 网页版直连',
      desc: '网页版，免安装，打开就干。阿刺在浏览器里照样记你黑账，别以为换个地方就能糊弄。支持 PWA 添加到桌面，假装是个 App。',
      req: '现代浏览器（Chrome / Edge / Firefox），断网也能撑一会儿。',
      buttons: [{ label: '打开网页版（阿刺在线盯梢）', url: WEB_APP_URL, primary: true, external: true }],
      assets: [],
    },
    windows: {
      tab: 'Windows',
      title: `Windows 版客户端 / 最新版 v${state.version}`,
      desc: '下载 Windows 版。阿刺深度驻留，删计划文件它真会生气。',
      req: `Win10 / 11（x64 / ARM64），最新版 v${state.version}。`,
      buttons: [
        { label: '下载 Windows 版（别删文件）', name: 'PlanQuest-install-assistant.exe', primary: true },
        { label: '离线安装包（内嵌整包）', name: setupName, primary: false },
      ],
      assets: ['PlanQuest-install-assistant.exe', setupName],
    },
    macos: {
      tab: 'macOS',
      title: 'macOS 版客户端',
      desc: '下载 macOS 版。豪猪在 Mac 里照样扎你，别想用闭源系统逃避。',
      req: 'macOS 11+。',
      buttons: [{ label: '下载 macOS 版（dmg）', name: 'PlanQuest-macos.dmg', primary: true }],
      assets: ['PlanQuest-macos.dmg'],
    },
    linux: {
      tab: 'Linux',
      title: 'Linux 版客户端',
      desc: '下载 Linux 版。极客标配，阿刺用命令行冷眼看你摆烂。',
      req: 'x86_64。',
      buttons: [{ label: '下载 Linux 版（AppImage）', name: 'PlanQuest-linux-x86_64.AppImage', primary: true }],
      assets: ['PlanQuest-linux-x86_64.AppImage'],
    },
    android: {
      tab: 'Android（安卓）',
      title: 'Android 版客户端',
      desc: '安卓版，手机端自律。锁屏也没用，阿刺知道你划走了。官方不负责你手机发烫，越老机器越卡正好治拖延。',
      req: 'Android 8+。没上架商店（豪猪不伺候审核），APK 直装，提示风险那是阿刺在扎你，放心装（我们没毒，真的）。',
      buttons: [{ label: '下载 APK（阿刺扎手警告）', name: 'PlanQuest.apk', primary: true }],
      assets: ['PlanQuest.apk'],
      qr: true,
    },
  };
}

/* ---------------- 视图 ---------------- */
function navHtml(active) {
  return `
  <nav class="main-nav" aria-label="主导航">
    ${[['home', '首页'], ['download', '下载'], ['guide', '驯刺手册']]
      .map(([id, label]) => `<a href="#/${id}" class="${active === id ? 'active' : ''}">${label}</a>`)
      .join('')}
    <a href="community.html" title="刺窝：进来挨扎，出去变强。阿刺不陪你玩虚的。">刺窝</a>
  </nav>`;
}

function homeView() {
  const skins = [
    ['仙人掌', '嘴硬心软，骂你最凶但也最靠得住'],
    ['玫瑰', '优雅刻薄，记仇也记好，你对它好它就对你笑'],
    ['刺猬', '熟了才黏人，前期冷后期热，像只慢慢翻过来的小动物'],
    ['板栗', '不爱绕弯子，帮你可以，但会记账，说到做到'],
    ['豪猪', '生人勿近，不哄不惯不服就干，想赢得它的尊重？先证明你自己'],
  ];
  return `
  <section class="hero">
    <span class="eyebrow">带刺、记仇、偶尔背锅</span>
    <h1>别找鼓励机器了，<br>这儿只有阿刺。</h1>
    <p class="lead">PlanQuest 不是又一个待办清单。它是一个会跟你较劲、会骂你、偶尔还会替你背锅的自律搭子。</p>
    <div class="hero-actions btn-row">
      <a class="btn btn-primary" href="#/download">下载，挑一只 →</a>
      <a class="btn btn-ghost" href="#/guide">先看驯刺手册</a>
    </div>
  </section>
  <section class="intro-block">
    <h2>还没决定要不要下？先听阿刺说两句</h2>
    <p>PlanQuest 不是又一个待办清单。</p>
    <p>它是一个会跟你较劲、会骂你、偶尔还会替你背锅的自律搭子。你打开它，不是为了看到一个温顺的鼓励机器——你看到的是一只带刺的小东西，叫阿刺。它不会哄你说“加油你可以的”，它会盯着你今天到底干了什么。你偷懒，它记着；你摆烂，它冷嘲热讽；你真扛不住了，它有时候会一声不吭帮你顶一次——但你求它没用，它什么时候心软，它自己说了算。</p>
    <h3 style="margin-top:26px">开局你可以从五种带刺的家伙里挑一个当搭档</h3>
    <div class="skin-list">${skins.map(([n, d]) => `<div class="skin">${n}<small>${d}</small></div>`).join('')}</div>
    <p>它们的脾气完全不同。选定之后不能换——所以挑的时候，想清楚你想要个什么样的搭子。</p>
    <h3 style="margin-top:26px">它怎么管你？很简单。</h3>
    <p>你写下计划，它盯着你执行。你完成，它心情好一点；你糊弄，它记你一笔。连续打卡会积累连击，阿刺对你的态度会慢慢变好。计划写崩了、文件被误删了？它可能替你扛一次扣分——也可能冷眼看着你自食其果。这套东西不讲道理，但它会让你真的动起来。</p>
    <p><strong>免费、开源、不用注册。</strong>全平台打通（网页 / Win / Mac / Linux / 安卓），.pqplan 文件在哪，阿刺跟到哪。下载，挑一只，然后开始（别指望它哄你）。</p>
  </section>`;
}

function downloadView() {
  const P = platforms();
  const key = P[state.platform] ? state.platform : 'web';
  const item = P[key];
  const buttons = item.buttons.map((b) => {
    let url, extra = '';
    if (b.name) {
      const exists = hasAsset(b.name);
      url = exists ? downloadTarget(b.name) : state.releaseUrl;
      extra = exists ? '' : ' <span class="tag">仓库暂无该平台构建 · 先去 Releases 看看</span>';
    } else {
      url = b.url;
      extra = b.external ? ' <span class="tag">↗ 外链</span>' : '';
    }
    return `<a class="btn ${b.primary ? 'btn-primary' : 'btn-ghost'}" href="${url}" ${b.external ? 'target="_blank" rel="noopener"' : ''}>${b.label}${extra}</a>`;
  }).join('');

  const tabs = Object.entries(P).map(([id, v]) =>
    `<button type="button" data-platform="${id}" class="${id === key ? 'active' : ''}" aria-pressed="${id === key}">${v.tab}</button>`).join('');

  const status = state.online
    ? `<span class="status">● 已连接仓库 Release · v${state.version}</span>`
    : `<span class="status off">● 仓库接口暂不可达 · 显示内置版本 v${state.version}</span>`;

  const qr = item.qr ? `
    <div>
      <img class="qr" alt="扫码下载（扫完别跑）" src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(item.buttons[0].name ? downloadTarget(item.buttons[0].name) : WEB_APP_URL)}">
      <div class="qr-wrap">扫码下载（扫完别跑）</div>
    </div>` : '';

  return `
  <section class="hero" style="padding-bottom:12px">
    <span class="eyebrow">下载</span>
    <h1>挑个平台，开始挨扎</h1>
    <p class="lead">安装器从仓库 Release 直接下载。没有中间商，也没有温柔的拥抱。</p>
  </section>
  <div class="platform-tabs" role="tablist" aria-label="平台切换">${tabs}</div>
  <section class="card download-card">
    <div>
      <h2 id="platform-title">${item.title}</h2>
      <p class="lead">${item.desc}</p>
      <div class="btn-row">${buttons}</div>
      <p class="note">要求：${item.req}</p>
    </div>
    <div>
      <div class="release-meta">
        <dl>
          <dt>版本</dt><dd>v${state.version}</dd>
          <dt>后端</dt><dd>GitHub Releases</dd>
          <dt>许可</dt><dd>免费 / 开源 / 免注册</dd>
        </dl>
        ${status}
      </div>
      ${qr}
    </div>
  </section>
  <div class="helper-links">
    <a href="${RELEASES_URL}" target="_blank" rel="noopener">历史版本</a> /
    <a href="${RELEASES_URL}" target="_blank" rel="noopener">更新日志</a> /
    <a href="${RELEASES_URL}/download/v${state.version}/assistant-sources.txt" target="_blank" rel="noopener">双源镜像</a>
    &nbsp;|&nbsp; <a href="#/guide#faq">阿刺不理我怎么办？（安装 / 使用坑）</a>
  </div>`;
}

function guideView() {
  return `
  <section class="hero" style="padding-bottom:10px">
    <span class="eyebrow">驯刺手册</span>
    <h1>三步走，俩坑</h1>
    <p class="lead">别把阿刺当宠物，它不懂事，但它有用。</p>
  </section>
  <section class="card">
    <h2 id="usage">使用说明</h2>
    <div class="steps">
      <div class="step"><h3>创建你的第一个计划</h3>
        <p>打开 PlanQuest（网页版或客户端），点击「新建计划」。</p>
        <p>给计划起个名字，比如“今晚写完报告”。设定截止时间，保存为 .pqplan 文件。</p>
        <p>文件存哪都行——本地、网盘、U 盘、手机，全平台同步认账。</p>
      </div>
      <div class="step"><h3>让阿刺上岗</h3>
        <p>首次启动会让你从五种皮肤里选一个搭档。这个选择不可更改（重装也没用，数据在本地），选之前想清楚。选完之后，阿刺开始记录，并根据表现调整心情。</p>
      </div>
      <div class="step"><h3>日常怎么用</h3>
        <p>每天打开看一眼今天的计划。网页版随时开，安卓版锁屏也逃不掉。</p>
        <p>完成了就勾掉，阿刺记你一功。没完成也别删文件——删了它会更生气，连击直接断。</p>
        <p>连续打卡积累连击，阿刺态度慢慢变好（豪猪除外，它很难搞）。</p>
      </div>
    </div>
    <div class="pitfall"><strong>⚠️ 坑一：新建空白文件会覆盖原计划</strong><br>如果你在已有计划位置新建空 .pqplan，原计划被清空且无法恢复。这不是 Bug，是对“随手乱建文件”的惩罚。（阿刺可能扣你积分，别试。）</div>
    <div class="pitfall"><strong>⚠️ 坑二：顶罪不是你能求来的</strong><br>阿刺偶尔替你扛一次扣分，但：不能主动请求、不能规定时间、无法预测。它有自己判断和次数限制。所以，别指望它，靠自己。</div>
  </section>
  <section class="card section faq" id="faq">
    <h2>常见问题（阿刺版）</h2>
    <details><summary>Q：皮肤选错了能换吗？</summary><p>A：不能。重装也没用。数据在本地，删了重来才会重置，你舍得断连击吗？</p></details>
    <details><summary>Q：阿刺为什么不理我？</summary><p>A：看它心情。有的天生冷淡（比如豪猪），有的要养熟。多打卡，少摆烂，别问废话。</p></details>
    <details><summary>Q：.pqplan 文件能同步吗？网页版和安卓能打通吗？</summary><p>A：能。文件就是普通本地文件，网盘 / U 盘 / 手机全平台认账。阿刺跟文件走，你换设备它照样记你黑账。</p></details>
    <details><summary>Q：网页版能离线吗？安卓为啥没上架商店？</summary><p>A：网页版支持 PWA，断网能撑一会儿；安卓没上架（豪猪不伺候审核），APK 直装，提示风险是阿刺在扎你，真没毒。</p></details>
    <details><summary>Q：支持哪些系统？收费吗？</summary><p>A：网页版（现代浏览器）、Win10+、macOS 11+、Linux x86_64、Android 8+。免费、开源、不注册。</p></details>
  </section>`;
}

function aboutView() {
  return `
  <section class="hero">
    <span class="eyebrow">关于</span>
    <h1>开源，免费，不伺候</h1>
    <p class="lead">PlanQuest 以开源协议发布，源码、更新日志与问题反馈全在 GitHub。没有账号体系，没有云端绑架，.pqplan 文件在哪，阿刺跟到哪。</p>
    <div class="btn-row">
      <a class="btn btn-primary" href="${SOURCE_URL}" target="_blank" rel="noopener">看源码</a>
      <a class="btn btn-ghost" href="${ISSUES_URL}" target="_blank" rel="noopener">提 Issue</a>
      <a class="btn btn-warn" href="mailto:${MAIL}">联系阿刺饲养员</a>
    </div>
  </section>
  <section class="card">
    <h3>开源协议</h3>
    <p class="muted">项目仓库内 LICENSE 文件为权威声明。想改阿刺的脾气？提 PR，别在群里喊。</p>
  </section>`;
}

/* ---------------- 路由与事件 ---------------- */
function route() {
  const raw = location.hash.replace(/^#\/?/, '') || 'home';
  const [name, anchor] = raw.split('#');
  const page = ['home', 'download', 'guide', 'about'].includes(name) ? name : 'home';
  document.querySelector('.topbar .main-nav').outerHTML = navHtml(page);
  app.innerHTML = ({ home: homeView, download: downloadView, guide: guideView, about: aboutView })[page]();
  document.title = `PlanQuest · ${{ home: '带刺、记仇、偶尔背锅', download: '下载', guide: '驯刺手册', about: '关于' }[page]}`;

  if (page === 'download') {
    app.querySelectorAll('[data-platform]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.platform = btn.dataset.platform;
        route();
      });
    });
  }
  if (raw.startsWith('community')) { location.href = 'community.html'; return; }
  if (anchor) {
    requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth' }));
  }
}

document.getElementById('top-web-link').href = WEB_APP_URL;
window.addEventListener('hashchange', route);

loadRelease().then(route);
route();

/* PWA：注册极简离线缓存 */
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
