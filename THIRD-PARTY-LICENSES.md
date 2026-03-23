# Third-Party License Review

This document tracks dependency licenses that fall outside the standard OSS
allowlist (`MIT`, `Apache-2.0`, `BSD-*`, `ISC`, etc.) and require manual review.

## @anthropic-ai/claude-agent-sdk

| Field | Value |
|---|---|
| **Package** | `@anthropic-ai/claude-agent-sdk` |
| **Version** | `^0.2.7` (resolved 0.2.37 at time of review) |
| **License field** | `SEE LICENSE IN README.md` |
| **Actual license** | Proprietary — "All rights reserved" |
| **License text** | `LICENSE.md`: *"© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance."* |
| **Governing terms** | [Anthropic Commercial Terms](https://www.anthropic.com/legal/commercial-terms) (API/Team/Enterprise) or [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) (Free/Pro/Max) |
| **Used by** | `@renseiai/agentfactory` (core), `@renseiai/plugin-linear` |
| **CI status** | Excluded from automated license-checker via `--excludePackages` flag |
| **Review status** | PENDING HUMAN REVIEW |

### Key findings

1. **Not OSS.** The SDK is published on npm but is *not* released under an open-source
   license. The `LICENSE.md` is a one-line copyright notice pointing to Anthropic's
   legal agreements.

2. **Usage is permitted.** The Commercial Terms (Section A.1) grant permission to
   "use the Services to power products and services Customer makes available to its
   own customers and end users." AgentFactory's use of the SDK to orchestrate agents
   falls within this grant.

3. **Redistribution is unclear.** The Commercial Terms do not explicitly grant
   redistribution rights. Publishing `@renseiai/agentfactory` on npm causes the
   Anthropic SDK to be installed as a transitive dependency — this is standard npm
   behavior, not direct redistribution of Anthropic's code. However, a human should
   confirm this interpretation.

4. **Authentication restriction.** OAuth tokens from Free/Pro/Max plans may **not** be
   used with the Agent SDK. Only API key authentication is permitted for developers
   building products. This is documented at
   https://code.claude.com/docs/en/legal-and-compliance.

### Action required

A human must review the Anthropic SDK license terms and confirm:
- [ ] Listing `@anthropic-ai/claude-agent-sdk` as a production dependency in a published npm package is permitted
- [ ] No additional attribution or notice is required beyond what is documented here
- [ ] Contact Anthropic sales if explicit redistribution approval is needed

Tracked in Linear: see blocker issue linked from SUP-1214.
