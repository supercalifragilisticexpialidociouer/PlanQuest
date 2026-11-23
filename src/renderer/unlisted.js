'use strict';

/* 未授权软件提醒窗口 */

let payload = { items: [], deduct: 15 };

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function render() {
  const list = document.getElementById('u-list');
  list.innerHTML = payload.items
    .map((it) => {
      const hot = it.count >= payload.limit || it.count >= (it.limit || 5) - 1;
      return `<div class="item"><div class="nm">${esc(it.name)}.exe</div><div class="ct ${hot ? 'hot' : ''}">第 ${it.count}/${it.limit} 次</div></div>`;
    })
    .join('');
  const warn = document.getElementById('u-warn');
  warn.textContent = `这里只提醒、不扣积分。要常用的话请加入白名单；如果只是某个计划里要用，把它写进该计划的「计划内需要的软件」（那时才会扣 10 积分）。`;
}

function done() {
  window.api.unlistedClose();
}

document.getElementById('u-ok').onclick = done;
document.getElementById('u-kill').onclick = async () => {
  const names = payload.items.map((x) => x.name);
  document.getElementById('u-kill').textContent = '正在关闭…';
  await window.api.unlistedKill(names);
  done();
};

if (window.api && window.api.onUnlisted) {
  window.api.onUnlisted((data) => {
    payload = Object.assign(payload, data || {});
    render();
  });
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') done();
});

render();
