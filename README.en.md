# StripchatMirror

[简体中文](README.md) | [English](README.en.md)

A Cloudflare Workers reverse-proxy example that forwards requests to stripchat.com and related domains through a single entry point, with response rewriting. This repository keeps only the core proxy capability, without an admin dashboard, load balancing, or other extras.

---

## Table of Contents

- [Overview](#overview)
- [Key Capabilities](#key-capabilities)
- [Architecture and Request Flow](#architecture-and-request-flow)
- [Repository Structure](#repository-structure)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Operations Recommendations](#operations-recommendations)
- [Troubleshooting](#troubleshooting)
- [Security and Compliance](#security-and-compliance)
- [Contributing](#contributing)
- [License](#license)
- [Disclaimer](#disclaimer)

---

## Overview

This Worker implements a controlled-target reverse proxy. The primary goals are:

1. Proxy page and static asset requests.
2. Handle cross-origin access and preflight requests (CORS).
3. Rewrite domain/protocol-related URLs in text responses.
4. Remove selected security headers to improve compatibility in proxy scenarios.
5. Handle WebSocket upgrades and common redirect paths.

Out of scope in the current implementation:

1. Full production-grade authentication and access control.
2. Enterprise-level auditing and observability.
3. Multi-environment setup (dev/stage/prod) and CI/CD workflows.

---

## Key Capabilities

- Reverse proxy for target site and related resource domains.
- Automatic handling of OPTIONS preflight requests.
- Auto-follow and secondary handling for selected 3xx redirects.
- Text response rewriting for HTML/CSS/JS/JSON.
- Binary passthrough for images, videos, fonts, and similar assets.
- WebSocket upgrade forwarding to upstream.
- Set-Cookie normalization to improve proxy compatibility.

---

## Architecture and Request Flow

High-level flow:

1. Client request reaches Cloudflare Worker.
2. Worker routes by path and headers:
   - OPTIONS: return CORS preflight response directly.
   - /\_csp or csp-report: return 204.
   - /cdn-cgi/\*: passthrough to the target site for Cloudflare Bot challenge callbacks (redirects are not followed; original status code and Set-Cookie are preserved).
   - Upgrade: websocket: route to WebSocket forwarding.
   - Other requests: route to HTTP proxy pipeline.
3. Worker builds upstream request and executes fetch.
4. Worker performs unified response processing:
   - Filter selected security headers.
   - Inject CORS headers.
   - Normalize Set-Cookie.
   - Rewrite domain/protocol references in text content.
5. Return processed response to client.

---

## Repository Structure

```text
.
├── LICENSE
├── README.md
├── README.en.md
└── worker.js
```

---

## Quick Start

### Prerequisites

1. A Cloudflare account.
2. Access to Cloudflare Workers.
3. (Optional) A custom domain managed by Cloudflare.

### Option 1: Dashboard Deployment

1. Sign in to Cloudflare dashboard.
2. Open Workers & Pages.
3. Create a new Worker.
4. Replace default code with the repository worker.js and save.
5. Click Deploy.
6. Access via workers.dev subdomain or bound custom domain.

### Option 2: Wrangler CLI Deployment

```bash
npm install -g wrangler
wrangler login
```

Create wrangler.toml (example):

```toml
name = "stripchat-mirror"
main = "worker.js"
compatibility_date = "2026-04-06"
```

Deploy:

```bash
wrangler deploy
```

Local debugging (remote runtime):

```bash
wrangler dev --remote
```

---

## Configuration

Primary configuration is defined by top-level constants in worker.js:

- TARGET_DOMAIN: main target domain.
- TARGET_URL: main target URL.
- PROXY_DOMAINS: related domains to rewrite in text responses.

Recommended rules for maintaining PROXY_DOMAINS:

1. Include all observed resource, API, and WebSocket domains.
2. Run end-to-end verification after adding domains (homepage, assets, realtime).
3. Avoid over-broad matching to reduce accidental rewrites.

---

## Operations Recommendations

1. Enable Worker logging and alerts in Cloudflare.
2. Configure rate limiting according to traffic profile.
3. Add cache policy for static assets (Cache API and/or platform rules).
4. Add access controls for public instances (IP allowlist, token, or gateway).
5. Periodically validate upstream domain/script policy changes.

---

## Troubleshooting

| Symptom                         | Likely Cause                                        | Suggested Check                                                       |
| ------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------- |
| Page loads but some assets fail | Missing resource domain coverage                    | Inspect failed domains in network panel and add them to PROXY_DOMAINS |
| Realtime features fail          | WebSocket target not forwarded correctly            | Verify Upgrade request and ws/wss upstream target                     |
| Session/login state unstable    | Cookie attributes incompatible with proxy domain    | Check rewritten Set-Cookie headers                                    |
| Script errors on page           | Upstream script policy change or incomplete rewrite | Compare upstream raw response and update rewrite rules                |
| 403/429 responses               | Upstream risk-control triggered by request pattern  | Reduce request rate and inspect headers/source policy                 |

---

## Security and Compliance

1. Ensure your use case complies with local laws and platform terms.
2. This project does not provide built-in anonymity, privacy compliance, or audit controls.
3. Do not expose an open proxy instance directly to the public internet.
4. For production use, add auth, rate limiting, log redaction, and monitoring.

---

## Contributing

Contributions via Issues and Pull Requests are welcome.

Suggested workflow:

1. Fork the repository and create a feature branch.
2. Implement changes and verify locally.
3. Provide clear change description and reproduction steps.
4. Open a Pull Request.

Recommended PR content:

- Motivation and impact scope.
- Key logic notes.
- Compatibility and rollback approach (if applicable).

---

## License

This project is licensed under the [GNU General Public License v3.0](https://www.gnu.org/licenses/old-licenses/gpl-3.0.html).

---

## Disclaimer

This project is intended for technical research and learning only. Users are responsible for deployment, operations, and compliance risks.
