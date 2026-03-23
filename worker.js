/**
 * Cloudflare Worker 镜像访问 Stripchat
 */

// 目标站点配置
const TARGET_DOMAIN = "stripchat.com";
const TARGET_URL = `https://${TARGET_DOMAIN}`;

// 需要代理的相关域名（CDN、API等）
const PROXY_DOMAINS = [
	"stripchat.com",
	"www.stripchat.com",
	"b-eu-ams.stripst.com",
	"b-eu.stripst.com",
	"img.strpst.com",
	"static.stripst.com",
	"websocket-sp-v6.stripchat.com",
	"websocket-sp-v6.st.chantrail.com",
];

// 主事件监听器
addEventListener("fetch", (event) => {
	event.respondWith(handleRequest(event.request));
});

/**
 * 主请求处理函数
 */
async function handleRequest(request) {
	const url = new URL(request.url);

	// 处理 OPTIONS 预检请求
	if (request.method === "OPTIONS") {
		return handleCORS();
	}

	// 忽略 CSP 报告请求（/_csp 端点）
	if (url.pathname === "/_csp" || url.pathname.includes("csp-report")) {
		return new Response(null, { status: 204 });
	}

	// 处理 WebSocket 升级请求
	const upgradeHeader = request.headers.get("Upgrade");
	if (upgradeHeader && upgradeHeader.toLowerCase() === "websocket") {
		// WebSocket 请求需要直接转发，不能修改
		const wsUrl = new URL(url.pathname + url.search, TARGET_URL);
		wsUrl.protocol = wsUrl.protocol.replace("http", "ws");

		return fetch(wsUrl.toString(), {
			method: request.method,
			headers: request.headers,
		});
	}

	try {
		// 构建目标 URL
		const targetUrl = new URL(url.pathname + url.search + url.hash, TARGET_URL);

		// 构建代理请求
		const proxyRequest = buildProxyRequest(request, targetUrl);

		// 发送请求并获取响应
		let response = await fetch(proxyRequest);

		// 处理 3xx 重定向 - 自动跟随而不是返回重定向响应
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("Location");
			if (location) {
				// 如果是相对路径或目标域名，继续代理
				if (
					location.startsWith("/") ||
					PROXY_DOMAINS.some((domain) => location.includes(domain))
				) {
					const redirectUrl = location.startsWith("/")
						? new URL(location, TARGET_URL)
						: new URL(location);
					const redirectRequest = buildProxyRequest(request, redirectUrl);
					response = await fetch(redirectRequest);
				}
			}
		}

		// 处理响应内容
		return await processResponse(response, url, request);
	} catch (error) {
		console.error("Proxy error:", error);
		return new Response(
			`代理错误: ${error.message}\n\n请检查目标网站是否可访问`,
			{
				status: 502,
				headers: {
					"Content-Type": "text/plain; charset=utf-8",
					"Access-Control-Allow-Origin": "*",
				},
			},
		);
	}
}

/**
 * 构建代理请求
 */
function buildProxyRequest(originalRequest, targetUrl) {
	const headers = new Headers(originalRequest.headers);

	// 设置正确的 Host
	headers.set("Host", targetUrl.hostname);

	// 设置 Referer 和 Origin
	headers.set("Referer", TARGET_URL + "/");
	if (headers.has("Origin")) {
		headers.set("Origin", TARGET_URL);
	}

	// 保留用户代理
	if (!headers.has("User-Agent")) {
		headers.set(
			"User-Agent",
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
		);
	}

	// 保留 Accept 头
	if (!headers.has("Accept")) {
		headers.set("Accept", "*/*");
	}

	// 删除 Cloudflare 特定头
	headers.delete("cf-connecting-ip");
	headers.delete("cf-ipcountry");
	headers.delete("cf-ray");
	headers.delete("cf-visitor");
	headers.delete("x-forwarded-for");
	headers.delete("x-forwarded-proto");
	headers.delete("x-real-ip");

	// 构建请求配置
	const requestInit = {
		method: originalRequest.method,
		headers: headers,
		redirect: "follow", // 自动跟随重定向
	};

	// 添加请求体（如果需要）
	if (
		originalRequest.method !== "GET" &&
		originalRequest.method !== "HEAD" &&
		originalRequest.body
	) {
		requestInit.body = originalRequest.body;
	}

	return new Request(targetUrl.toString(), requestInit);
}

/**
 * 处理响应
 */
