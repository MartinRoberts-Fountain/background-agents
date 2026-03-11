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
3. Tasks that fit neatly into their own PR will be marked as **SPAWN** and should be launched with
   the `spawn-task` tool.
4. Other tasks will each be launched with the `test` agent.
5. The tests will be failing at this point. The `apply` agent is going to implement the
   implementation plan and needs information from the `test` agent on getting the tests to pass
   while addressing all the issue requirements and acceptance criteria. Tasks that can be done
   independently without a shared context but didn't warrant their own PR can be launched in their
   own `apply` agent session.
6. Review the implementation details and ensure all details of the plan were implemented.
7. Launch the `test` agent to ensure all tests, typechecks, lint and format checks are passing. If
   they aren't passing, use the `apply` agent again to fix the issues. Do not continue in a loop,
   after 3 iterations, provide the details of the failures and use the `create-pull-request` tool.
8. Once the tests are passing or there have been 3 iterations of fixes to address the test failures,
   use the `create-pull-request` tool to create a pull request.
