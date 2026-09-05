/**
 * Vercel Edge Function 部署入口（functions/proxy.js）
 *
 * 基于 worker.js 逻辑适配，运行在 Vercel Edge Runtime（V8 isolate）。
 * 放在 functions/ 目录而非 api/ 目录，避免 Vercel 将 /api/* 路径识别为
 * 保留路由导致上游 /api/ 请求无法被正确代理。
 *
 * 与 Cloudflare Workers 的主要差异：
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
		"x-forwarded-for", "x-forwarded-proto", "x-real-ip", "cf-worker", "cdn-loop",
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

	for (const [key, value] of response.headers.entries()) {
		if (key.toLowerCase() === "set-cookie") {
			let c = value.replace(/;\s*Domain=[^;]+/gi, "");
			const isCfClearance = /^cf_clearance=/i.test(c.trim());
			if (isCfClearance) {
				c = c.replace(/;\s*SameSite=[^;]+/gi, "");
				c += "; SameSite=None; Secure";
			} else {
				c = c.replace(/;\s*Secure\b/gi, "").replace(/;\s*SameSite=[^;]+/gi, "");
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

  try {
    var _o = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(m,u){
      if(typeof u==='string') u=u.replace(/https?:\\/\\/[a-z0-9-]+\\.stripchat\\.com/gi,O);
      return _o.apply(this,[m,u].concat(Array.prototype.slice.call(arguments,2)));
    };
  } catch(e){}

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
