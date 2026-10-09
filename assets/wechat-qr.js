// 点击带 data-wechat-qr 的链接，弹出公众号二维码
(function () {
  var css = '.wxqr-overlay{position:fixed;inset:0;background:rgba(17,17,16,.55);display:none;align-items:center;justify-content:center;z-index:1000;padding:1.25rem}' +
    '.wxqr-overlay.open{display:flex}' +
    '.wxqr-box{background:#FAF9F6;max-width:300px;width:100%;padding:2rem 1.75rem 1.6rem;text-align:center;position:relative;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#111110}' +
    '.wxqr-box img{width:200px;height:200px;display:block;margin:0 auto 1.1rem;mix-blend-mode:multiply}' +
    '.wxqr-title{font-size:1rem;font-weight:500;margin-bottom:.35rem}' +
    '.wxqr-sub{font-size:.8rem;color:#6B6B6B;line-height:1.6}' +
    '.wxqr-close{position:absolute;top:.5rem;right:.7rem;background:none;border:0;font-size:1.4rem;line-height:1;color:#6B6B6B;cursor:pointer;padding:.3rem}' +
    '.wxqr-close:hover{color:#111110}';
  var style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);
  var inWeChat = /MicroMessenger/i.test(navigator.userAgent);
  var ov = document.createElement('div');
  ov.className = 'wxqr-overlay';
  ov.setAttribute('role', 'dialog');
  ov.setAttribute('aria-label', '公众号二维码');
  ov.innerHTML = '<div class="wxqr-box"><button class="wxqr-close" aria-label="关闭">×</button>' +
    '<img src="/assets/wechat-mp-qr.png" alt="公众号《时光笔记簿》二维码">' +
    '<div class="wxqr-title">公众号 · 时光笔记簿</div>' +
    '<div class="wxqr-sub">' + (inWeChat ? '长按二维码，识别并关注' : '用微信扫一扫，关注公众号') + '</div></div>';
  function close() { ov.classList.remove('open'); }
  ov.addEventListener('click', function (e) { if (e.target === ov || e.target.className === 'wxqr-close') close(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(ov); });
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('[data-wechat-qr]');
    if (!a) return;
    e.preventDefault();
    if (!ov.parentNode) document.body.appendChild(ov);
    ov.classList.add('open');
  });
})();
