/**
 * Vercel Edge Function 部署入口（api/index.js）
 *
 * 基于 worker.js 逻辑适配，运行在 Vercel Edge Runtime（V8 isolate）。
 * 与 Cloudflare Workers 的主要差异：
 *  - 导出方式改为 default export { GET, POST, ... } 或统一的 default handler
 *  - 顶部声明 export const config = { runtime: 'edge' }
 *  - 不再接收 (request, env, ctx)，直接接收 Web Request 对象
 *
 * 注意：Vercel Edge Runtime 不支持原生 WebSocket 升级，
 * WebSocket 代理请求会被透传给上游，但双向流不可用。
 */

export const config = {
	runtime: "edge",
};

// ─── 目标站点配置 ───────────────────────────────────────────────────────────────
const TARGET_DOMAIN = "stripchat.com";
const TARGET_URL    = `https://${TARGET_DOMAIN}`;

// ─── 需要代理的相关域名 ─────────────────────────────────────────────────────────
const STRIPCHAT_SUBDOMAIN_RE = /[a-z0-9-]+\.stripchat\.com/gi;

const PROXY_DOMAINS = [
	"stripchat.com",
	"www.stripchat.com",
	"zh.stripchat.com",
	"b-eu-ams.stripst.com",
	"b-eu.stripst.com",
	"img.strpst.com",
	"static.stripst.com",
	"websocket-sp-v6.stripchat.com",
	"websocket-sp-v6.st.chantrail.com",
];

// ─── Vercel Edge Function 入口 ──────────────────────────────────────────────────
export default function handler(request) {
	return handleRequest(request);
}

// ─── 主请求处理函数 ─────────────────────────────────────────────────────────────
async function handleRequest(request) {
	const url = new URL(request.url);

	if (request.method === "OPTIONS") {
		return handleCORS();
	}

	if (url.pathname === "/_csp" || url.pathname.includes("csp-report")) {
		return new Response(null, { status: 204 });
	}

	if (url.pathname.startsWith("/cdn-cgi/")) {
		return proxyChallenge(request, url);
	}

	// WebSocket：Edge Runtime 不支持双向 WS，此处仅做透传尝试
	const upgradeHeader = request.headers.get("Upgrade");
	if (upgradeHeader && upgradeHeader.toLowerCase() === "websocket") {
		const wsUrl = new URL(url.pathname + url.search, TARGET_URL);
		wsUrl.protocol = wsUrl.protocol.replace("http", "ws");
		return fetch(wsUrl.toString(), {
			method: request.method,
			headers: request.headers,
		});
	}

	try {
		const targetUrl = new URL(url.pathname + url.search + url.hash, TARGET_URL);
		let response = await fetch(buildProxyRequest(request, targetUrl));

		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("Location");
			if (location) {
				const normalizedLocation = location
					.replace(/https?:\/\/zh\.stripchat\.com/gi, TARGET_URL)
					.replace(/\/\/zh\.stripchat\.com/gi, `//${TARGET_DOMAIN}`);

				if (
					normalizedLocation.startsWith("/") ||
					PROXY_DOMAINS.some((domain) => normalizedLocation.includes(domain)) ||
					normalizedLocation.match(STRIPCHAT_SUBDOMAIN_RE)
				) {
					const redirectUrl = normalizedLocation.startsWith("/")
						? new URL(normalizedLocation, TARGET_URL)
						: new URL(normalizedLocation);
					response = await fetch(buildProxyRequest(request, redirectUrl));
				}
			}
		}

		return processResponse(response, url, request);
	} catch (error) {
		console.error("Proxy error:", error);
		return new Response(`代理错误: ${error.message}`, {
			status: 502,
			headers: {
				"Content-Type": "text/plain;charset=utf-8",
				"Access-Control-Allow-Origin": "*",
			},
		});
	}
}

