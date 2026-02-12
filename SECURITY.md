# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in AgentFactory, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, please email **security@supaku.com** with:

- A description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested fixes (optional)

We will acknowledge your report within 48 hours and aim to provide a fix or mitigation plan within 7 days.

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 0.6.x   | Yes                |
| < 0.6   | No                 |

## Security Best Practices

When using AgentFactory, we recommend:

- **Never commit `.env` files** — use `.env.local` and ensure it's in `.gitignore`
- **Rotate API keys regularly** — Linear API keys, worker API keys, and webhook secrets
- **Use webhook signature verification** — set `LINEAR_WEBHOOK_SECRET` to validate incoming webhooks
- **Restrict worker API keys** — use unique `WORKER_API_KEY` values per deployment
- **Set `SESSION_HASH_SALT`** — use a random 32+ character string for session hashing
