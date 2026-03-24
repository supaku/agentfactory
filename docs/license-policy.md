# FOSSA License Policy for AgentFactory

This document defines the license policy rules that govern dependency usage in
the AgentFactory monorepo. The policy is enforced via [FOSSA](https://fossa.com/)
and is configured in the FOSSA dashboard. This file serves as the
version-controlled source of truth for the policy so that changes can be
reviewed via pull request before being applied in the dashboard.

> **Note:** FOSSA policy rules are configured through the FOSSA web UI, not
> through code. This document records the intended configuration so it can be
> tracked in version control. See [Dashboard Setup](#dashboard-setup-steps) for
> instructions on applying these rules.

---

## Allowed Licenses

The following licenses are pre-approved for use in production dependencies.
They correspond to the entries in the repository's
[`.license-allowlist`](../.license-allowlist) file, which is consumed by the
local `license-checker` CI step.

| SPDX Identifier | License Name | Category |
|---|---|---|
| `MIT` | MIT License | Permissive |
| `Apache-2.0` | Apache License 2.0 | Permissive |
| `BSD-2-Clause` | BSD 2-Clause "Simplified" License | Permissive |
| `BSD-3-Clause` | BSD 3-Clause "New" or "Revised" License | Permissive |
| `ISC` | ISC License | Permissive |
| `0BSD` | BSD Zero Clause License | Permissive |
| `CC0-1.0` | Creative Commons Zero v1.0 Universal | Public Domain |
| `CC-BY-3.0` | Creative Commons Attribution 3.0 | Permissive |
| `CC-BY-4.0` | Creative Commons Attribution 4.0 | Permissive |
| `Unlicense` | The Unlicense | Public Domain |
| `BlueOak-1.0.0` | Blue Oak Model License 1.0 | Permissive |
| `Python-2.0` | Python Software Foundation License 2.0 | Permissive |

All of these licenses allow free use, modification, and redistribution with
minimal obligations (typically attribution only). They are compatible with
proprietary and commercial use.

---

## Denied Licenses

The following licenses are **denied** by policy. Any dependency detected under
one of these licenses will cause a FOSSA policy failure and must be removed or
replaced before merging.

### Copyleft / Strong Copyleft (GPL family)

| SPDX Identifier | License Name | Reason for Denial |
|---|---|---|
| `GPL-2.0-only` | GNU General Public License v2.0 only | Strong copyleft; requires derivative works to be distributed under the same license. Incompatible with proprietary distribution. |
| `GPL-2.0-or-later` | GNU General Public License v2.0 or later | Same as GPL-2.0-only, with option to use later GPL versions. |
| `GPL-3.0-only` | GNU General Public License v3.0 only | Strong copyleft with additional patent and anti-tivoization clauses. |
| `GPL-3.0-or-later` | GNU General Public License v3.0 or later | Same as GPL-3.0-only, with option to use later GPL versions. |

### Network Copyleft (AGPL family)

| SPDX Identifier | License Name | Reason for Denial |
|---|---|---|
| `AGPL-1.0-only` | Affero General Public License v1.0 | Network copyleft; requires source disclosure even for server-side use. |
| `AGPL-3.0-only` | GNU Affero General Public License v3.0 only | Network copyleft; strongest copyleft obligation. Requires source disclosure for any network interaction. |
| `AGPL-3.0-or-later` | GNU Affero General Public License v3.0 or later | Same as AGPL-3.0-only, with option to use later AGPL versions. |

### Server-Side / Source-Available

| SPDX Identifier | License Name | Reason for Denial |
|---|---|---|
| `SSPL-1.0` | Server Side Public License v1 | Requires anyone offering the software as a service to release the entire service stack under SSPL. Effectively non-open-source per OSI. |

### European Union Public License

| SPDX Identifier | License Name | Reason for Denial |
|---|---|---|
| `EUPL-1.1` | European Union Public License 1.1 | Copyleft license with complex multi-jurisdiction compatibility clauses. Risk of unintended copyleft obligations. |
| `EUPL-1.2` | European Union Public License 1.2 | Updated EUPL with same copyleft characteristics. |

### Non-Commercial Creative Commons

| SPDX Identifier | License Name | Reason for Denial |
|---|---|---|
| `CC-BY-NC-4.0` | Creative Commons Attribution-NonCommercial 4.0 | Non-commercial restriction is incompatible with any commercial use of AgentFactory. |
| `CC-BY-NC-SA-4.0` | Creative Commons Attribution-NonCommercial-ShareAlike 4.0 | Combines non-commercial restriction with copyleft (ShareAlike). Incompatible with commercial use. |

---

## Exceptions / Pre-Approved Packages

Some dependencies use licenses that are neither on the allowed list nor on the
denied list (e.g., proprietary licenses from trusted vendors). These are
reviewed and approved on a case-by-case basis.

| Package | License | Status | Reference |
|---|---|---|---|
| `@anthropic-ai/claude-agent-sdk` | Proprietary (All rights reserved) | **APPROVED** | Reviewed 2026-03-23 per [SUP-1227]. See [`THIRD-PARTY-LICENSES.md`](../THIRD-PARTY-LICENSES.md) for full review. |

To add a new exception:

1. Open a Linear issue documenting the package, its license, and the business
   justification for using it.
2. Obtain written approval from the engineering lead.
3. Add the review record to [`THIRD-PARTY-LICENSES.md`](../THIRD-PARTY-LICENSES.md).
4. Add the package to the FOSSA policy exception list in the dashboard.
5. Update this document with the new entry in the table above.

---

## Unknown / Unrecognized Licenses

Any dependency whose license cannot be automatically identified by FOSSA
**must be flagged for manual review**. Unknown licenses must never be silently
passed.

The FOSSA policy should be configured as follows for unknown licenses:

- **Action:** Flag as policy violation (fail the check)
- **Resolution:** A human reviewer must inspect the license text, determine
  compatibility, and either:
  - Add the license to the allowed list (if permissive and compatible), or
  - Add the package to the exceptions table above (if proprietary but approved), or
  - Deny the dependency and find an alternative

This ensures no dependency with an ambiguous or missing license enters
production without explicit review.

---

## Dashboard Setup Steps

The following steps must be performed by a team member with FOSSA dashboard
access and the `FOSSA_API_KEY`. This is a manual, one-time configuration
(with updates as the policy evolves).

### Prerequisites

- FOSSA account with admin or policy-management permissions
- `FOSSA_API_KEY` (available in FOSSA under **Account Settings > API Tokens**)
- The AgentFactory project must already be imported into FOSSA

### Steps

1. **Log in** to the FOSSA dashboard at [https://app.fossa.com](https://app.fossa.com).

2. **Navigate to Policies** via the left sidebar: **Policies > Manage Policies**.

3. **Create a new policy** (or edit the existing default policy):
   - Name: `AgentFactory License Policy`
   - Description: `License policy for the AgentFactory monorepo. Source of truth: docs/license-policy.md`

4. **Add Allowed Licenses:**
   - Add each license from the [Allowed Licenses](#allowed-licenses) table above
     with the action set to **Approve**.

5. **Add Denied Licenses:**
   - Add each license from the [Denied Licenses](#denied-licenses) tables above
     with the action set to **Deny** (flag as policy violation).

6. **Configure Unknown License Handling:**
   - Under the policy's default/fallback rule, set unknown or unrecognized
     licenses to **Flag for Review** (do **not** set to auto-approve).

7. **Add Package Exceptions:**
   - Navigate to the project's issue list or the policy's package-level
     overrides.
   - For `@anthropic-ai/claude-agent-sdk`, mark the issue as **Approved**
     with the note: `Proprietary, pre-approved per SUP-1227. See THIRD-PARTY-LICENSES.md.`

8. **Assign the Policy:**
   - Go to **Projects > AgentFactory** and assign the
     `AgentFactory License Policy` to the project.

9. **Verify:**
   - Trigger a new FOSSA scan (or wait for the next CI run).
   - Confirm that the policy check passes with the current dependency set.
   - Confirm that denied licenses would correctly fail the check by
     temporarily adding a test dependency (then reverting).

---

## Related Files

| File | Purpose |
|---|---|
| [`.license-allowlist`](../.license-allowlist) | Semicolon-separated list of allowed SPDX identifiers used by the local `license-checker` CI step. |
| [`THIRD-PARTY-LICENSES.md`](../THIRD-PARTY-LICENSES.md) | Detailed review records for dependencies that fall outside the standard OSS allowlist. |
| [`.fossa.yml`](../.fossa.yml) | FOSSA CLI configuration (if present) for scan settings and project mapping. |
