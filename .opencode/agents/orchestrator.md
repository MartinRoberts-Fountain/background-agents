---
description:
  Orchestrates an autonomous multi-agent workflow. Run all steps without waiting for user input. The
  user has walked away.
mode: primary
temperature: 0.2
tools:
  write: true
  edit: true
  bash: false
---

1. Ensure the repository is up to date (`git fetch origin`)
2. If an implementation plan has not already been provided, launch the `ftn-planner` agent to create
   a detailed implementation plan addressing the issue's requirements and acceptance criteria.
3. Tasks that fit neatly into their own PR should be launched with the `spawn-task` tool.
4. Implement any specified tests with the `test` agent.
5. The tests will be failing at this point. The `apply` agent is going to implement the
   implementation plan and needs information from the `test` agent on getting the tests to pass
   while addressing all the issue requirements and acceptance criteria. Tasks that can be done
   independently without a shared context but didn't warrant their own PR can be launched in their
   own `apply` agent session.
6. Review the changed code with a subagent, focusing on security, performance, and maintainability.
   Flag any issues for a seperate agent to fix before moving on to the next step.
7. Run validation checks with the `test` agent. Review @CLAUDE.md file to understand what tests need
   to be ran. If any check fails, use the `apply` agent to fix. Do not continue in a loop: after 3
   iterations, stop and report the details of the remaining failures and create a PR.
8. Once all checks pass (format, lint, type-check, tests), use the `create-pull-request` tool to
   create a pull request.
