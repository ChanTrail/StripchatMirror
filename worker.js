/**
 * Cloudflare Workers 部署入口（worker.js）
 *
 * 本文件是完整独立的 Worker 脚本，不依赖任何相对路径导入，
 * 可直接粘贴到 Cloudflare Dashboard 的 Worker 编辑器，或通过 Wrangler CLI 部署。
 *
 * 路由说明：
 *   /       → 代理 stripchat.com 首页
 *   其他路由 → 照常代理到 stripchat.com
 */

// ─── 目标站点配置 ───────────────────────────────────────────────────────────────
const TARGET_DOMAIN = "stripchat.com";
const TARGET_URL    = `https://${TARGET_DOMAIN}`;

// ─── 需要代理的相关域名 ─────────────────────────────────────────────────────────
// 用正则匹配所有 *.stripchat.com 子域，同时保留固定的 CDN 域名
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

// ─── Worker 入口（ES Module 模式）───────────────────────────────────────────────
export default {
	fetch(request, env, ctx) {
		return handleRequest(request);
	},
};

// ─── 主请求处理函数 ─────────────────────────────────────────────────────────────
async function handleRequest(request) {
	const url = new URL(request.url);

	// 处理 OPTIONS 预检请求
	if (request.method === "OPTIONS") {
		return handleCORS();
	}

	// ── 忽略 CSP 报告 ────────────────────────────────────────────────────────
	if (url.pathname === "/_csp" || url.pathname.includes("csp-report")) {
		return new Response(null, { status: 204 });
	}

	// ── /cdn-cgi/ 路由：CF Bot 挑战回调透传 ──────────────────────────────────
	// 挑战 JS 提交 token 时目标是真实域名，必须直连；只清除 cookie 限制
	if (url.pathname.startsWith("/cdn-cgi/")) {
		return proxyChallenge(request, url);
	}

	// ── WebSocket 升级 ────────────────────────────────────────────────────────
	const upgradeHeader = request.headers.get("Upgrade");
	if (upgradeHeader && upgradeHeader.toLowerCase() === "websocket") {
		const wsUrl = new URL(url.pathname + url.search, TARGET_URL);
		wsUrl.protocol = wsUrl.protocol.replace("http", "ws");
		return fetch(wsUrl.toString(), {
			method: request.method,
			headers: request.headers,
		});
	}

	// ── 普通代理 ─────────────────────────────────────────────────────────────
	try {
		const targetUrl = new URL(url.pathname + url.search + url.hash, TARGET_URL);
		let response = await fetch(buildProxyRequest(request, targetUrl));

		// 跟随 3xx 重定向（限制只跟随指向目标域的跳转）
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("Location");
			if (location) {
				// 拦截到 zh.stripchat.com 的跳转，强制改回 stripchat.com
				// zh 子域有更严格的 Bot 保护，会卡安全验证
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
			headers: { "Content-Type": "text/plain;charset=utf-8", "Access-Control-Allow-Origin": "*" },
		});
	}
}

