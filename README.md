# task-progress

A Claude Code mod that puts a thin progress bar above the prompt, so you can see how far Claude is through what you asked.

- Claude moves the bar itself in small steps (+0.2, +1, +3, +5…) as it works, and finishing a step on its task list moves it up too.
- Under the bar: an ETA countdown on the left that Claude sets and revises, and the current step's name on the right.
- When the work is done the bar fills and says **Finished**. It clears when you send your next message.

Nothing to configure: once installed, Claude sees the progress tool on its own and uses it.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install task-progress --marketplace UmidSamedzade/task-progress
```

Answer `y` to add the marketplace, then press Enter to pick the user scope.

From a shell:

```bash
claude plugin install task-progress --marketplace UmidSamedzade/task-progress
```

In the Claude desktop app, where `/plugin` doesn't run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `UmidSamedzade/task-progress`, then **Add plugin**.

Installed at the user scope from a terminal, it also shows in the desktop app's Code tab.