// ─── CF Bot 挑战透传 ────────────────────────────────────────────────────────────
async function proxyChallenge(request, url) {
	const targetCdnUrl = new URL(url.pathname + url.search, TARGET_URL);
	const cdnHeaders = new Headers(request.headers);
	cdnHeaders.set("Host", TARGET_DOMAIN);
	[
		"cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor",
		"x-forwarded-for", "x-forwarded-proto", "cf-worker", "cdn-loop",
	].forEach((h) => cdnHeaders.delete(h));

	const cdnResp = await fetch(targetCdnUrl.toString(), {
		method: request.method,
		headers: cdnHeaders,
		body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
		redirect: "manual",
	});

	const newHeaders = new Headers(cdnResp.headers);
	newHeaders.delete("set-cookie");
	for (const [k, v] of cdnResp.headers.entries()) {
		if (k.toLowerCase() === "set-cookie") {
			let c = v.replace(/;\s*Domain=[^;]+/gi, "");
			if (/SameSite=None/i.test(c)) {
				if (!/;\s*Secure\b/i.test(c)) c += "; Secure";
			} else {
				c = c.replace(/;\s*SameSite=[^;]+/gi, "");
				c += "; SameSite=None; Secure";
			}
			if (!c.toLowerCase().includes("path=")) c += "; Path=/";
			newHeaders.append("Set-Cookie", c);
		}
	}
	newHeaders.set("Access-Control-Allow-Origin", "*");
	newHeaders.set("Access-Control-Allow-Credentials", "true");
	return new Response(cdnResp.body, {
		status: cdnResp.status,
		statusText: cdnResp.statusText,
		headers: newHeaders,
	});
}

// ─── 构建代理请求 ───────────────────────────────────────────────────────────────
function buildProxyRequest(originalRequest, targetUrl) {
	const headers = new Headers(originalRequest.headers);

	headers.set("Host", targetUrl.hostname);
	headers.set("Referer", TARGET_URL + "/");
	if (headers.has("Origin")) headers.set("Origin", TARGET_URL);

	headers.set(
		"User-Agent",
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
	);

	if (!headers.has("Accept")) {
		headers.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8");
	}
	headers.set("Accept-Language", "en-US,en;q=0.9");
	headers.set("CF-IPCountry", "US");

	[
		"cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor",
		"x-forwarded-for", "x-forwarded-proto", "x-forwarded-host",
		"x-real-ip", "cf-worker", "cdn-loop",
	].forEach((h) => headers.delete(h));

	const requestInit = {
		method: originalRequest.method,
		headers,
		redirect: "follow",
	};

	if (originalRequest.method !== "GET" && originalRequest.method !== "HEAD" && originalRequest.body) {
		requestInit.body = originalRequest.body;
	}

	return new Request(targetUrl.toString(), requestInit);
}

