/* ============================================================
   界面风格切换（demo 用）：静 Calm ⇄ 机体 Bento
   - 必须在 <head> 中、页面自身主题脚本之前同步加载
   - 切换时带上当前深浅色偏好与所在页面，目标页读取后写入自己的设置
   - 正式重构时两种风格共用同一数据层，这里只是用两个 demo 页面模拟
   ============================================================ */
(function () {
  'use strict';
  var STYLES = {
    calm:  { path: 'b-calm',  key: 'fnm.b.settings', modeKey: 'theme',   hash: function (p) { return '#/' + p; } },
    bento: { path: 'c-bento', key: 'fnm-c:settings', modeKey: 'ui.mode', hash: function (p) { return '#' + p; } },
  };
  var cur = location.pathname.indexOf('c-bento') >= 0 ? 'bento' : 'calm';

  function readMode(style) {
    try { return JSON.parse(localStorage.getItem(STYLES[style].key) || '{}')[STYLES[style].modeKey] || 'light'; }
    catch (e) { return 'light'; }
  }

  // 接收从另一风格带过来的深浅色偏好
  var q = new URLSearchParams(location.search), incoming = q.get('mode');
  if (incoming && /^(light|dark|auto)$/.test(incoming)) {
    try {
      var me = STYLES[cur], s = JSON.parse(localStorage.getItem(me.key) || '{}');
      s[me.modeKey] = incoming;
      localStorage.setItem(me.key, JSON.stringify(s));
    } catch (e) { /* 隐私模式 */ }
    q.delete('mode');
    var qs = q.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
  }
  try { localStorage.setItem('fnm.style', cur); } catch (e) {}

  window.FNStyle = {
    current: cur,
    list: [['calm', '静'], ['bento', '机体']],
    go: function (target) {
      if (!STYLES[target] || target === cur) return;
      var page = (location.hash.match(/(overview|docker|settings)/) || [])[1] || 'overview';
      document.documentElement.style.transition = 'opacity .18s';
      document.documentElement.style.opacity = '0';
      setTimeout(function () {
        location.href = '../' + STYLES[target].path + '/?mode=' + readMode(cur) + STYLES[target].hash(page);
      }, 160);
    },
    // 渲染一个两段式切换器到 el（样式由各页面自己的 .style-sw 定义）
    mount: function (el) {
      if (!el) return;
      el.setAttribute('role', 'group');
      el.setAttribute('aria-label', '界面风格');
      el.innerHTML = this.list.map(function (s) {
        return '<button type="button" data-style="' + s[0] + '" aria-pressed="' + (s[0] === cur) + '" title="界面风格：' + s[1] + '">' + s[1] + '</button>';
      }).join('');
      el.addEventListener('click', function (e) {
        var b = e.target.closest('button[data-style]');
        if (b) window.FNStyle.go(b.dataset.style);
      });
    },
  };
})();
