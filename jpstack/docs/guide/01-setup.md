# Set up jpstack

In this page you install jpstack, pick which models jpstack uses, and run your first task. Setup is one command plus a short conversation.

## Install jpstack

jpstack ships inside jp-skills. The `jp-upgrading-jp-skills` skill installs and updates it with the rest of jp-skills, so there is no separate plugin to add.

The [harness map](../harness.md) covers how your harness runs each command in this guide, where jpstack keeps its state, and what replaces each upstream companion skill.

## Pick your models

Run:

```text
/setup-jpstack
```

[`/setup-jpstack`](../../skills/setup-jpstack/SKILL.md) detects the models you have access to, asks for a reasoning budget, shows you each role (code delegates, judgment, the review panels), and asks what you want. Answer the questions. It writes `<home>/jpstack/models.md` ([storage](../harness.md#storage)), a small file every jpstack skill reads.

The defaults are the same as the `large` budget. Code, prose, and judgment run on Opus 5.5 at `xhigh` reasoning, and the review panels and swarm workers run at `high`. No role runs above `xhigh`. Outside a review panel, Fable 5.2 runs only when you name it for a task or after two Opus 5.5 runs of the same brief fail their check. `medium` lowers each role one level and `small` lowers it two, and both spend fewer tokens.

You only override what you care about. A role with no line in the file keeps the skill's default. To restore a default, delete that role's line. A rerun of `/setup-jpstack` keeps any role whose model differs from the default. When a default changes, a file written before the change still pins the old default until you run `/setup-jpstack` again. That run replaces the old defaults it recognizes, tells you which, and keeps your other choices. To drop a pin it does not recognize, delete that role's line or the file first.

You might be wondering what happens if you use Auto. Set a role to `inherit-parent` or `auto` and jpstack omits the subagent `model` field, so the subagent inherits your parent chat model. Both values mean the same thing, and neither is a model slug. For a panel role the value is a list, and one subagent runs per entry, so the list length sets the panel size. Setup also configures `swarm workers`, the default model for every `/swarm` worker unless a race names a model for each arm.

## Accept the verification offers, or don't

At the end of setup, `/setup-jpstack` looks for a way to prove app behavior in your project, either a `verify-*` skill or an existing harness. If it finds neither, it offers once to generate one with [`/create-verification-skill`](../../skills/create-verification-skill/SKILL.md).

Say yes and it writes `verify-<app>/` in the project skills folder ([storage](../harness.md#storage)), a project-local skill that teaches agents to drive your app the way a user does. It proves the skill works once before handing it over. Say no and setup moves on. You can run `/create-verification-skill` yourself any time. [Verify and ship](./06-verify-and-ship.md#create-a-project-verification-skill) covers it in depth.

If you're new to jpstack, say yes. An agent that can check its own work keeps going until the check passes. An agent that can't hands every result back to you to check by hand. Of everything in this guide, the verification skill pays off the most.

Then setup offers once to generate a formal verification skill with [`/create-formal-verification-skill`](../../skills/create-formal-verification-skill/SKILL.md), unless the project already has one. Tests check the cases someone thought to write. A formal verification skill checks one key property of your code, such as "a job never runs twice at once", in every case within a stated scope. Say yes when your code has concurrency, retries, a state machine, or a parser, where a bug is costly and tests rarely reach the case that breaks. Otherwise say no, and run it later if that changes. [Verify and ship](./06-verify-and-ship.md#prove-a-property-with-a-formal-verification-skill) covers it.

After setup, start a new chat. The model rule applies to new sessions.

## Keep the cost in check

jpstack spends extra tokens on subagents and review panels. That's the price of the rigor. To spend fewer:

- Rerun `/setup-jpstack` and pick a smaller reasoning budget or cheaper models. A strong model in the main chat with cheaper, faster models in the code roles is a good split.
- Set a role to `auto` or `inherit-parent` so it runs on the chat's own model.
- Shorten a panel list. Each entry runs one subagent.
- Save `/poteto-mode` for work that needs rigor. A small, obvious edit doesn't.

## Run your first task

Pick something real but small, and describe it the way you'd describe it to a colleague:

```text
/poteto-mode add a --json flag to this command. text output stays byte-identical. verify both.
```

Watch the todo list. Its first items are the matched playbook's steps copied in, the Feature playbook for this prompt.

From here you can type normal follow-ups. Start a new multi-step task with `/poteto-mode` again. A skill attached to one message fades as the chat moves on.

Next: [Route work through `/poteto-mode`](./02-poteto-mode.md).