// ─── 处理响应 ───────────────────────────────────────────────────────────────────
async function processResponse(response, proxyUrl, originalRequest) {
	const responseClone = response.clone();
	const contentType   = response.headers.get("Content-Type") || "";

	const securityHeaders = new Set([
		"content-security-policy",
		"content-security-policy-report-only",
		"x-frame-options",
		"x-content-type-options",
		"strict-transport-security",
		"x-xss-protection",
		"referrer-policy",
	]);

	const newHeaders = new Headers();
	for (const [key, value] of response.headers.entries()) {
		const lk = key.toLowerCase();
		if (!securityHeaders.has(lk) && lk !== "set-cookie") {
			newHeaders.set(key, value);
		}
	}

	newHeaders.set("Access-Control-Allow-Origin", "*");
	newHeaders.set("Access-Control-Allow-Credentials", "true");
	newHeaders.set("Access-Control-Allow-Methods", "*");
	newHeaders.set("Access-Control-Allow-Headers", "*");
	newHeaders.set("Access-Control-Expose-Headers", "*");

	// 处理 Set-Cookie：
	//   - 清除 Domain 限制，避免 cookie 绑定原始域
	//   - 所有 cookie 统一改为 SameSite=None; Secure
	//     原因：代理场景下页面与 API 请求均为跨站，SameSite=Lax 会导致
	//     XHR/fetch 发起的请求不携带 session cookie，服务端认为未登录
	for (const [key, value] of response.headers.entries()) {
		if (key.toLowerCase() === "set-cookie") {
			let c = value.replace(/;\s*Domain=[^;]+/gi, "");
			// 统一设置 SameSite=None; Secure，保证跨站请求携带 cookie
			c = c.replace(/;\s*SameSite=[^;]+/gi, "");
			if (!/;\s*Secure\b/i.test(c)) c += "; Secure";
			c += "; SameSite=None";
			if (!c.toLowerCase().includes("path=")) c += "; Path=/";
			newHeaders.append("Set-Cookie", c);
		}
	}

	const isText =
		contentType.includes("text/html") ||
		contentType.includes("text/css") ||
		contentType.includes("application/javascript") ||
		contentType.includes("text/javascript") ||
		contentType.includes("application/json") ||
		contentType.includes("application/x-javascript");

	if (isText) {
		try {
			let text = await responseClone.text();

			for (const domain of PROXY_DOMAINS) {
				const esc = domain.replace(/\./g, "\\.");
				text = text.replace(new RegExp(`https?://${esc}`, "gi"), proxyUrl.origin);
				text = text.replace(new RegExp(`//${esc}`, "gi"), `//${proxyUrl.host}`);
			}

			text = text.replace(/https?:\/\/([a-z0-9-]+\.stripchat\.com)/gi, proxyUrl.origin);
			text = text.replace(/\/\/([a-z0-9-]+\.stripchat\.com)/gi, `//${proxyUrl.host}`);

			text = text.replace(/wss?:\/\/([a-z0-9-]+\.stripchat\.com)/gi, () => {
				const wsProto = proxyUrl.protocol === "https:" ? "wss:" : "ws:";
				return `${wsProto}//${proxyUrl.host}`;
			});
			text = text.replace(/wss?:\/\/[^"'\s]+/gi, (match) => {
				for (const domain of PROXY_DOMAINS) {
					if (match.includes(domain)) {
						const wsProto = proxyUrl.protocol === "https:" ? "wss:" : "ws:";
						return match.replace(/wss?:/, wsProto).replace(domain, proxyUrl.host);
					}
				}
				return match;
			});

			if (contentType.includes("text/html")) {
				text = text.replace(/<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/gi, "");
				text = text.replace(/<script[^>]*cloudflareinsights\.com[^>]*>[\s\S]*?<\/script>/gi, "<!-- CF blocked -->");
				text = text.replace(/<script[^>]*cloudflareinsights\.com[^>]*\/>/gi, "<!-- CF blocked -->");
				text = text.replace(
					/<script([^>]*)src=(["'])[^"']*cloudflareinsights\.com[^"']*\2([^>]*)>[\s\S]*?<\/script>/gi,
					"<!-- CF blocked -->",
				);
				text = text.replace(/<script[^>]*beacon\.min\.js[^>]*>[\s\S]*?<\/script>/gi, "<!-- Beacon blocked -->");
				text = text.replace(/<script([^>]*)\s+integrity=(["'])[^"']*\2([^>]*)>/gi, "<script$1$3>");
				text = text.replace(/<script([^>]*)\s+crossorigin=(["'])[^"']*\2([^>]*)>/gi, "<script$1$3>");
				text = text.replace(/<link([^>]*)\s+integrity=(["'])[^"']*\2([^>]*)>/gi, "<link$1$3>");
				text = text.replace(/<link([^>]*)\s+crossorigin=(["'])[^"']*\2([^>]*)>/gi, "<link$1$3>");

				text = text.replace("</head>", `${buildProxyScript(proxyUrl)}
<meta http-equiv="Content-Security-Policy" content="upgrade-insecure-requests">
</head>`);
			}

			return new Response(text, {
				status: response.status,
				statusText: response.statusText,
				headers: newHeaders,
			});
		} catch (error) {
			console.error("Text processing error:", error);
		}
	}

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: newHeaders,
	});
}

// ─── 注入脚本生成 ───────────────────────────────────────────────────────────────
function buildProxyScript(proxyUrl) {
	const origin = proxyUrl.origin;
	const host   = proxyUrl.host;
	return `<script>
(function() {
  var O = ${JSON.stringify(origin)};
  var H = ${JSON.stringify(host)};
  var WP = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var blockedDomains = ['cloudflareinsights.com','googletagmanager.com','beacon.min.js'];

  // 0. 伪造 __cf_chl_opt，防止前端检测"未通过 CF Bot 挑战"后渲染错误页
  try { if(!window.__cf_chl_opt) window.__cf_chl_opt = {}; } catch(e){}

  // 1. Cookie 修复
  //    - 去除 Domain 绑定，使 cookie 在代理域下生效
  //    - 保留 SameSite=None（跨站 API 请求必须携带），不再错误地将其删除
  try {
    var desc = Object.getOwnPropertyDescriptor(Document.prototype,'cookie') ||
               Object.getOwnPropertyDescriptor(HTMLDocument.prototype,'cookie');
    if (desc && desc.configurable) {
      Object.defineProperty(document,'cookie',{
        get: function(){ return desc.get.call(document); },
        set: function(v){
          v = v.replace(/;\\s*[Dd]omain=[^;]+/g,'');
          // HTTP 环境下去掉 Secure 标志，避免 cookie 无法写入
          if(location.protocol!=='https:') v=v.replace(/;\\s*[Ss]ecure\\b/g,'');
          // 不再删除 SameSite=None，跨站 fetch/XHR 需要它来携带 cookie
          return desc.set.call(document,v);
        },
        configurable:true
      });
    }
  } catch(e){}

  // 2. 脚本注入拦截（appendChild / insertBefore / prepend / after）
  try {
    var _ac = Element.prototype.appendChild;
    var _ib = Element.prototype.insertBefore;
    var _pr = Element.prototype.prepend;
    var _af = Element.prototype.after;
    function chk(el){
      if(el && el.tagName==='SCRIPT'){
        var s=el.src||el.getAttribute('src')||'';
        if(blockedDomains.some(function(d){return s.indexOf(d)>=0;})) return true;
        el.removeAttribute('integrity');
        el.removeAttribute('crossorigin');
      }
      return false;
    }
    Element.prototype.appendChild  = function(el){ return chk(el)?el:_ac.call(this,el); };
    Element.prototype.insertBefore = function(n,r){ return chk(n)?n:_ib.call(this,n,r); };
    if(_pr) Element.prototype.prepend = function(){ var a=Array.prototype.slice.call(arguments); a.forEach(function(n){ chk(n); }); return _pr.apply(this,a); };
    if(_af) Element.prototype.after  = function(){ var a=Array.prototype.slice.call(arguments); a.forEach(function(n){ chk(n); }); return _af.apply(this,a); };
  } catch(e){}

  // 3. URL 重写工具函数
  //    覆盖所有需要代理的域：*.stripchat.com、*.stripst.com、*.chantrail.com、*.strpst.com
  var PROXY_RE = /https?:\\/\\/(?:[a-z0-9-]+\\.)?(?:stripchat\\.com|stripst\\.com|chantrail\\.com|strpst\\.com)/gi;
  var WS_RE    = /wss?:\\/\\/(?:[a-z0-9-]+\\.)?(?:stripchat\\.com|stripst\\.com|chantrail\\.com|strpst\\.com)/gi;
  function _rw(u){
    if(typeof u!=='string') return u;
    return u.replace(PROXY_RE, O);
  }
  function _rwWS(u){
    if(typeof u!=='string') return u;
    return u.replace(WS_RE, WP+'//'+H);
  }

  // 4. fetch 重写
  try {
    var _f = window.fetch;
    window.fetch = function(input, init) {
      if(typeof input==='string'){
        input = _rw(input);
      } else if(typeof URL!=='undefined' && input instanceof URL){
        var rw=_rw(input.href); if(rw!==input.href) input=new URL(rw);
      } else if(input instanceof Request){
        var rw2=_rw(input.url); if(rw2!==input.url) input=new Request(rw2,input);
      }
      return _f.call(this,input,init);
    };
  } catch(e){}

  // 5. sendBeacon 重写（统计上报跨域）
  try {
    var _sb = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function(url, data){
      return _sb(_rw(url), data);
    };
  } catch(e){}

  // 6. XHR 重写
  try {
    var _o = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(m,u){
      if(typeof u==='string') u=_rw(u);
      return _o.apply(this,[m,u].concat(Array.prototype.slice.call(arguments,2)));
    };
  } catch(e){}

  // 7. WebSocket 重写
  //    用 class extends 而非普通函数 return，保证 instanceof WebSocket 检查通过
  try {
    var _WS = window.WebSocket;
    var ProxyWS = (function(){
      try {
        // 现代环境：class 语法，instanceof 原型链正确
        return new Function('_WS','_rwWS',
          'return class ProxyWS extends _WS {' +
          '  constructor(u,p){' +
          '    if(typeof u==="string") u=_rwWS(u);' +
          '    if(p!==undefined){ super(u,p); } else { super(u); }' +
          '  }' +
          '}'
        )(_WS, _rwWS);
      } catch(e2){
        // 降级：普通构造函数（不支持 class 的旧环境）
        function FallbackWS(u,p){
          if(typeof u==='string') u=_rwWS(u);
          var ws = p!==undefined ? new _WS(u,p) : new _WS(u);
          return ws;
        }
        FallbackWS.prototype = _WS.prototype;
        Object.setPrototypeOf(FallbackWS, _WS);
        return FallbackWS;
      }
    })();
    ProxyWS.CONNECTING = _WS.CONNECTING;
    ProxyWS.OPEN       = _WS.OPEN;
    ProxyWS.CLOSING    = _WS.CLOSING;
    ProxyWS.CLOSED     = _WS.CLOSED;
    window.WebSocket = ProxyWS;
  } catch(e){}
})();
</script>`;
}

// ─── CORS 预检 ──────────────────────────────────────────────────────────────────
function handleCORS() {
	return new Response(null, {
		status: 204,
		headers: {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "*",
			"Access-Control-Allow-Headers": "*",
			"Access-Control-Allow-Credentials": "true",
			"Access-Control-Max-Age": "86400",
		},
	});
}