// ─── CF Bot 挑战透传 ────────────────────────────────────────────────────────────
// 关键：不能 follow 重定向，必须把 302 原样返回给浏览器；
// 挑战 JS 依赖精确的状态码判断通过与否。
async function proxyChallenge(request, url) {
	const targetCdnUrl = new URL(url.pathname + url.search, TARGET_URL);
	const cdnHeaders = new Headers(request.headers);
	cdnHeaders.set("Host", TARGET_DOMAIN);
	["cf-connecting-ip","cf-ipcountry","cf-ray","cf-visitor",
	 "x-forwarded-for","x-forwarded-proto","cf-worker","cdn-loop"].forEach(h => cdnHeaders.delete(h));

	const cdnResp = await fetch(targetCdnUrl.toString(), {
		method: request.method,
		headers: cdnHeaders,
		body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
		redirect: "manual", // ← 必须 manual，不能 follow，保留 302 给浏览器
	});

	const newHeaders = new Headers(cdnResp.headers);
	newHeaders.delete("set-cookie");
	for (const [k, v] of cdnResp.headers.entries()) {
		if (k.toLowerCase() === "set-cookie") {
			// cf_clearance 必须保留 Secure（HTTPS 场景），只清除 Domain 限制
			// SameSite 保持原值或改为 None（挑战是跨站 POST，Lax/Strict 会导致 cookie 不发送）
			let c = v.replace(/;\s*Domain=[^;]+/gi, "");
			// 把 SameSite=Lax / SameSite=Strict 改为 None，确保跨站携带
			if (/SameSite=None/i.test(c)) {
				// 原来就是 None，确保有 Secure
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

	// 强制覆盖为真实浏览器 UA，降低 Bot 检测触发率
	headers.set(
		"User-Agent",
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
	);

	if (!headers.has("Accept")) {
		headers.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8");
	}
	// 强制英文，避免被重定向到 zh.stripchat.com（该子域有更严格的 Bot 保护）
	headers.set("Accept-Language", "en-US,en;q=0.9");
	// 覆盖 CF IP 地理位置判断，防止服务端按 IP 跳转到中文子域
	headers.set("CF-IPCountry", "US");

	// 删除所有 Cloudflare 注入头，避免暴露代理身份
	["cf-connecting-ip","cf-ipcountry","cf-ray","cf-visitor",
	 "x-forwarded-for","x-forwarded-proto","x-real-ip","cf-worker","cdn-loop"]
		.forEach(h => headers.delete(h));

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

	// 处理 Set-Cookie（清除 Domain；cf_clearance 等保留 Secure+SameSite=None）
	for (const [key, value] of response.headers.entries()) {
		if (key.toLowerCase() === "set-cookie") {
			let c = value.replace(/;\s*Domain=[^;]+/gi, "");
			const isCfClearance = /^cf_clearance=/i.test(c.trim());
			if (isCfClearance) {
				// cf_clearance 必须 SameSite=None + Secure，否则跨站携带失败
				c = c.replace(/;\s*SameSite=[^;]+/gi, "");
				c += "; SameSite=None; Secure";
			} else {
				// 其他 cookie 去掉 Secure，改为 SameSite=Lax，方便 HTTP 测试
				c = c.replace(/;\s*Secure\b/gi, "")
				     .replace(/;\s*SameSite=[^;]+/gi, "");
				c += "; SameSite=Lax";
			}
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

			// URL 重写：固定域名列表
			for (const domain of PROXY_DOMAINS) {
				const esc = domain.replace(/\./g, "\\.");
				text = text.replace(new RegExp(`https?://${esc}`, "gi"), proxyUrl.origin);
				text = text.replace(new RegExp(`//${esc}`, "gi"), `//${proxyUrl.host}`);
			}

			// URL 重写：*.stripchat.com 所有子域（捕获挑战脚本里硬编码的 zh.stripchat.com 等）
			text = text.replace(
				/https?:\/\/([a-z0-9-]+\.stripchat\.com)/gi,
				proxyUrl.origin,
			);
			text = text.replace(
				/\/\/([a-z0-9-]+\.stripchat\.com)/gi,
				`//${proxyUrl.host}`,
			);

			// WebSocket URL 重写（所有 *.stripchat.com 子域）
			text = text.replace(/wss?:\/\/([a-z0-9-]+\.stripchat\.com)/gi, (match) => {
				const wsProto = proxyUrl.protocol === "https:" ? "wss:" : "ws:";
				return `${wsProto}//${proxyUrl.host}`;
			});
			// WebSocket URL 重写（固定列表）
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
				// 移除 CSP meta 标签
				text = text.replace(/<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/gi, "");

				// 屏蔽 Cloudflare Insights / beacon
				text = text.replace(/<script[^>]*cloudflareinsights\.com[^>]*>[\s\S]*?<\/script>/gi, "<!-- CF blocked -->");
				text = text.replace(/<script[^>]*cloudflareinsights\.com[^>]*\/>/gi, "<!-- CF blocked -->");
				text = text.replace(/<script([^>]*)src=(["'])[^"']*cloudflareinsights\.com[^"']*\2([^>]*)>[\s\S]*?<\/script>/gi, "<!-- CF blocked -->");
				text = text.replace(/<script[^>]*beacon\.min\.js[^>]*>[\s\S]*?<\/script>/gi, "<!-- Beacon blocked -->");

				// 移除 integrity / crossorigin 属性
				text = text.replace(/<script([^>]*)\s+integrity=(["'])[^"']*\2([^>]*)>/gi, "<script$1$3>");
				text = text.replace(/<script([^>]*)\s+crossorigin=(["'])[^"']*\2([^>]*)>/gi, "<script$1$3>");
				text = text.replace(/<link([^>]*)\s+integrity=(["'])[^"']*\2([^>]*)>/gi, "<link$1$3>");
				text = text.replace(/<link([^>]*)\s+crossorigin=(["'])[^"']*\2([^>]*)>/gi, "<link$1$3>");

				// 注入修复脚本
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

  // 1. Cookie 修复
  try {
    var desc = Object.getOwnPropertyDescriptor(Document.prototype,'cookie') ||
               Object.getOwnPropertyDescriptor(HTMLDocument.prototype,'cookie');
    if (desc && desc.configurable) {
      Object.defineProperty(document,'cookie',{
        get: function(){ return desc.get.call(document); },
        set: function(v){
          v = v.replace(/;\\s*[Dd]omain=[^;]+/g,'');
          if(location.protocol!=='https:') v=v.replace(/;\\s*[Ss]ecure/g,'');
          v = v.replace(/;\\s*[Ss]ameSite=None/g,'');
          return desc.set.call(document,v);
        },
        configurable:true
      });
    }
  } catch(e){}

  // 2. 脚本注入拦截
  try {
    var _ac = Element.prototype.appendChild;
    var _ib = Element.prototype.insertBefore;
    function chk(el){
      if(el && el.tagName==='SCRIPT'){
        var s=el.src||el.getAttribute('src')||'';
        if(blockedDomains.some(function(d){return s.indexOf(d)>=0;})) return true;
        el.removeAttribute('integrity');
        el.removeAttribute('crossorigin');
      }
      return false;
    }
    Element.prototype.appendChild=function(el){ return chk(el)?el:_ac.call(this,el); };
    Element.prototype.insertBefore=function(n,r){ return chk(n)?n:_ib.call(this,n,r); };
  } catch(e){}

  // 3. fetch 重写（含 /cdn-cgi/ 挑战回调）
  try {
    var _f = window.fetch;
    function _rw(u){ return typeof u==='string'?u.replace(/https?:\\/\\/[a-z0-9-]+\\.stripchat\\.com/gi,O):u; }
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

  // 4. XHR 重写
  try {
    var _o = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(m,u){
      if(typeof u==='string') u=u.replace(/https?:\\/\\/[a-z0-9-]+\\.stripchat\\.com/gi,O);
      return _o.apply(this,[m,u].concat(Array.prototype.slice.call(arguments,2)));
    };
  } catch(e){}

  // 5. WebSocket 重写（正确继承原型，保证 instanceof 检查通过）
  try {
    var _WS = window.WebSocket;
    function ProxyWS(u,p){
      if(typeof u==='string') u=u.replace(/wss?:\\/\\/[a-z0-9-]+\\.stripchat\\.com/gi,WP+'//'+H);
      return p!==undefined ? new _WS(u,p) : new _WS(u);
    }
    ProxyWS.prototype = _WS.prototype;
    ProxyWS.CONNECTING=_WS.CONNECTING; ProxyWS.OPEN=_WS.OPEN;
    ProxyWS.CLOSING=_WS.CLOSING; ProxyWS.CLOSED=_WS.CLOSED;
    try{ Object.setPrototypeOf(ProxyWS,_WS); }catch(e2){}
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
