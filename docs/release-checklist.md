# Release Checklist

Before releasing a new version of ChatGPTMCPcmux, follow this checklist to ensure stability and security.

## 1. Security & Policy Verification
- [ ] Run `npm run test` to verify `tests/security/server-exposure.test.ts` passes (27 tools exposed).
- [ ] Verify `config/policy.example.yaml` has not been accidentally weakened.
- [ ] Ensure no `console.log` statements have been introduced into the secure mode pathways.

## 2. Documentation
- [ ] Update `README.md` with any new tools or changes.
- [ ] Update `docs/chatgpt-connector.md` if the OpenAI tunnel or ChatGPT connection flow has changed.
- [ ] Verify the "Known Limitations" section is accurate.

## 3. Build & Test
- [ ] Ensure the project builds successfully: `npm install && npm run build`
- [ ] Typecheck passes: `npm run typecheck`
- [ ] All unit tests pass: `npm run test`

## 4. Release execution
- [ ] Bump version in `package.json`.
- [ ] Create a release commit `chore: bump version to X.Y.Z`.
- [ ] Tag the release `vX.Y.Z` and push to GitHub.
- [ ] Draft a new GitHub Release with changelog notes.
