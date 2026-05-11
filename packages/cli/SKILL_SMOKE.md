# Skill activation smoke log

## TODO: captain to verify

This file documents manual Claude Code skill activation verification. Steps:

1. Build and install a local copy of `pact` so the smoke run exercises the
   actual compiled binary (not `bun run src/index.ts`). pnpm's
   `link --global` is unreliable in our workspace setup — recursive
   `--filter` rejects `--global`, and the in-package form fails with
   `ERR_PNPM_NO_GLOBAL_BIN_DIR` unless `pnpm setup` has been run first.
   Use a symlink instead:

   ```bash
   pnpm --filter @q3labs/pact-cli build         # produces dist/pact (compiled)
   ln -sf "$PWD/packages/cli/dist/pact" /usr/local/bin/pact   # or any dir on $PATH
   pact --version                               # confirm
   ```

   Re-running `pnpm --filter @q3labs/pact-cli build` is enough to pick up
   source changes; the symlink keeps pointing at the freshly rebuilt
   binary. The published install path (`pnpm add -g @q3labs/pact-cli`) is
   unaffected — only this local-build smoke flow needs the workaround.
2. In a fresh directory: `pact init` — verify `.claude/skills/pact/SKILL.md` and `CLAUDE.md` created.
3. Open Claude Code in that directory.
4. Ask: "What's the SOL balance of 7g3xy at devnet?"
   - Expected: Claude picks the `pact` skill (helius/mainnet.helius-rpc.com in allowlist), runs `pact --json https://...`, parses `.body`.
5. Ask Claude to fetch `https://jsonplaceholder.typicode.com/todos/1`
   - Expected: Claude does NOT use `pact` — uses WebFetch or curl directly.

## Log entries

| Date | Claude version | Helius activated | Birdeye activated | jsonplaceholder skipped | localhost skipped | Notes |
|------|---------------|-----------------|-------------------|------------------------|-------------------|-------|
| TODO | TODO          | TODO            | TODO              | TODO                   | TODO              | First verification pending |
