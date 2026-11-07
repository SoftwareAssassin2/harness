---
name: install
description: >-
  Set up this harness on a Mac and install a project preset bundle (a .tar.gz
  from ./harness.sh export-project) a teammate gave you: checks the
  prerequisites, asks for the bundle, the project's checkout folder and the Lima
  folder, runs ./harness.sh install-project, then walks through the
  credentials, the glab and gcloud logins, Lima and the golden VM image,
  Hindsight memory, and how to start the harness. Use when someone runs
  /install or asks to set up, install or onboard the harness or a project
  bundle.
---

# /install — set up the harness and install a project bundle

You are taking a person from a fresh clone of this repo to a project the
harness loads (ASS-275). Work from the repo's root folder. Go step by step,
say what each step is for, and check its result before the next.

Ground rules:

- **Never ask for, read, print or echo a secret value.** The person puts each
  token in the keychain themselves; you only ever learn a keychain item's
  *service name*. Never run `pbpaste`, `security find-generic-password -w`, or
  anything that prints a token. To check an item exists, run
  `security find-generic-password -s "<service>" >/dev/null 2>&1 && echo found`
  (no `-w`).
- **Use the bash commands, don't hand-edit JSON.** `./harness.sh
  install-project` does the file work. The only JSON you change yourself is
  filling the placeholders it leaves (step 6), with the `jq` commands below.
- Don't touch other projects in `data/projects/` or other entries in
  `~/.harness/vm-credentials.json`.
- If a step can't be finished, say plainly which step is left, why, and the
  command that finishes it later. Then go on with whatever doesn't depend on
  it.

## 1. Prerequisites

Check each and list what's missing, with how to install it. Install with
Homebrew (`brew install …`) only after the person agrees.

| Tool | Check | Install |
|---|---|---|
| Node.js (current LTS) | `node --version` | `brew install node` |
| jq | `jq --version` | `brew install jq` |
| git | `git --version` | `xcode-select --install` or `brew install git` |
| Lima | `limactl --version` | `brew install lima` |
| Python 3.11+ | `python3 -c 'import sys; print(sys.version)'` | `brew install python@3.12` |
| glab | `glab --version` | `brew install glab` |
| gcloud | `gcloud --version` | `brew install --cask google-cloud-sdk` |
| Claude Code | `claude --version` | https://claude.com/claude-code |

glab and gcloud matter only if the project uses them (the install's remaining
steps will say: a `glab-login` or `gcloud-login` step). Python is checked again
in step 8. Run `npm install` if `node_modules/` is missing.

## 2. The bundle

Ask for the path of the preset bundle (`<project>-preset.tar.gz`). Check the
file exists. Peek at its manifest without unpacking it anywhere:

```sh
tar -xzOf "<bundle>" manifest.json | jq '{format, project, "state-engines", setup: [.setup[].step]}'
```

`format` must be `1`. Note the project name: it is `<project>` from here on.

## 3. The project's root folder

Ask where the person's checkout of the project's code is. It must be an
existing folder that is the top of a git checkout:

```sh
git -C "<folder>" rev-parse --show-toplevel
```

The output must be that same folder. If it isn't cloned yet, help them clone
it first (the repositories are listed in the bundle's `project.json`:
`tar -xzOf "<bundle>" project.json | jq '.repositories'`).

## 4. The Lima folder

Every VM lives in one Lima folder (default `~/.lima`). Golden images and
ticket VMs need room: `vm-disk-limit-gb` in `data/harness.json` (120 by
default):

```sh
jq '.["vm-disk-limit-gb"] // 120' data/harness.json
```

Ask which folder to use (an external SSD is fine). Show how much is free where
it is, or on its nearest existing parent:

```sh
df -g "<folder or its parent>" | awk 'NR==2 {print $4 " GB free"}'
```

If it's less than the limit, say so and let them pick another folder or go on
knowingly. Use an absolute path (expand `~` yourself): `lima-home` is never
`~`-expanded. The install writes it to `data/harness.local.json`, this
machine's own untracked settings, so the tracked `data/harness.json` stays
unchanged.

## 5. Run the install

```sh
./harness.sh install-project "<bundle>" --project-root "<project root>" --lima-home "<Lima folder>"
```

If it says the project is already installed, ask before rerunning with
`--force`. `--force` overwrites `data/projects/<project>/project.json`, the
golden image and the project's engines. It also replaces the project's
credentials entry with the bundle's placeholders, so the keychain service
names they filled in before are lost. Any other failure changes nothing: fix
what it names and run it again.

It prints the **remaining setup steps** (from the bundle's manifest, in
order) and the **placeholders still to fill**. Keep that list. Steps 6–9 work
through it.

## 6. Credentials

The install wrote the project's entry in `~/.harness/vm-credentials.json` with
placeholders such as `{gitlab-keychain-service}`, `{git-user-name}`,
`{git-user-email}` and `{atlassian-email}` (the format is documented in
`src/agent-cli/vm-credentials.bash`). See what's there:

```sh
jq --arg p "<project>" '.[$p]' ~/.harness/vm-credentials.json
```

**Each keychain item** (a `{<kind>-keychain-service}` placeholder): agree on a
service name with the person, e.g. `GitLab PAT (<project>)`. Tell them where to
get the token (GitLab: a personal access token with `api`, `read_registry`;
Atlassian: an API token from id.atlassian.com; claude: `claude setup-token`;
anthropic: a Console API key; GitHub: a fine-grained PAT). Have them copy the
token to the clipboard and run this **themselves**, at the Claude Code prompt
with the `!` prefix, so the token never passes through you:

```
! security add-generic-password -s "<service>" -a "$USER" -T /usr/bin/security -w "$(pbpaste)"
```

(`-T /usr/bin/security` lets only `security` read it without a prompt.
Pasting avoids the 128-character limit on typed input. If an item with that
service already exists, they add `-U` to update it.) Check the item exists
with the no-`-w` check above. Then fill the placeholder with the service name.

**Each other placeholder** (git user name and email, Atlassian email): ask
the person and fill it in.

Fill one placeholder with this command. It backs the file up first and
changes only the project's entry:

```sh
f=~/.harness/vm-credentials.json; cp -p "$f" "$f.backup-$(date -u +%Y%m%dT%H%M%SZ)" \
  && jq --arg p "<project>" --arg ph "<placeholder, braces included>" --arg v "<value>" \
       '.[$p] |= walk(if . == $ph then $v else . end)' "$f" > "$f.new" \
  && chmod 600 "$f.new" && mv "$f.new" "$f"
