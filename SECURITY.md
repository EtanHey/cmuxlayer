# Security Policy

## Supported Versions

Only the `main` branch is currently receiving security updates for the Secure Mode tunnel features.

| Version | Supported          |
| ------- | ------------------ |
| main    | :white_check_mark: |
| < 0.2.x | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability within ChatGPTMCPcmux, particularly regarding the **Secure Mode Policy Engine**, **Command Filter**, or **Secret Redactor**, please DO NOT create a public issue.

Please report it directly via GitHub Security Advisories or by emailing [maintainer email/contact if known, otherwise: open a private security advisory on GitHub].

## Scope of Secure Mode

The ChatGPTMCPcmux secure mode is designed as a **defense-in-depth** layer for executing a curated set of tools from the upstream `cmuxlayer` surface over the OpenAI Secure MCP Tunnel.
Vulnerabilities where a remote agent can bypass the explicitly allowed `tools.allow` policy, circumvent `require_confirmation`, or escape the `project.root` directory bounds are considered in scope.
