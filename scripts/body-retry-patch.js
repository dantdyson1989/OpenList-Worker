/* openlist-body-retry-patch
 *
 * 背景：EdgeOne 运行时偶发丢失 POST 请求体（平台侧、与端点无关，实测
 * /api/fs/list 与 /api/auth/login 均约 25–50% 命中）。后端 jsonBodyGuard
 * 会把读不到 body 的请求以 400 { message: "failed to read request body" }
 * 显式拒绝 —— 该响应保证请求未到达任何 handler、未执行任何写操作，
 * 因此客户端重试是安全的（即使对 mkdir/rename/delete 这类写请求也一样）。
 * 官方前端产物本身无重试逻辑，用户会在界面上直接看到报错。本补丁在
 * 构建期以内联 <script> 形式插进 dist/index.html 的 <head> 首位，
 * 在应用 JS 执行前给 fetch 与 XMLHttpRequest（axios 走这条）装上重试：
 * 仅当响应恰好是上述 400 时才重试，最多 4 次、300ms 递增退避。
 * 其余响应（包括 "request body required" / "invalid JSON" 这类真客户端
 * 错误）一律原样放行，绝不重试。
 */
(function () {
  var MARK = "failed to read request body";
  var MAX_RETRIES = 4;

  function isApi(url) {
    return typeof url === "string" && url.indexOf("/api/") !== -1;
  }
  function isBodyLost(status, text) {
    if (status !== 400 || !text) return false;
    try {
      return JSON.parse(text).message === MARK;
    } catch (e) {
      return false;
    }
  }
  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  /* ---- fetch ---- */
  if (typeof window !== "undefined" && window.fetch) {
    var origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : input && input.url;
      var method =
        (init && init.method) || (input && input.method) || "GET";
      if (
        !isApi(url) ||
        method.toUpperCase() === "GET" ||
        method.toUpperCase() === "HEAD"
      ) {
        return origFetch(input, init);
      }
      var attempt = 0;
      function go() {
        return origFetch(input, init).then(function (res) {
          if (attempt >= MAX_RETRIES || res.status !== 400) return res;
          return res
            .clone()
            .text()
            .then(function (t) {
              if (!isBodyLost(400, t)) return res;
              attempt++;
              return sleep(300 * attempt).then(go);
            })
            .catch(function () {
              return res;
            });
        });
      }
      return go();
    };
  }

  /* ---- XMLHttpRequest（axios 走这条）----
   * axios 在 send() 之前就已设置 onreadystatechange，因此在 send() 时
   * 捕获它并换成 gate：gate 在 readyState 4 时先判断是否为 body 丢失
   * 400，是则用同一对象重新 open/send（调用方持有的 xhr 引用不变，
   * 最终响应仍会流向调用方原 handler）；否则原样放行。 */
  if (typeof XMLHttpRequest !== "undefined") {
    var Proto = XMLHttpRequest.prototype;
    var origOpen = Proto.open;
    var origSend = Proto.send;
    var origSetHeader = Proto.setRequestHeader;
    Proto.open = function (method, url) {
      this._rp = {
        method: method,
        url: url,
        async: arguments[2],
        user: arguments[3],
        password: arguments[4],
        headers: {},
        body: null,
        attempts: 0,
        responseType: "",
        timeout: 0,
        withCredentials: false,
      };
      return origOpen.apply(this, arguments);
    };
    Proto.setRequestHeader = function (k, v) {
      if (this._rp) this._rp.headers[k] = v;
      return origSetHeader.apply(this, arguments);
    };
    Proto.send = function (body) {
      var xhr = this;
      var meta = xhr._rp;
      if (!meta) return origSend.apply(xhr, arguments);
      meta.body = body;
      try {
        meta.responseType = xhr.responseType;
      } catch (e) {}
      try {
        meta.timeout = xhr.timeout;
      } catch (e) {}
      try {
        meta.withCredentials = xhr.withCredentials;
      } catch (e) {}
      var userHandler = xhr.onreadystatechange;
      function gate() {
        if (xhr.readyState !== 4) {
          if (typeof userHandler === "function")
            return userHandler.apply(xhr, arguments);
          return;
        }
        var t = "";
        try {
          t = xhr.responseText || "";
        } catch (e) {}
        if (!t && xhr.response) {
          try {
            t =
              typeof xhr.response === "string"
                ? xhr.response
                : JSON.stringify(xhr.response);
          } catch (e) {}
        }
        if (
          meta.attempts < MAX_RETRIES &&
          isApi(meta.url) &&
          isBodyLost(xhr.status, t)
        ) {
          meta.attempts++;
          setTimeout(function () {
            origOpen.call(
              xhr,
              meta.method,
              meta.url,
              meta.async !== false,
              meta.user,
              meta.password,
            );
            for (var k in meta.headers) {
              try {
                origSetHeader.call(xhr, k, meta.headers[k]);
              } catch (e) {}
            }
            try {
              xhr.responseType = meta.responseType;
            } catch (e) {}
            try {
              xhr.timeout = meta.timeout;
            } catch (e) {}
            try {
              xhr.withCredentials = meta.withCredentials;
            } catch (e) {}
            xhr.onreadystatechange = gate;
            origSend.call(xhr, meta.body);
          }, 300 * meta.attempts);
          return;
        }
        if (typeof userHandler === "function")
          return userHandler.apply(xhr, arguments);
      }
      xhr.onreadystatechange = gate;
      return origSend.apply(xhr, arguments);
    };
  }
})();