async function processResponse(response, proxyUrl, originalRequest) {
	// 克隆响应以便多次读取
	const responseClone = response.clone();
	const contentType = response.headers.get("Content-Type") || "";

	// 构建新的响应头 - 重新创建而不是克隆，这样更彻底
	const newHeaders = new Headers();

	// 复制原始响应头，但排除安全限制头
	const securityHeaders = [
		"content-security-policy",
		"content-security-policy-report-only",
		"x-frame-options",
		"x-content-type-options",
		"strict-transport-security",
		"x-xss-protection",
		"referrer-policy",
	];

	for (const [key, value] of response.headers.entries()) {
		const lowerKey = key.toLowerCase();
		if (!securityHeaders.includes(lowerKey) && lowerKey !== "set-cookie") {
			newHeaders.set(key, value);
		}
	}

	// 添加 CORS 头
	newHeaders.set("Access-Control-Allow-Origin", "*");
	newHeaders.set("Access-Control-Allow-Credentials", "true");
	newHeaders.set("Access-Control-Allow-Methods", "*");
	newHeaders.set("Access-Control-Allow-Headers", "*");
	newHeaders.set("Access-Control-Expose-Headers", "*");

	// 处理 Set-Cookie - 获取所有 Set-Cookie 头
	const setCookies = [];
	for (const [key, value] of response.headers.entries()) {
		if (key.toLowerCase() === "set-cookie") {
			// 完全清理 Cookie 属性，只保留名称和值
			let cookie = value;

			// 移除域名限制
			cookie = cookie.replace(/;\s*Domain=[^;]+/gi, "");
			cookie = cookie.replace(/;\s*domain=[^;]+/gi, "");

			// 移除安全限制
			cookie = cookie.replace(/;\s*Secure/gi, "");
			cookie = cookie.replace(/;\s*secure/gi, "");

			// 移除 SameSite 限制
			cookie = cookie.replace(/;\s*SameSite=[^;]+/gi, "");
			cookie = cookie.replace(/;\s*samesite=[^;]+/gi, "");

			// 添加宽松的 SameSite 设置
			cookie += "; SameSite=Lax";

			// 确保有 Path
			if (!cookie.toLowerCase().includes("path=")) {
				cookie += "; Path=/";
			}

			// 设置到当前 Worker 域名
			newHeaders.append("Set-Cookie", cookie);
		}
	}

	// 处理文本内容（HTML/CSS/JS/JSON）
	if (
		contentType.includes("text/html") ||
		contentType.includes("text/css") ||
		contentType.includes("application/javascript") ||
		contentType.includes("text/javascript") ||
		contentType.includes("application/json") ||
		contentType.includes("application/x-javascript")
	) {
		try {
			let text = await responseClone.text();

			// URL 重写 - 替换所有相关域名
			PROXY_DOMAINS.forEach((domain) => {
				// 替换 https:// 和 http:// 协议的URL
				text = text.replace(
					new RegExp(`https?://${domain.replace(/\./g, "\\.")}`, "gi"),
					proxyUrl.origin,
				);
				// 替换 // 开头的URL
				text = text.replace(
					new RegExp(`//${domain.replace(/\./g, "\\.")}`, "gi"),
					`//${proxyUrl.host}`,
				);
			});

			// 特殊处理：修复可能的 WebSocket 连接
			text = text.replace(/wss?:\/\/[^"'\s]+/gi, (match) => {
				PROXY_DOMAINS.forEach((domain) => {
					if (match.includes(domain)) {
						const wsProtocol = proxyUrl.protocol === "https:" ? "wss:" : "ws:";
						match = match
							.replace(/wss?:/, wsProtocol)
							.replace(domain, proxyUrl.host);
					}
				});
				return match;
			});

			// 如果是 HTML，注入自定义脚本来处理 CSP 问题
			if (contentType.includes("text/html")) {
				// 移除 CSP meta 标签
				text = text.replace(
					/<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/gi,
					"",
				);

				// 多种方式移除 Cloudflare Insights 脚本
				// 方式1：带完整标签的脚本
				text = text.replace(
					/<script[^>]*cloudflareinsights\.com[^>]*>[\s\S]*?<\/script>/gi,
					"<!-- CF Insights blocked -->",
				);
				// 方式2：自闭合标签
				text = text.replace(
					/<script[^>]*cloudflareinsights\.com[^>]*\/>/gi,
					"<!-- CF Insights blocked -->",
				);
				// 方式3：src 属性中包含的
				text = text.replace(
					/<script([^>]*)src=(["'])[^"']*cloudflareinsights\.com[^"']*\2([^>]*)>[\s\S]*?<\/script>/gi,
					"<!-- CF Insights blocked -->",
				);
				// 方式4：移除所有对 beacon.min.js 的引用
				text = text.replace(
					/<script[^>]*beacon\.min\.js[^>]*>[\s\S]*?<\/script>/gi,
					"<!-- Beacon blocked -->",
				);

				// 移除所有 script 标签的 integrity 和 crossorigin 属性
				text = text.replace(
					/<script([^>]*)\s+integrity=(["'])[^"']*\2([^>]*)>/gi,
					"<script$1$3>",
				);
				text = text.replace(
					/<script([^>]*)\s+crossorigin=(["'])[^"']*\2([^>]*)>/gi,
					"<script$1$3>",
				);
				text = text.replace(
					/<link([^>]*)\s+integrity=(["'])[^"']*\2([^>]*)>/gi,
					"<link$1$3>",
				);
				text = text.replace(
					/<link([^>]*)\s+crossorigin=(["'])[^"']*\2([^>]*)>/gi,
					"<link$1$3>",
				);

				// 注入超强修复脚本
				const cookieScript = `
<script>
// 全能代理修复脚本
(function() {
	const currentHost = location.host;
	const currentOrigin = location.origin;
	const blockedDomains = ['cloudflareinsights.com', 'googletagmanager.com', 'beacon.min.js'];
	
	console.log('[Proxy] 🛡️ Initializing protection...');
	
	// 1. Cookie 自动修复
	try {
		const originalCookieDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie') || 
		                           Object.getOwnPropertyDescriptor(HTMLDocument.prototype, 'cookie');
		
		if (originalCookieDesc && originalCookieDesc.configurable) {
			Object.defineProperty(document, 'cookie', {
				get: function() { return originalCookieDesc.get.call(document); },
				set: function(val) {
					val = val.replace(/;\\s*[Dd]omain=[^;]+/g, '');
					if (location.protocol !== 'https:') val = val.replace(/;\\s*[Ss]ecure/g, '');
					val = val.replace(/;\\s*[Ss]ameSite=None/g, '');
					return originalCookieDesc.set.call(document, val);
				},
				configurable: true
			});
			console.log('[Proxy] ✓ Cookie handler');
		}
	} catch(e) { console.error('[Proxy] Cookie failed:', e); }
	
	// 2. 拦截脚本注入 - 在 appendChild 层面拦截
	try {
		const originalAppendChild = Element.prototype.appendChild;
		const originalInsertBefore = Element.prototype.insertBefore;
		
		function shouldBlock(element) {
			if (element && element.tagName === 'SCRIPT') {
				const src = element.src || element.getAttribute('src') || '';
				if (blockedDomains.some(d => src.includes(d))) {
					console.log('[Proxy] ✗ Blocked:', src.substring(0, 60));
					return true;
				}
				// 移除 integrity 和 crossorigin
				if (element.hasAttribute('integrity')) {
					element.removeAttribute('integrity');
					console.log('[Proxy] ✗ Removed integrity');
				}
				if (element.hasAttribute('crossorigin')) {
					element.removeAttribute('crossorigin');
				}
			}
			return false;
		}
		
		Element.prototype.appendChild = function(element) {
			if (shouldBlock(element)) return element;
			return originalAppendChild.call(this, element);
		};
		
		Element.prototype.insertBefore = function(newNode, referenceNode) {
			if (shouldBlock(newNode)) return newNode;
			return originalInsertBefore.call(this, newNode, referenceNode);
		};
		
		console.log('[Proxy] ✓ Script blocker');
	} catch(e) { console.error('[Proxy] Script blocker failed:', e); }
	
	// 3. WebSocket URL 重写
	try {
		const OriginalWebSocket = window.WebSocket;
		window.WebSocket = function(url, protocols) {
			if (typeof url === 'string') {
				const originalUrl = url;
				url = url.replace(/wss?:\\/\\/[^/]*stripchat\\.com/g, 
				                  currentOrigin.replace('https:', 'wss:').replace('http:', 'ws:'));
				if (url !== originalUrl) {
					console.log('[Proxy] ✓ WebSocket:', url.split('/')[2]);
				}
			}
			return new OriginalWebSocket(url, protocols);
		};
		window.WebSocket.prototype = OriginalWebSocket.prototype;
		console.log('[Proxy] ✓ WebSocket handler');
	} catch(e) { console.error('[Proxy] WebSocket failed:', e); }
	
	console.log('[Proxy] ✨ Protection active!');
})();
</script>`;

				// 在 head 中注入脚本
				text = text.replace(
					"</head>",
					`${cookieScript}
<meta http-equiv="Content-Security-Policy" content="upgrade-insecure-requests">
</head>`,
				);
			}

			return new Response(text, {
				status: response.status,
				statusText: response.statusText,
				headers: newHeaders,
			});
		} catch (error) {
			console.error("Text processing error:", error);
			// 如果处理失败，返回原始响应
		}
	}

	// 对于二进制内容（图片、视频、字体等），直接返回
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: newHeaders,
	});
}

/**
 * 处理 CORS 预检请求
 */
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
