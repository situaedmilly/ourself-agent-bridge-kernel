# M4 execution trigger

Controlled PR-triggered execution marker.

This file exists solely to create a new push event on the M4 branch so the bounded CI workflows execute through their declared `push` trigger.

Boundary:
- CI runner execution only.
- No target-machine residence claim.
- No capability expansion.
- No launchd.
- No arbitrary shell authority.
