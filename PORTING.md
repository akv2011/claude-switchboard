# Porting a change into this repository

This repository is the generalized, public form of a private working copy. Changes are made there first, then ported here by hand. Never copy files over wholesale: the private copy names real machines, people and projects.

## Steps

1. Take the change as a diff of the private commit: `git -C <private> show <commit> -- src test`.
2. Apply it by hand. Rename on the way:
   - the second machine is `remote` (config `remote.label` for display), never a machine name;
   - the private machine CLI's moves, attaches and starts are `src/core/remote.js` functions;
   - personal notifiers become `notifyArgs()` in `src/recorder/daemon.js`;
   - hard-coded folders become `readConfig().projectsRoots` or `remote.localProjectsRoot`.
3. Rewrite comments that cite a dated personal incident as the general technical reason.
4. Replace test fixtures that use real chat, project or account names with invented ones that keep the same structure (casing, separators, counts).
5. Run the scrub below and `npm test`. Both must be clean before committing.

## Scrub

Search case-insensitively for:
- people and handles: the owner's names, usernames and GitHub handle;
- machines: the second machine's model, hostname, IP range (`192.168.`) and `.local` name;
- real project, chat and account names, and organization names;
- `@gmail`, real email domains, and home paths (`/Users/<name>`; `/Users/you` is the neutral placeholder);
- personal tooling: private notifier scripts, private CLIs, drive names.

```sh
rg -i -n '<one term|another term|...>' --hidden -g '!.git' -g '!bun.lock' .
```

An empty result is the bar. Keep the term list next to the private copy, not in this repository, since the list itself names what it removes.
