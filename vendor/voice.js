/* 离线豆包预合成语音播放引擎（零外链、支持 file:// 与 https://、多句精准拼接 + 词序容错 + 纯豆包模式） */
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

  // 针对极少数台词精修后改动较大的同课引导句，精准映射到同课已预录的豆包原声
  var ALIAS_MAP = {
    '小勺已舀起食盐！把小勺拖到杯上方松手倒进去吧': '第1步：拖或点左侧的食盐碗或小勺，把白色食盐倒入杯',
    '小勺已舀起白糖！把小勺拖到杯上方松手倒进去吧': '第5步：再来对比白糖！拖或点左侧的白糖碗倒入杯',
    '很好！再点草坪边的大温度计看温度，或直接拖对应季节木牌进?槽': '很好！再点草坪边的大温度计，看看红色液柱是高还是低',
    '再点公园里的小朋友看穿衣打扮，或直接拖正确木牌进?槽': '再点公园里的小朋友，看看他穿着什么衣服在玩什么',
    '第3步：拖起或点木质牙签到鼓鼓的保鲜袋上，扎一个小孔': '第3步：拖或点3D牙签在鼓鼓的袋身上扎一个小孔',
    '冬天零下3度，小农夫已经穿上厚蓝羽绒服，系上红围巾保暖啦': '冬天零下3度，小朋友已经穿上厚棉衣，戴上围巾和毛线帽保暖啦',
    '第1关（盲猜）：点大树，温度计和小朋友看线索，看懂也可直接拖木牌进?槽': '集齐线索后，把桌前木牌放进?门牌槽',
    '第2关（盲猜）：点大树，温度计和小朋友看线索，看懂也可直接拖木牌进?槽': '集齐线索后，把桌前木牌放进?门牌槽',
    '第3关（盲猜）：点大树，温度计和小朋友看线索，看懂也可直接拖木牌进?槽': '集齐线索后，把桌前木牌放进?门牌槽',
    '第4关（盲猜）：点大树，温度计和小朋友看线索，看懂也可直接拖木牌进?槽': '集齐线索后，把桌前木牌放进?门牌槽'
  };

  // 保留原标点，动态规划匹配相邻已预录豆包片段
  function resolveSequence(text, map) {
    var parts = String(text).match(/[^。！？!?；;：:\s]+[。！？!?；;：:\s]*/g) || [];
    if (!parts.length || parts.length > 16) return null;
    var queues = new Array(parts.length + 1);
    queues[parts.length] = [];
    for (var start = parts.length - 1; start >= 0; start--) {
      var phrase = '';
      for (var end = start; end < parts.length; end++) {
        phrase += parts[end];
        var nk = normText(phrase);
        var clip = map[nk] || (ALIAS_MAP[nk] && map[ALIAS_MAP[nk]]);
        if (clip && queues[end + 1]) {
          queues[start] = [clip].concat(queues[end + 1]);
        }
      }
    }
    return queues[0] || null;
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

  // 二元组 Dice 相似度容错匹配（解决“拖或点”↔“拖起或点”、“金黄”↔“琥珀”等微调文案回退机械音的问题）
  function findSimilarMatch(map, key, minScore) {
    if (!key || key.length < 6) return null;
    var threshold = minScore || 0.52;
    var aLen = key.length - 1;
    var bgA = Object.create(null);
    for (var i = 0; i < aLen; i++) {
      var g = key.slice(i, i + 2);
      bgA[g] = (bgA[g] || 0) + 1;
    }
    var keys = Object.keys(map);
    var bestFile = null, bestScore = 0;
    for (var j = 0; j < keys.length; j++) {
      var k = keys[j];
      var bLen = k.length - 1;
      if (bLen < 5) continue;
      // 长度相差超过 2.2 倍时直接跳过，避免短语误匹配
      if (bLen > aLen * 2.2 || aLen > bLen * 2.2) continue;
      var used = Object.create(null);
      var inter = 0;
      for (var t = 0; t < bLen; t++) {
        var gb = k.slice(t, t + 2);
        var avail = bgA[gb];
        if (avail) {
          var u = used[gb] || 0;
          if (u < avail) { used[gb] = u + 1; inter++; }
        }
      }
      if (!inter) continue;
      var score = (2 * inter) / (aLen + bLen);
      if (score > bestScore) {
        bestScore = score;
        bestFile = map[k];
      }
    }
    return bestScore >= threshold ? bestFile : null;
  }

  function resolveClips(text) {
    var map = window.__XK_AUDIO_MAP;
    if (!map) return null;

    var fullKey = normText(text);
    if (!fullKey) return null;
    if (map[fullKey]) return [map[fullKey]];
    if (ALIAS_MAP[fullKey] && map[ALIAS_MAP[fullKey]]) return [map[ALIAS_MAP[fullKey]]];

    var exactQueue = resolveSequence(text, map);
    if (exactQueue && exactQueue.length) return exactQueue;

    // 1) 整句先做高精度相似匹配（优先保留整句语义，避免被拆成零碎短句）
    var numNorm = fullKey.replace(/多留空\d+(?:\.\d+)?秒/g, '留空更久');
    if (numNorm !== fullKey && map[numNorm]) return [map[numNorm]];
    var wholeSim = findSimilarMatch(map, fullKey, 0.52) || (numNorm !== fullKey ? findSimilarMatch(map, numNorm, 0.52) : null);
    if (wholeSim) return [wholeSim];

    // 2) 按句号/感叹号/问号/换行/双空格拆分成多句无缝连播（支持 spoken + '！' + curGuideSpeech）
    var parts = String(text || '')
      .split(/[。！？!?\n]+|\s{1,}(?=[\u4e00-\u9fff])/)
      .map(function (p) { return normText(p); })
      .filter(Boolean);

    if (parts.length > 1) {
      var queue = [];
      for (var i = 0; i < parts.length; i++) {
        var pi = parts[i];
        if (map[pi]) {
          queue.push(map[pi]);
        } else if (ALIAS_MAP[pi] && map[ALIAS_MAP[pi]]) {
          queue.push(map[ALIAS_MAP[pi]]);
        } else {
          if (i + 1 < parts.length) {
            var merged = pi + '，' + parts[i + 1];
            var merged2 = pi + parts[i + 1];
            if (map[merged]) { queue.push(map[merged]); i++; continue; }
            if (map[merged2]) { queue.push(map[merged2]); i++; continue; }
          }
          var best = findBestMatch(map, pi) || findSimilarMatch(map, pi, 0.58);
          if (best) queue.push(best);
        }
      }
      if (queue.length > 0) return queue;
    }

    // 3) 单句包含匹配
    var fuzzy = findBestMatch(map, fullKey) || (numNorm !== fullKey ? findBestMatch(map, numNorm) : null);
    if (fuzzy) return [fuzzy];

    // 4) 兜底：组合诊断句按关键词匹配对应预录豆包诊断句
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
    var bp = (typeof basePath === 'string' && basePath) ? basePath : '../audio/';
    var src = bp + files[0];
    var a = new Audio(src);
    a.preload = 'auto';
    curAudio = a;
    a.onended = function () {
      if (token !== playToken) return;
      if (files.length > 1) {
        playQueue(files.slice(1), token, bp, origText);
      } else {
        curAudio = null;
      }
    };
    a.onerror = function () {
      if (token !== playToken) return;
      curAudio = null;
      if (files.length > 1) playQueue(files.slice(1), token, bp, origText);
    };
    var p = a.play();
    if (p && typeof p.catch === 'function') {
      p.catch(function () {
        if (token === playToken && curAudio === a) curAudio = null;
      });
    }
  }

  function speak(text, basePath, doubaoOnly) {
    if (!text) return false;
    // 兼容旧调用误把配置对象当作第二参数的情况（如 { mute: false }）
    var bp = '../audio/';
    var strictDoubao = !!doubaoOnly;
    if (typeof basePath === 'string' && basePath) {
      bp = basePath;
    } else if (basePath && typeof basePath === 'object') {
      if (basePath.mute) return false;
      if (typeof basePath.basePath === 'string' && basePath.basePath) bp = basePath.basePath;
      if (basePath.doubaoOnly !== undefined) strictDoubao = !!basePath.doubaoOnly;
    }
    stop();
    var myToken = playToken;
    var clips = resolveClips(text);
    if (clips && clips.length) {
      playQueue(clips, myToken, bp, text);
      return true;
    }
    if (!strictDoubao && !window.__XK_AUDIO_MAP) {
      fallbackTTS(text);
    }
    return false;
  }

  window.__xkVoice = {
    speak: speak,
    stop: stop,
    isPlaying: function () { return !!curAudio; },
    resolveClips: resolveClips,
    normText: normText
  };
})();
