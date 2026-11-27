/* 离线豆包预合成语音播放引擎（零外链、支持 file:// 与 https://、缺音频时自动优雅回退） */
(function () {
  'use strict';

  var curAudio = null;
  var playToken = 0;

  function normText(raw) {
    return String(raw || '')
      .replace(/<[^>]+>/g, '')
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
      .replace(/[①②③④⑤⑥⑦⑧⑨⑩✦★☆✓✔✗✘▶↺🔊]/g, '')
      .replace(/[「」『』【】《》“”"']/g, '')
      .replace(/[·•]/g, '，')
      .replace(/\s+/g, '')
      .replace(/[，,、]+/g, '，')
      .replace(/[。！!？?；;：:]+$/g, '')
      .trim();
  }

  function resolveClips(text) {
    var map = window.__XK_AUDIO_MAP;
    if (!map) return null;

    var fullKey = normText(text);
    if (!fullKey) return null;
    if (map[fullKey]) return [map[fullKey]];

    // 1) 按句号/感叹号/问号/换行/双空格拆分成多句无缝连播（支持 spoken + '！' + curGuideSpeech）
    var parts = String(text || '')
      .split(/[。！？!?\n]+|\s{1,}(?=[\u4e00-\u9fff])/)
      .map(function (p) { return normText(p); })
      .filter(Boolean);

    if (parts.length > 1) {
      var queue = [];
      for (var i = 0; i < parts.length; i++) {
        if (map[parts[i]]) {
          queue.push(map[parts[i]]);
        } else {
          // 尝试将相邻两句合并查找（例如“太棒啦！轻重软硬...”）
          if (i + 1 < parts.length) {
            var merged = parts[i] + '，' + parts[i + 1];
            var merged2 = parts[i] + parts[i + 1];
            if (map[merged]) { queue.push(map[merged]); i++; continue; }
            if (map[merged2]) { queue.push(map[merged2]); i++; continue; }
          }
          // 若存在前缀/包含匹配（例如动态数字句），尽量匹配最长的预录豆包片段
          var best = findBestMatch(map, parts[i]);
          if (best) queue.push(best);
        }
      }
      if (queue.length > 0) return queue;
    }

    // 2) 单句模糊匹配（处理极少数带动态秒数/数字的句子，避免跳回机械音）
    // 先处理类似「改进款比上节课款多留空 0.8 秒...」的动态数字替换
    var numNorm = fullKey.replace(/多留空\d+(?:\.\d+)?秒/g, '留空更久');
    if (numNorm !== fullKey && map[numNorm]) return [map[numNorm]];
    var fuzzy = findBestMatch(map, fullKey) || (numNorm !== fullKey ? findBestMatch(map, numNorm) : null);
    if (fuzzy) return [fuzzy];

    // 3) 兜底：若为「改进款落得更快！...」等组合诊断句，按关键词匹配对应预录豆包诊断句
    if (fullKey.indexOf('改进款落得更快') !== -1) {
      var diagTargets = [
        ['尾巴太重', '改进款落得更快！因为尾巴太重，想让它落得更慢更稳，试着把折尾重量调到适中，再试飞一次'],
        ['尾巴太轻', '改进款落得更快！因为尾巴太轻会摇晃，想让它落得更慢更稳，试着把折尾重量调到适中，再试飞一次'],
        ['飞翼偏短', '改进款落得更快！因为飞翼偏短，想让它落得更慢更稳，试着把飞翼长度往右拉长，再试飞一次'],
        ['飞翼偏窄', '改进款落得更快！因为飞翼偏窄，想让它落得更慢更稳，试着把飞翼宽度往右拉宽，再试飞一次'],
        ['', '改进款落得更快！因为飞翼面积还不够大，想让它落得更慢更稳，试着把飞翼长度往右拉长，飞翼宽度往右拉宽，再试飞一次']
      ];
      for (var d = 0; d < diagTargets.length; d++) {
        if ((!diagTargets[d][0] || fullKey.indexOf(diagTargets[d][0]) !== -1) && map[diagTargets[d][1]]) {
          return [map[diagTargets[d][1]]];
        }
      }
    }
    return null;
  }

  function findBestMatch(map, key) {
    if (!key || key.length < 4) return null;
    var bestFile = null, bestScore = 0;
    var keys = Object.keys(map);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k.length < 4) continue;
      if (key.indexOf(k) !== -1 && k.length > bestScore && k.length >= key.length * 0.55) {
        bestScore = k.length;
        bestFile = map[k];
      } else if (k.indexOf(key) !== -1 && key.length >= k.length * 0.72 && key.length > bestScore) {
        bestScore = key.length;
        bestFile = map[k];
      }
    }
    return bestFile;
  }

  function stop() {
    playToken++;
    if (curAudio) {
      try {
        curAudio.onended = null;
        curAudio.onerror = null;
        curAudio.pause();
        curAudio.currentTime = 0;
      } catch (e) {}
      curAudio = null;
    }
    try {
      if (window.speechSynthesis) window.speechSynthesis.cancel();
    } catch (e) {}
  }

  function fallbackTTS(text) {
    try {
      if (!window.speechSynthesis || !text) return;
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      u.rate = 0.92;
      u.pitch = 1.06;
      window.speechSynthesis.speak(u);
    } catch (e) {}
  }

  function playQueue(files, token, basePath, origText) {
    if (token !== playToken || !files.length) return;
    var src = basePath + files[0];
    var a = new Audio(src);
    a.preload = 'auto';
    curAudio = a;
    a.onended = function () {
      if (token !== playToken) return;
      if (files.length > 1) {
        playQueue(files.slice(1), token, basePath, origText);
      } else {
        curAudio = null;
      }
    };
    a.onerror = function () {
      if (token !== playToken) return;
      curAudio = null;
      if (files.length > 1) playQueue(files.slice(1), token, basePath, origText);
    };
    var p = a.play();
    if (p && typeof p.catch === 'function') {
      p.catch(function () {
        // 浏览器首次手势前拦截自动播放时静默忽略，不产生控制台报错
      });
    }
  }

  function speak(text, basePath) {
    if (!text) return false;
    stop();
    var myToken = playToken;
    var clips = resolveClips(text);
    if (clips && clips.length) {
      playQueue(clips, myToken, basePath || '../audio/', text);
      return true;
    }
    fallbackTTS(text);
    return false;
  }

  window.__xkVoice = {
    speak: speak,
    stop: stop,
    resolveClips: resolveClips,
    normText: normText
  };
})();