```

When you're done, no `{…}` placeholder may be left in the entry:

```sh
jq -r --arg p "<project>" '.[$p] | .. | strings | select(test("^\\{.*\\}$"))' ~/.harness/vm-credentials.json
```

**Logins**: for a `glab-login` step have the person run `! glab auth login`,
and for a `gcloud-login` step `! gcloud auth login`. These are interactive
and need their browser. Check with `glab auth status` / `gcloud auth list`.

## 7. Lima and the golden VM image

Golden images use Lima's `vz` driver (Apple's Virtualization framework), not
VMware or QEMU. Check:

- Apple Silicon: `uname -m` prints `arm64`. On Intel, stop here and say the VMs
  can't run.
- macOS 13 (Ventura) or newer, the oldest Lima's `vz` supports:
  `sw_vers -productVersion`.
- limactl installed (step 1), and `limactl --version` is 1.0 or newer. If it's
  older, offer `brew upgrade lima`.
- Smoke test in the chosen folder: `LIMA_HOME="<Lima folder>" limactl list`
  (an empty list is fine. An error is not).
- The free space from step 4.

If the steps include `registry-up`, run it first. Pulling images for the
golden image goes through it, and it needs the gcloud login when the project's
registry has an upstream:

```sh
./agent.sh registry:up <project>
```

Then offer to build the golden image. It takes a long while (tens of
minutes), so run it in the background and wait for it to finish:

```sh
./agent.sh vm:build-golden <project>
```

If it fails, read its output, say which step failed and why, and whether a
rerun is worth it (it reuses what's unchanged).

## 8. Hindsight memory

Each project has its own Hindsight memory server (`memory:up`).

- Python: `python3 -c 'import sys; sys.exit(sys.version_info < (3, 11))' && echo ok`.
  If it isn't 3.11+, suggest `brew install python@3.12`, and make sure
  `python3` on the PATH is that one (`/opt/homebrew/opt/python@3.12/libexec/bin`
  first in PATH).
- Its LLM key: if the steps include a `keychain-item` for `hindsight`, ask
  whether they have an Anthropic API key for it. If they do, they create the
  item as in step 6 (e.g. service `Hindsight Key (<project>)`). Check it
  exists, then set its service name:

  ```sh
  f=data/projects/<project>/project.json; jq --arg s "<service>" '.hindsight["llm-api-key-keychain-service"] = $s' "$f" > "$f.new" && mv "$f.new" "$f"
  ```

  Without a key, Hindsight runs with provider `none`: recall works, reflect
  doesn't. Say so and leave it unset.
- Start it. The first start installs the pinned hindsight-api into its
  virtualenv and downloads its models, which can take up to about 5 minutes:

  ```sh
  ./agent.sh memory:up <project>
  ```

  Then check it answers on the project's port:

  ```sh
  curl -fs "http://127.0.0.1:$(jq -r .hindsight.port data/projects/<project>/project.json)/health" && echo answering
  ```

## 9. Finish

Sum up what's done and what isn't. For each step left, give the step, why
it's left, and the command to finish it. Then tell them how to start the
harness.

If this session was started by `./harness.sh tui` (it runs `/install` first
when no project is installed, ASS-290), `echo "$HARNESS_INSTALL_FROM_TUI"`
prints `1`. Then don't tell them to run it again:
tell them to quit Claude Code (`/exit` or Ctrl-D) and the dashboard starts on
its own. If no project got installed, it asks whether to start the dashboard
anyway. Otherwise, they start it with:

```sh
./harness.sh tui
```

The TUI starts control and the downloader, and the project shows up in it.
