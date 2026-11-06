# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It is built on an **everything-is-a-plugin** architecture and powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512).

Documentation: [https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## Developer preview

DeepSeek Harness is in _developer preview_ and iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

Review the [safety notice](SAFETY.md) before running the project.

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run Antfarm from a Linux repository checkout:

```sh
pnpm install
pnpm run build
```

Before the first startup, choose a persistent data home and provision a team account while the service is stopped. The maintenance command prompts for a password without displaying it and rejects existing usernames:

```sh
export DSH_HOME="$HOME/.antfarm"
pnpm exec tsx scripts/multiuser-provision.ts --storage-root "$DSH_HOME/storages" --username alice
pnpm run start:web --no-open
```

Open `http://127.0.0.1:3080/` and sign in with that account. Antfarm's `start:web` and `dev:web` commands load account login, workspace upload, file listing and download by default; the URL needs no launch token. Restarts reuse the same `DSH_HOME` without provisioning again. Workspaces default to `$DSH_HOME/workspaces`; set `DSH_MULTIUSER_WORKSPACE_ROOT` to an absolute path to select a deployment root. `start:web` reuses built Web artifacts; `dev:web` builds before serving. The underlying `pnpm dsh web` command keeps the upstream profile defaults.

Agent tool execution remains unavailable until the sandbox Bash integration is complete. Optional sandbox management uses the [deployment guide](docs/user/guide/workspace-sandboxes.md).

## Community and support

- Submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/4MrtZUhpxg">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

`pnpm run dev:web` builds, serves, and rebuilds client bundles on source edits in one terminal, and `make help` lists the matching Make targets for Web and Desktop; the guide's application commands section owns the full table.

For agents, follow [AGENTS.md](AGENTS.md).

## Citation

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
