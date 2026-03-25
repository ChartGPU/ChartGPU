# Product Guardrails
<!-- What this project values. The agent uses these to make judgment calls. -->
- Example: Privacy by default
- Example: Simplicity over features

# Risk Classification
<!-- Override or extend the default risk rules. -->
## Always High Risk
- Changes to authentication or authorization
- Modifications to the release pipeline
- Database migration changes

## Always Low Risk
- Documentation-only changes
- Test-only changes

# Decision Rules
## Bugs
- Fix if reproducible or obvious from code inspection
- Close as duplicate if an existing issue covers it

## Features
- Accept if it benefits most users
- Decline if it adds disproportionate complexity
- Escalate to human if ambiguous

## External PRs
- The idea matters, the exact code doesn't
- OK to reimplement rather than iterate on the PR

# Repo-Specific Rules
<!-- Anything unique to this project. -->
- Example: Treat changes to the billing module as risk:high
