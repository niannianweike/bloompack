/* 离线本地教材 PDF 存储（IndexedDB）与按页渲染引擎（兼容 file:// 与 https://，零上传） */
(function () {
  'use strict';

  var DB_NAME = 'xk-local-pdfs';
  var DB_VER = 1;
  var STORE = 'pdfs';
  var enginePromise = null;
  var activeDocs = {}; // bookId -> { pdfDoc, meta, cache: Map<pdfIdx, Promise<string>> }

  function openDB() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) return reject(new Error('浏览器不支持 IndexedDB'));
      var req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function idbGet(key) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readonly');
        var req = tx.objectStore(STORE).get(key);
        tx.oncomplete = function () { db.close(); resolve(req.result || null); };
        tx.onerror = tx.onabort = function () { db.close(); reject(tx.error); };
      });
    }).catch(function () { return null; });
  }

  function idbPut(key, val) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(val, key);
        tx.oncomplete = function () { db.close(); resolve(); };
        tx.onerror = tx.onabort = function () { db.close(); reject(tx.error); };
      });
    });
  }

  function idbDel(key) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(key);
        tx.oncomplete = function () { db.close(); resolve(); };
        tx.onerror = tx.onabort = function () { db.close(); reject(tx.error); };
      });
    });
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('加载失败: ' + src)); };
      document.head.appendChild(s);
    });
  }

  function ensurePdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (enginePromise) return enginePromise;
    var isFile = location.protocol === 'file:';
    enginePromise = loadScript('vendor/pdf.min.js').then(function () {
      if (!window.pdfjsLib) throw new Error('pdf.js 初始化失败');
      if (isFile) {
        // file:// 下直接加载 worker 脚本到主线程，避免浏览器跨源 Worker 限制
        return loadScript('vendor/pdf.worker.min.js').then(function () {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
          return window.pdfjsLib;
        });
      }
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
      return window.pdfjsLib;
    });
    return enginePromise;
  }

  function inferOffset(numPages, defaultOffset, printedTotal) {
    if (numPages === printedTotal) return 0;
    if (numPages >= printedTotal + defaultOffset - 1 && numPages <= printedTotal + defaultOffset + 2) {
      return defaultOffset;
    }
    var diff = numPages - printedTotal;
    return diff >= 0 && diff <= 14 ? Math.max(0, diff - 1) : defaultOffset;
  }

  function openBuffer(bookId, arrayBuffer, meta) {
    return ensurePdfJs().then(function (lib) {
      var data = new Uint8Array(arrayBuffer);
      return lib.getDocument({ data: data, disableFontFace: false, verbosity: 0 }).promise.then(function (pdfDoc) {
        var entry = { pdfDoc: pdfDoc, meta: meta, cache: new Map() };
        activeDocs[bookId] = entry;
        return entry;
      });
    });
  }

  function importFile(bookId, file, opts) {
    opts = opts || {};
    var defOffset = typeof opts.defaultOffset === 'number' ? opts.defaultOffset : 7;
    var printedTotal = opts.printedTotal || 61;
    return file.arrayBuffer().then(function (buf) {
      // 先拷贝一份用于 IndexedDB 存储（pdf.js 可能转移 buffer）
      var saveBlob = new Blob([buf], { type: 'application/pdf' });
      return ensurePdfJs().then(function (lib) {
        return lib.getDocument({ data: new Uint8Array(buf), verbosity: 0 }).promise.then(function (pdfDoc) {
          var offset = inferOffset(pdfDoc.numPages, defOffset, printedTotal);
          var meta = {
            name: file.name || '课本.pdf',
            size: file.size || saveBlob.size,
            pages: pdfDoc.numPages,
            offset: offset,
            ts: Date.now()
          };
          activeDocs[bookId] = { pdfDoc: pdfDoc, meta: meta, cache: new Map() };
          return idbPut(bookId, { blob: saveBlob, meta: meta }).then(function () { return meta; });
        });
      });
    });
  }

  function restore(bookId) {
    if (activeDocs[bookId]) return Promise.resolve(activeDocs[bookId].meta);
    return idbGet(bookId).then(function (rec) {
      if (!rec || !rec.blob) return null;
      return rec.blob.arrayBuffer().then(function (buf) {
        return openBuffer(bookId, buf, rec.meta).then(function (entry) { return entry.meta; });
      });
    }).catch(function () { return null; });
  }

  function setOffset(bookId, newOffset) {
    var entry = activeDocs[bookId];
    if (!entry) return Promise.resolve(null);
    entry.meta.offset = Math.max(-5, Math.min(25, newOffset));
    return idbGet(bookId).then(function (rec) {
      if (!rec) return entry.meta;
      rec.meta = entry.meta;
      return idbPut(bookId, rec).then(function () { return entry.meta; });
    });
  }

  function remove(bookId) {
    var entry = activeDocs[bookId];
    if (entry) {
      entry.cache.forEach(function (p) {
        p.then(function (url) { if (url && url.indexOf('blob:') === 0) URL.revokeObjectURL(url); }).catch(function () {});
      });
      try { entry.pdfDoc.destroy(); } catch (e) {}
      delete activeDocs[bookId];
    }
    return idbDel(bookId);
  }

  function getMeta(bookId) {
    return activeDocs[bookId] ? activeDocs[bookId].meta : null;
  }

  function renderPrintedPage(bookId, printedNum, targetHeight) {
    var entry = activeDocs[bookId];
    if (!entry) return Promise.resolve(null);
    var pdfPageNo = printedNum + (entry.meta.offset || 0);
    if (pdfPageNo < 1 || pdfPageNo > entry.pdfDoc.numPages) return Promise.resolve(null);

    if (entry.cache.has(pdfPageNo)) return entry.cache.get(pdfPageNo);

    // 限制缓存最多 24 页，防止长时翻阅占内存
    if (entry.cache.size >= 24) {
      var oldestKey = entry.cache.keys().next().value;
      var oldP = entry.cache.get(oldestKey);
      entry.cache.delete(oldestKey);
      if (oldP) oldP.then(function (u) { if (u && u.indexOf('blob:') === 0) URL.revokeObjectURL(u); }).catch(function () {});
    }

    var H = targetHeight || 1040;
    var promise = entry.pdfDoc.getPage(pdfPageNo).then(function (page) {
      var vp1 = page.getViewport({ scale: 1 });
      var scale = Math.max(0.6, Math.min(2.4, H / vp1.height));
      var vp = page.getViewport({ scale: scale });
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      var ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return page.render({ canvasContext: ctx, viewport: vp }).promise.then(function () {
        try { page.cleanup(); } catch (e) {}
        return new Promise(function (resolve) {
          canvas.toBlob(function (blob) {
            if (blob) resolve(URL.createObjectURL(blob));
            else resolve(canvas.toDataURL('image/jpeg', 0.86));
          }, 'image/jpeg', 0.88);
        });
      });
    }).catch(function () {
      entry.cache.delete(pdfPageNo);
      return null;
    });

    entry.cache.set(pdfPageNo, promise);
    return promise;
  }

  window.__xkPdfBook = {
    importFile: importFile,
    restore: restore,
    remove: remove,
    setOffset: setOffset,
    getMeta: getMeta,
    renderPrintedPage: renderPrintedPage
  };
})();
