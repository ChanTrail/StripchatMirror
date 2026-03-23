# Cloudflare Worker 镜像访问 Stripchat

## 📝 功能特性

- ✅ 反向代理 Stripchat 网站
- ✅ 自动处理 CORS 跨域问题
- ✅ URL 重写和资源路径转换
- ✅ 移除安全策略头，确保内容正常显示
- ✅ 支持所有资源类型（HTML/CSS/JS/图片/视频等）
- ✅ 自动处理重定向

## 🚀 部署步骤

1. 登录 Cloudflare 控制台
2. 进入 Workers & Pages
3. 新建 Worker
4. 复制本项目的 worker.js 代码到 Worker后保存
5. 添加自定义域名（需要域名已托管在 Cloudflare）
6. 访问你的 Worker 域名

## 🎯 使用方法

部署完成后，访问你的 Worker 域名即可：

```
https://your-worker.your-subdomain.workers.dev
```

或使用自定义域名：

```
https://your-custom-domain.com
```

## ⚙️ 高级配置

### 启用缓存（可选）

如需缓存静态资源，可以在代码中添加 Cache API：

```javascript
const cache = caches.default;
let response = await cache.match(request);
if (!response) {
	response = await fetch(modifiedRequest);
	await cache.put(request, response.clone());
}
```

### 限制访问来源

修改 `ALLOWED_ORIGINS` 数组：

```javascript
const ALLOWED_ORIGINS = ["https://your-domain.com"];
```

## 📊 性能优化建议

1. **启用 Cloudflare CDN**：使用自定义域名并开启 CDN
2. **配置缓存规则**：在 Cloudflare 控制台设置页面规则
3. **使用 KV 存储**：缓存频繁访问的数据
4. **启用 Argo Smart Routing**：进一步优化路由

## ⚠️ 注意事项

1. **合规性**：请确保使用符合当地法律法规
2. **流量限制**：Cloudflare Worker 免费版有请求次数限制
3. **内容政策**：遵守 Cloudflare 的使用条款
4. **隐私保护**：不记录用户敏感信息

## 🔧 故障排查

### Worker 无法访问

- 检查 Worker 是否部署成功
- 确认域名解析正确
- 查看 Cloudflare 控制台的实时日志

### 页面显示异常

- 检查浏览器控制台的错误信息
- 确认 CORS 头设置正确
- 验证 URL 重写规则

### 资源加载失败

- 检查 Content-Type 是否正确
- 确认资源路径重写规则
- 查看网络请求的响应头

## 📞 技术支持

如有问题，请检查：

1. Cloudflare Worker 文档：https://developers.cloudflare.com/workers/
